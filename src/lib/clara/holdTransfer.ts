// Clara — putting a work-line caller through to the owner by text (2026-09-29).
//
// The owner's choice: an urgent caller (workLine.triageUrgency) or someone on their always-put-through list
// is parked on hold with the owner's own audio while Clara texts the owner's personal cell who it is and what the caller
// needs. The owner replies "1" and their cell rings; the moment it answers a person, the two are bridged. They
// reply "2", or nothing within the timeout, and the caller comes back to Clara for a message. The owner's
// voicemail can never take the call: the leg to them uses answering-machine detection, and a leg that
// reaches a machine is hung up with the caller still safely parked.
//
// How the pieces fit (Twilio):
//   caller leg   <Enqueue name="hold-{CallSid}" waitUrl=hold/wait action=hold/done>
//                  wait  — plays the hold audio; each replay checks the hold is still live, else <Leave/>
//                  done  — the caller left the queue: bridged (call over), leave/hangup, or redirected away
//   The owner's leg   REST call to their cell with url=hold/answer and machine detection
//                  answer — human → "Connecting you to X now" then <Dial><Queue>hold-{CallSid}</Queue></Dial>
//                           machine → <Hangup/> and the caller is redirected back to Clara
//                           unknown → "press any key" (whisperTwiml); no key → hangs up, caller comes back
//                  bridged (Queue url, runs on the CALLER leg just before bridging) — records the connect
//                  owner-done / owner-status — the owner's leg ended; if it never bridged, the caller comes back
//   return       REST redirect of the caller leg to hold/return: the neutral line, then the normal
//                <Gather> into the voice route, so the conversation resumes with its state intact.
//
// One live hold at a time. The timer is the primary timeout; the wait route is the backstop, so a
// process restart mid-hold still ends the hold on the next replay (the caller is parked inside
// Twilio, not in this process). Everything that decides is pure and exported for tests.

import { OWNER_FIRST } from "./owner";
import type { InboundCallState, TransferOutcome } from "./call-sessions";
import { esc } from "./channels";
import { whoLabel } from "./workLine";

export const HOLD_TIMEOUT_SEC_DEFAULT = 45;
/** A "1"/"2" this long after the deadline still counts, so a reply that crosses the timeout isn't lost. */
export const HOLD_REPLY_GRACE_MS = 30_000;
/** Twilio's own public hold music; what plays until the owner drops their file in place. */
export const TWILIO_DEFAULT_HOLD_MUSIC = "http://com.twilio.music.classical.s3.amazonaws.com/BusyStrings.mp3";
export const HOLD_PATH = "/api/channels/twilio/voice/hold";
export const HOLD_AUDIO_PATH = "/api/channels/twilio/hold-audio";

export type HoldState = "waiting" | "accepted" | "bridged" | "returned" | "caller-left";

export interface HoldRecord {
  callSid: string;
  from: string;
  queueName: string;
  who: string;
  need?: string;
  vip: boolean;
  /** Public base the caller's webhooks came in on — the REST URLs must use the same one. */
  base: string;
  textedAt: number;
  deadlineAt: number;
  state: HoldState;
  outcome?: TransferOutcome;
  ownerCallSid?: string;
  timer?: ReturnType<typeof setTimeout>;
}

// ── Pure ────────────────────────────────────────────────────────────────────────────────────────

export function holdTimeoutMs(env: Record<string, string | undefined> = process.env): number {
  const v = Number(env.CLARA_HOLD_TIMEOUT_SEC ?? "");
  return (Number.isFinite(v) && v >= 15 ? Math.min(v, 180) : HOLD_TIMEOUT_SEC_DEFAULT) * 1000;
}

export function queueNameFor(callSid: string): string {
  return `hold-${callSid}`.slice(0, 64);
}

/** The text the owner gets on their cell. Plain words, the handle, and the two answers. */
export function holdText(h: Pick<HoldRecord, "who" | "need" | "vip">, opts: { urgent?: boolean } = {}): string {
  const handle = h.who.replace(/\s*\(.*\)$/, "").split(/\s+/)[0] || h.who;
  const about = h.vip && !h.need
    ? `${h.who} (always put through)`
    : `${h.who}${h.need ? ` — needs: ${h.need.replace(/\s+/g, " ").trim().slice(0, 160)}` : ""}${opts.urgent ? ", says urgent" : ""}`;
  return `Work call holding: ${about}. Reply 1 to take it, 2 to pass. (re: ${handle}) — Clara`;
}

export type HoldReply = "take" | "pass";

/** "1"/"take it"/"yes" → take; "2"/"pass"/"no" → pass; anything else isn't an answer to this. */
export function parseHoldReply(text: string): HoldReply | null {
  const t = text.trim().toLowerCase().replace(/[.!]+$/, "");
  if (/^(1|one|take( it| the call)?|yes|y|yeah|yep|put (them|him|her) through|connect)$/.test(t)) return "take";
  if (/^(2|two|pass|no|n|nope|can'?t|not now|take a message|message)$/.test(t)) return "pass";
  return null;
}

export function holdExpired(h: Pick<HoldRecord, "deadlineAt">, now: number, graceMs = 0): boolean {
  return now > h.deadlineAt + graceMs;
}

export type AnsweredBy = "human" | "machine" | "unknown";

/** Twilio's AnsweredBy → what to do with the owner's leg. Fail towards "unknown": a key press decides. */
export function classifyAnsweredBy(v: string | undefined): AnsweredBy {
  const a = String(v ?? "").toLowerCase();
  if (a === "human") return "human";
  if (a.startsWith("machine") || a === "fax") return "machine";
  return "unknown";
}

/** Twilio's QueueResult on the caller's <Enqueue> action. */
export type QueueResult = "bridged" | "leave" | "hangup" | "redirected" | "error" | "queue-full" | "system-error" | "bridging-in-process" | "other";

export function classifyQueueResult(v: string | undefined): QueueResult {
  const q = String(v ?? "").toLowerCase();
  return (["bridged", "leave", "hangup", "redirected", "error", "queue-full", "system-error", "bridging-in-process"] as const).find((x) => x === q) ?? "other";
}

/** What a caller hears when the owner didn't take it — the same line whatever the reason. */
export function returnLine(): string {
  return `Sorry — ${OWNER_FIRST} can't break away just now. I'll make sure they get this right away. Is there anything else you want me to pass along, or a better time for them to call you back?`;
}

/** Which hold audio to <Play>: the owner's URL, their file through Clara, or Twilio's sample. */
export function holdAudioUrl(base: string, env: Record<string, string | undefined>, hasFile: boolean): string {
  const url = env.CLARA_HOLD_AUDIO_URL?.trim();
  if (url && /^https?:\/\//i.test(url)) return url;
  return hasFile ? `${base}${HOLD_AUDIO_PATH}` : TWILIO_DEFAULT_HOLD_MUSIC;
}

export function waitTwiml(audioUrl: string): string {
  return `<Response><Play>${esc(audioUrl)}</Play></Response>`;
}

export function leaveTwiml(): string {
  return `<Response><Leave/></Response>`;
}

/** The owner's leg, once a person answered: a short whisper, then dequeue the caller into this call. */
export function ownerAnswerTwiml(opts: { sayXml: string; queueName: string; bridgedUrl: string; actionUrl: string }): string {
  return `<Response>${opts.sayXml}` +
    `<Dial action="${esc(opts.actionUrl)}" method="POST"><Queue url="${esc(opts.bridgedUrl)}" method="POST">${esc(opts.queueName)}</Queue></Dial>` +
    `</Response>`;
}

export function ownerWhisperLine(h: Pick<HoldRecord, "who">): string {
  return `Connecting you to ${h.who.replace(/\s*\((.*)\)$/, " from $1")} now.`;
}

/**
 * The confirmation whisper the owner hears when their cell picks up a VIP ring (2026-10-02 owner rule
 * "warm transfer right away" — the text wait is gone). Says who's calling and the two options.
 */
export function ownerConfirmWhisperLine(h: Pick<HoldRecord, "who" | "need">): string {
  const who = h.who.replace(/\s*\((.*)\)$/, " from $1");
  const need = h.need ? ` about ${h.need}` : "";
  return `${who}${need} is on hold for you. Press 1 to take it, 2 to pass.`;
}

// ── Store ───────────────────────────────────────────────────────────────────────────────────────

const KEY = "__clara_hold_transfers__";
function holds(): Map<string, HoldRecord> {
  const g = globalThis as unknown as Record<string, Map<string, HoldRecord> | undefined>;
  if (!g[KEY]) g[KEY] = new Map();
  return g[KEY]!;
}

export function holdFor(callSid: string): HoldRecord | null {
  return holds().get(callSid) ?? null;
}

/** The one hold the owner can still answer: waiting for their reply, or their cell ringing after a "1". */
export function liveHold(): HoldRecord | null {
  for (const h of holds().values()) if (h.state === "waiting" || h.state === "accepted") return h;
  return null;
}

function clearTimer(h: HoldRecord): void {
  if (h.timer) clearTimeout(h.timer);
  h.timer = undefined;
}

/** Forget a hold once its call is over: timer off, queue deleted. Never throws. */
export async function finishHold(callSid: string): Promise<void> {
  const h = holds().get(callSid);
  if (!h) return;
  clearTimer(h);
  holds().delete(callSid);
  const { deleteQueueByName } = await import("./channels");
  await deleteQueueByName(h.queueName).catch(() => false);
}

/** Test hook: drop every hold without touching Twilio. */
export function resetHolds(): void {
  for (const h of holds().values()) clearTimer(h);
  holds().clear();
}

// ── Effects ─────────────────────────────────────────────────────────────────────────────────────

export interface HoldDeps {
  /** Text the owner's personal cell from Clara's number (no quiet hours: someone is on the line). */
  textOwner: (text: string) => Promise<boolean>;
  /** Ring the owner's cell with answering-machine detection; resolves with their leg's CallSid. */
  ringOwner: (h: HoldRecord) => Promise<{ ok: boolean; sid?: string; error?: string }>;
  /** Move the caller's live leg to new TwiML. */
  redirect: (callSid: string, url: string) => Promise<{ ok: boolean; error?: string }>;
  /** The transfer's outcome, onto the call session (call-sessions.ts). */
  patchSession: (callSid: string, patch: Partial<Pick<InboundCallState, "transferTried" | "transferAccepted" | "transferOutcome">>) => void;
  log: (what: string, callSid: string, meta?: Record<string, unknown>) => Promise<void>;
  now: () => number;
  setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
}

async function defaultDeps(): Promise<HoldDeps> {
  const [{ sendSMS, placeCall, redirectCall }, { transferTarget }, { patchInboundSession }, { append }, { appendMessage }] = await Promise.all([
    import("./channels"), import("./ownerPhones"), import("./call-sessions"), import("./ledger"), import("./messages"),
  ]);
  return {
    textOwner: async (text) => {
      const to = transferTarget();
      if (!to) return false;
      const r = await sendSMS(to, text).catch(() => ({ ok: false }));
      // Straight through sendSMS, not textOwnerImportant: that path holds texts for quiet hours and
      // dedupes per matter for 12 hours, both wrong while someone is waiting on the line.
      if (r.ok) await appendMessage("clara", text, undefined, { channel: "sms", from: to, principal: true }).catch(() => {});
      return r.ok;
    },
    ringOwner: async (h) => {
      const to = transferTarget();
      if (!to) return { ok: false, error: "no personal cell to ring" };
      const qs = `callSid=${encodeURIComponent(h.callSid)}`;
      return placeCall(to, { url: `${h.base}${HOLD_PATH}/answer?${qs}` }, {
        // Detection first, so the owner's voicemail greeting can't be bridged to the caller. A 15s ring never
        // reaches the carrier's voicemail roll (20–30s), so "no-answer" stays no-answer.
        machineDetection: "Enable",
        machineDetectionTimeoutSec: 5,
        timeoutSec: 15,
        statusCallback: `${h.base}${HOLD_PATH}/owner-status?${qs}`,
        // "completed" is the only terminal EVENT; no-answer/busy/failed/canceled arrive as the
        // CallStatus inside it. Listing them as events drew a Twilio 21626 warning on every transfer.
        statusCallbackEvent: ["completed"],
      });
    },
    redirect: redirectCall,
    patchSession: patchInboundSession,
    log: async (what, callSid, meta) => { await append({ kind: "call", actor: "clara", what, ref: callSid, meta: { direction: "inbound", context: "inbound-workline", ...(meta ?? {}) } }).catch(() => {}); },
    now: () => Date.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
  };
}

async function deps(d?: Partial<HoldDeps>): Promise<HoldDeps> {
  return { ...(await defaultDeps()), ...(d ?? {}) };
}

export type StartHoldResult = { ok: true; queueName: string } | { ok: false; reason: "busy" | "no-number" | "text-failed" | "ring-failed" };

/**
 * Park the caller and ask the owner. Called BEFORE the <Enqueue> TwiML is returned; on failure the voice
 * route carries on with the normal message path and never parks anyone. `who`/`need` come from the
 * session (whoLabel); the timer returns the caller if the owner doesn't answer in time.
 */
export async function startHold(
  input: { callSid: string; from: string; who: string; need?: string; vip: boolean; urgent?: boolean; base: string },
  opts: { deps?: Partial<HoldDeps>; env?: Record<string, string | undefined> } = {},
): Promise<StartHoldResult> {
  const d = await deps(opts.deps);
  const env = opts.env ?? process.env;
  const { transferTarget } = await import("./ownerPhones");
  if (!transferTarget(env)) return { ok: false, reason: "no-number" };
  // One at a time: a second caller would compete for the same "1", and the owner can only take one call.
  if (liveHold()) return { ok: false, reason: "busy" };
  const now = d.now();
  const h: HoldRecord = {
    callSid: input.callSid, from: input.from, queueName: queueNameFor(input.callSid), who: input.who, need: input.need,
    // Starts as `accepted` — a VIP ring commits the warm transfer immediately (owner rule 2026-10-02
    // "do the warm transfer right away"). The accept/decline whisper on the owner's cell is a confirmation
    // step, not a gate on whether to ring at all.
    vip: input.vip, base: input.base, textedAt: now, deadlineAt: now + holdTimeoutMs(env), state: "accepted",
  };
  holds().set(h.callSid, h);
  // Ring the owner's cell right away. The whisper on their leg (hold/answer) will ask press 1 / 2 — no
  // SMS wait, so a text they haven't seen can't cost them the call. The ring is the primary action.
  const ring = await d.ringOwner(h).catch((e) => ({ ok: false, error: String(e) } as { ok: boolean; sid?: string; error?: string }));
  if (!ring.ok) {
    holds().delete(h.callSid);
    await d.log(`hold for ${h.who} not started — couldn't ring ${OWNER_FIRST}'s cell (${ring.error ?? "unknown"})`, h.callSid, { hold: "ring-failed" });
    return { ok: false, reason: "ring-failed" };
  }
  h.ownerCallSid = ring.sid;
  // Fire the text in parallel as a durable heads-up (the owner can still text 1/2 as a fallback if their
  // phone is on silent / they can't press keys on the call). Non-blocking by design — a text failure
  // never derails the ring.
  void d.textOwner(holdText(h, { urgent: input.urgent })).catch(() => false);
  d.patchSession(h.callSid, { transferTried: true });
  h.timer = d.setTimer(() => { void expireHold(h.callSid, opts.deps); }, h.deadlineAt - now);
  await d.log(`hold started: ${h.who} parked, ringing ${OWNER_FIRST}'s cell (whisper 1/2) + heads-up text`, h.callSid, { hold: "started", queue: h.queueName, ownerCallSid: ring.sid });
  return { ok: true, queueName: h.queueName };
}

/** Bring the caller back to Clara with the neutral line; the outcome goes on the session and the record. */
export async function returnCaller(callSid: string, why: Exclude<TransferOutcome, "connected" | "caller-left">, d?: Partial<HoldDeps>): Promise<boolean> {
  const dd = await deps(d);
  const h = holds().get(callSid);
  if (!h || h.state === "bridged" || h.state === "returned" || h.state === "caller-left") return false;
  clearTimer(h);
  h.state = "returned";
  h.outcome = why;
  dd.patchSession(callSid, { transferOutcome: why });
  const r: { ok: boolean; error?: string } = await dd.redirect(callSid, `${h.base}${HOLD_PATH}/return?callSid=${encodeURIComponent(callSid)}&why=${why}`).catch((e) => ({ ok: false, error: String(e) }));
  if (!r.ok) {
    // The redirect fails when the call is already over: they hung up while waiting.
    h.state = "caller-left";
    h.outcome = "caller-left";
    dd.patchSession(callSid, { transferOutcome: "caller-left" });
    await dd.log(`hold for ${h.who} ended (${why}) but they had already hung up (${r.error ?? "redirect failed"})`, callSid, { hold: "caller-left" });
    return false;
  }
  await dd.log(`hold for ${h.who} ended: ${why} — back to Clara for a message`, callSid, { hold: why });
  return true;
}

/**
 * The caller has ALREADY left the queue (hold/done: the wait route's <Leave/> backstop, or a queue
 * error) and is being answered with TwiML right now — record the outcome without redirecting a leg
 * that is no longer parked. Returns false when the hold had already been settled.
 */
export async function markReturned(callSid: string, why: Exclude<TransferOutcome, "connected" | "caller-left">, d?: Partial<HoldDeps>): Promise<boolean> {
  const dd = await deps(d);
  const h = holds().get(callSid);
  if (!h || h.state === "bridged" || h.state === "returned" || h.state === "caller-left") return false;
  clearTimer(h);
  h.state = "returned";
  h.outcome = why;
  dd.patchSession(callSid, { transferOutcome: why });
  await dd.log(`hold for ${h.who} ended: ${why} — they left the queue, back to Clara for a message`, callSid, { hold: why });
  if (why === "no-reply") await dd.textOwner(`I didn't hear back in time, so ${h.who} is back with me and I'm taking a message. — Clara`).catch(() => false);
  return true;
}

async function expireHold(callSid: string, d?: Partial<HoldDeps>): Promise<void> {
  const h = holds().get(callSid);
  // Any state in which the owner hasn't actually taken the call: waiting (pre-ring-first legacy),
  // accepted (ring went out, no digit yet). Bridged / returned / caller-left already settled.
  if (!h || (h.state !== "waiting" && h.state !== "accepted")) return;
  const dd = await deps(d);
  await returnCaller(callSid, "no-reply", d);
  await dd.textOwner(`I didn't hear back in time, so ${h.who} is back with me and I'm taking a message. — Clara`).catch(() => false);
}

/** The owner texted "1": ring their cell. The hold stays live until their leg answers or fails. */
export async function acceptHold(callSid: string, d?: Partial<HoldDeps>): Promise<string> {
  const dd = await deps(d);
  const h = holds().get(callSid);
  if (!h || h.state !== "waiting") return `That call isn't holding any more.`;
  clearTimer(h);
  h.state = "accepted";
  const r: { ok: boolean; sid?: string; error?: string } = await dd.ringOwner(h).catch((e) => ({ ok: false, error: String(e) }));
  if (!r.ok) {
    await dd.log(`hold for ${h.who}: couldn't ring ${OWNER_FIRST}'s cell (${r.error ?? "unknown"})`, callSid, { hold: "ring-failed" });
    await returnCaller(callSid, "no-answer", d);
    return `I couldn't ring your cell (${(r.error ?? "unknown error").slice(0, 80)}), so ${h.who} is back with me and I'm taking a message.`;
  }
  h.ownerCallSid = r.sid;
  await dd.log(`hold for ${h.who}: ${OWNER_FIRST} said 1, ringing their cell`, callSid, { hold: "accepted", ownerCallSid: r.sid });
  return "Calling you now.";
}

/** The owner texted "2". */
export async function declineHold(callSid: string, d?: Partial<HoldDeps>): Promise<string> {
  const h = holds().get(callSid);
  if (!h || h.state !== "waiting") return `That call isn't holding any more.`;
  await returnCaller(callSid, "declined", d);
  return `Okay — taking a message from ${h.who}.`;
}

/**
 * The owner texting Clara's number while a hold is live. Returns the line to text back, or null when the
 * message isn't an answer to the hold (the normal owner path continues). Runs FIRST in the owner
 * block of the SMS route: a bare "1" must never reach workTextAsk, which would relay "the owner says 1."
 */
export async function tryHandleHoldReply(text: string, opts: { now?: number; deps?: Partial<HoldDeps> } = {}): Promise<string | null> {
  const h = liveHold();
  if (!h) return null;
  const reply = parseHoldReply(text);
  if (!reply) return null;
  const now = opts.now ?? Date.now();
  if (h.state === "accepted") return reply === "take" ? "Already ringing you — pick up and I'll connect you." : `Your cell is already ringing for ${h.who} — just don't pick up and I'll take a message.`;
  if (holdExpired(h, now, HOLD_REPLY_GRACE_MS)) return `Too late — ${h.who} went back to me and I'm taking a message; I'll text you the details.`;
  return reply === "take" ? acceptHold(h.callSid, opts.deps) : declineHold(h.callSid, opts.deps);
}

/** The owner's leg answered (hold/answer). What their leg should do next. */
export type OwnerAnswer = { action: "bridge" } | { action: "hangup"; why: "voicemail" | "not-holding" } | { action: "confirm" };

export async function onOwnerAnswered(callSid: string, answeredBy: string | undefined, d?: Partial<HoldDeps>): Promise<OwnerAnswer> {
  const h = holds().get(callSid);
  if (!h || h.state !== "accepted") return { action: "hangup", why: "not-holding" };
  const kind = classifyAnsweredBy(answeredBy);
  // Human and unknown both get the digit-choice whisper (owner rule 2026-10-02 "give me an option
  // like a button to press"). Pre-rule behaviour auto-bridged on `human` because the owner had already
  // texted "1" to accept — now that ring is first, consent lives on the whisper.
  if (kind === "human" || kind === "unknown") return { action: "confirm" };
  const dd = await deps(d);
  await dd.log(`hold for ${h.who}: ${OWNER_FIRST}'s voicemail answered, hanging up their leg`, callSid, { hold: "voicemail" });
  await returnCaller(callSid, "voicemail", d);
  await dd.textOwner(`Your voicemail picked up, so I kept ${h.who} with me and took a message. — Clara`).catch(() => false);
  return { action: "hangup", why: "voicemail" };
}

/**
 * The owner pressed 2 (or any non-accept digit) on the hold whisper. Mark the hold as declined and bring
 * the caller back to Clara — same path as a text "2" and owner-status "completed" without a bridge.
 */
export async function declineOnWhisper(callSid: string, d?: Partial<HoldDeps>): Promise<void> {
  const h = holds().get(callSid);
  if (!h || h.state === "bridged" || h.state === "returned" || h.state === "caller-left") return;
  const dd = await deps(d);
  await dd.log(`hold for ${h.who}: ${OWNER_FIRST} pressed 2 on the whisper — declining`, callSid, { hold: "declined-on-whisper" });
  await returnCaller(callSid, "declined", d);
}

/** The caller's leg is about to be bridged into the owner's (hold/bridged). */
export function markBridged(callSid: string, patch: HoldDeps["patchSession"]): void {
  const h = holds().get(callSid);
  if (!h) return;
  clearTimer(h);
  h.state = "bridged";
  h.outcome = "connected";
  patch(callSid, { transferAccepted: true, transferOutcome: "connected" });
}

/** The owner's leg ended (hold/owner-status). If it never bridged, the caller comes back. */
export async function onOwnerLegEnded(callSid: string, callStatus: string | undefined, d?: Partial<HoldDeps>): Promise<void> {
  const h = holds().get(callSid);
  if (!h || h.state !== "accepted") return;
  const dd = await deps(d);
  const status = String(callStatus ?? "").toLowerCase();
  const why: TransferOutcome = status === "completed" ? "no-reply" : "no-answer";
  await dd.log(`hold for ${h.who}: ${OWNER_FIRST}'s leg ended (${status || "unknown"}) before bridging`, callSid, { hold: why });
  await returnCaller(callSid, why, d);
  await dd.textOwner(why === "no-answer"
    ? `Couldn't reach your cell, so ${h.who} is back with me and I'm taking a message. — Clara`
    : `Nobody took the call on your cell, so ${h.who} is back with me and I'm taking a message. — Clara`).catch(() => false);
}

/** The caller hung up while parked (hold/done with QueueResult=hangup). */
export async function onCallerLeft(callSid: string, d?: Partial<HoldDeps>): Promise<void> {
  const h = holds().get(callSid);
  if (!h || h.state === "bridged" || h.state === "caller-left") return;
  const dd = await deps(d);
  clearTimer(h);
  const wasWaiting = h.state === "waiting" || h.state === "accepted";
  h.state = "caller-left";
  h.outcome = "caller-left";
  dd.patchSession(callSid, { transferOutcome: "caller-left" });
  await dd.log(`hold for ${h.who}: they hung up while holding`, callSid, { hold: "caller-left" });
  if (wasWaiting) await dd.textOwner(`Never mind — ${h.who} hung up while holding. Their number is ${h.from}. — Clara`).catch(() => false);
}

/** The label the hold text and whisper use for this caller. */
export function holdWho(state: Pick<InboundCallState, "learned" | "profile" | "fromE164">): string {
  return whoLabel(state.learned, state.profile, state.fromE164);
}
