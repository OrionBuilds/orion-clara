// Clara — the owner's work-phone texts through BlueBubbles on a Mac.
//
// Apple gives no API to an iPhone's messages. A Mac, signed into the same Apple ID with Text
// Message Forwarding on, sees every iMessage AND SMS the work iPhone gets. BlueBubbles Server runs on
// that Mac: it POSTs each new message to Clara's webhook, and sends her replies through Messages.app,
// so they go out from the owner's real work number.
//
//   Mac → Clara:  BlueBubbles webhook → https://<clara>/api/channels/imessage?secret=<BLUEBUBBLES_WEBHOOK_SECRET>
//                 (BlueBubbles can't sign requests or add headers, so the secret rides in the URL.)
//   Clara → Mac:  POST <BLUEBUBBLES_URL>/api/v1/message/text?password=<BLUEBUBBLES_PASSWORD> over the LAN.
//
// Rules this module enforces before any reply goes out:
//   * her own sent messages echo back as isFromMe — recognised and ignored;
//   * The owner replying personally in a thread stands her down on that thread for 12 hours;
//   * group chats, short codes, verification codes and tapbacks are never answered;
//   * opted-out numbers (dnc.ts) and the global outbound breaker (outbound.ts) are respected.
//
// Inert until BLUEBUBBLES_URL, BLUEBUBBLES_PASSWORD and BLUEBUBBLES_WEBHOOK_SECRET are set.

import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { loadConfig } from "./config";
import { isLoopNumber } from "./ownerPhones";
import { OWNER_FIRST } from "./owner";

type Env = Record<string, string | undefined>;

export const STAND_DOWN_MS = 12 * 3_600_000;
/** A thread Clara hasn't written in for this long gets her introduction again, not just a sign-off. */
export const INTRO_AFTER_SILENCE_MS = 24 * 3_600_000;
/** An isFromMe echo within this window whose text matches what Clara just sent is her own message. */
const ECHO_WINDOW_MS = 5 * 60_000;
const HISTORY_MAX = 12;

export function relayConfig(env: Env = process.env): { url: string; password: string } | null {
  const url = env.BLUEBUBBLES_URL?.trim().replace(/\/+$/, "");
  const password = env.BLUEBUBBLES_PASSWORD?.trim();
  return url && password ? { url, password } : null;
}

export function webhookSecretOk(provided: string | null | undefined, env: Env = process.env): boolean {
  const want = env.BLUEBUBBLES_WEBHOOK_SECRET?.trim();
  if (!want || !provided) return false;
  const a = Buffer.from(want), b = Buffer.from(provided);
  return a.length === b.length && timingSafeEqual(a, b);
}

// ── Payload parsing ─────────────────────────────────────────────────────────────────────────────

export interface RelayMessage {
  guid: string;
  text: string;
  isFromMe: boolean;
  /** The other party: a phone number (+1…) or an Apple ID email. */
  address: string;
  service: string;                // "iMessage" | "SMS"
  chatGuid: string;               // "iMessage;-;+18135550100" (1:1) or "iMessage;+;chat…" (group)
  isGroup: boolean;
  isReaction: boolean;
  hasAttachments: boolean;
  at: number;                     // ms
}

interface RawHandle { address?: string; service?: string }
interface RawChat { guid?: string; style?: number; participants?: RawHandle[] }
interface RawMessage {
  guid?: string; text?: string | null; isFromMe?: boolean; handle?: RawHandle | null;
  chats?: RawChat[]; dateCreated?: number | null; associatedMessageGuid?: string | null;
  associatedMessageType?: string | number | null; attachments?: unknown[]; itemType?: number;
}

/** Pure: a BlueBubbles webhook body → one message, or null for anything that isn't a new message. */
export function parseRelayEvent(body: unknown): RelayMessage | null {
  if (!body || typeof body !== "object") return null;
  const ev = body as { type?: string; data?: RawMessage };
  if (ev.type !== "new-message" || !ev.data || typeof ev.data !== "object") return null;
  const m = ev.data;
  const chat = Array.isArray(m.chats) ? m.chats[0] : undefined;
  const chatGuid = String(chat?.guid ?? "");
  // Style 43 is a group chat in Messages' database; the ";+;" guid form says the same.
  const isGroup = chat?.style === 43 || chatGuid.includes(";+;") || (chat?.participants?.length ?? 0) > 1;
  let address = String(m.handle?.address ?? "");
  // The owner's own sends carry no handle; the 1:1 chat guid still names the other party.
  if (!address && chatGuid.includes(";-;")) address = chatGuid.split(";-;")[1] ?? "";
  return {
    guid: String(m.guid ?? ""),
    text: String(m.text ?? "").trim(),
    isFromMe: m.isFromMe === true,
    address,
    service: String(m.handle?.service ?? (chatGuid.split(";")[0] || "iMessage")),
    chatGuid,
    isGroup,
    isReaction: Boolean(m.associatedMessageGuid) || (m.associatedMessageType != null && m.associatedMessageType !== 0 && m.associatedMessageType !== ""),
    hasAttachments: Array.isArray(m.attachments) && m.attachments.length > 0,
    at: typeof m.dateCreated === "number" ? m.dateCreated : Date.now(),
  };
}

// ── What never gets a reply ─────────────────────────────────────────────────────────────────────

/** US short codes are 5–6 digits; alphanumeric senders ("AMZN") have no digits worth dialing. */
export function isShortCode(address: string): boolean {
  if (address.includes("@")) return false;
  const digits = address.replace(/\D/g, "");
  return digits.length > 0 ? digits.length <= 6 : /^[a-z0-9 ._-]+$/i.test(address);
}

const CODE_RX = [
  /\b(verification|security|login|sign[- ]?in|one[- ]time|confirmation|auth(entication)?|access)\s+(code|pin|passcode)\b/i,
  /\b(code|pin|otp|passcode)\s*(is|:)?\s*(?=[A-Z0-9]*\d)[A-Z0-9]{4,8}\b/i,   // the code itself has digits — "code review" isn't one
  /\b\d{4,8}\s+is your\b/i,
  /\bdo not share (this|it|your code)\b/i,
];
export function isVerificationCode(text: string): boolean {
  return CODE_RX.some((re) => re.test(text));
}

export type IgnoreReason = "empty" | "group" | "short-code" | "verification-code" | "reaction" | "no-sender" | "self";

export function ignoreReason(m: RelayMessage, env: Env = process.env): IgnoreReason | null {
  if (m.isReaction) return "reaction";
  if (m.isGroup) return "group";
  if (!m.address) return "no-sender";
  // A text from one of Clara's own lines (or the work phone itself) — answering it would be a loop.
  if (isLoopNumber(env, m.address)) return "self";
  if (isShortCode(m.address)) return "short-code";
  if (!m.text) return "empty";
  if (isVerificationCode(m.text)) return "verification-code";
  return null;
}

// ── Per-thread state: stand-down, intro, echo detection, short history ──────────────────────────

export interface ThreadState {
  standDownUntil?: number;
  /** Pre-2026-09-29 flag: Clara has written in this thread at some point. Superseded by lastClaraAt. */
  introduced?: boolean;
  /** When Clara last sent in this thread — decides whether her next text opens with the introduction. */
  lastClaraAt?: number;
  /** Sends not yet seen echoing back — each with its own id, so one failure never clears another. */
  sent?: Array<{ id: string; text: string; at: number }>;
  history?: Array<{ from: "them" | "clara" | "owner"; text: string; at: number }>;
}
export interface RelayState {
  threads: Record<string, ThreadState>;
  relay?: { downSince?: number; notified?: boolean; lastOk?: number };
}

export function isOwnEcho(t: ThreadState | undefined, text: string, now: number): boolean {
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();
  return Boolean(t?.sent?.some((s) => now - s.at < ECHO_WINDOW_MS && norm(s.text) === norm(text)));
}

export function standDownActive(t: ThreadState | undefined, now: number): boolean {
  return Boolean(t?.standDownUntil && t.standDownUntil > now);
}

/** Pure: apply an isFromMe message. Clara's echo changes nothing; the owner's own reply stands her down. */
export function applyFromMe(state: RelayState, m: RelayMessage, now: number): { state: RelayState; owner: boolean } {
  const t = { ...(state.threads[m.chatGuid] ?? {}) };
  if (isOwnEcho(t, m.text, now)) return { state, owner: false };
  t.standDownUntil = now + STAND_DOWN_MS;
  t.history = [...(t.history ?? []), { from: "owner" as const, text: m.text, at: now }].slice(-HISTORY_MAX);
  return { state: { ...state, threads: { ...state.threads, [m.chatGuid]: t } }, owner: true };
}

export function noteMessage(state: RelayState, chatGuid: string, from: "them" | "clara", text: string, now: number): RelayState {
  const t = { ...(state.threads[chatGuid] ?? {}) };
  t.history = [...(t.history ?? []), { from, text, at: now }].slice(-HISTORY_MAX);
  if (from === "clara") { t.introduced = true; t.lastClaraAt = now; }
  return { ...state, threads: { ...state.threads, [chatGuid]: t } };
}

// ── Saying who she is (owner rule, 2026-09-29) ──────────────────────────────────────────────────
//
// Her replies go out from the owner's own number, in their own Messages thread. Until now she introduced
// herself once per thread, forever — so a client texting again a month later got a "the owner says…"
// with nothing to show it wasn't the owner typing. "We're not trying to fool anybody": every text she
// sends now names her. The introduction after a day's silence, a short sign-off in between, and
// nothing added when the words already say who she is.

export const CLARA_INTRO = `Hi, this is Clara, ${OWNER_FIRST}'s AI assistant. `;
export const CLARA_SIGN_OFF = " — Clara";
/** iMessage/SMS body limit for one send; the identification is reserved out of it, never cut off it. */
export const RELAY_TEXT_MAX = 1500;

/** Pure: Clara hasn't written in this thread within the last day (or ever). */
export function needsIntro(t: ThreadState | undefined, now: number): boolean {
  const last = t?.lastClaraAt ?? t?.history?.filter((h) => h.from === "clara").at(-1)?.at;
  return last === undefined || now - last >= INTRO_AFTER_SILENCE_MS;
}

// Text that already says who is writing: "this is Clara", "I'm Clara, the owner's assistant", or a
// "— Clara" sign-off. A mention of her in passing ("the meeting with Clara is confirmed") is not
// self-identification and still gets the introduction or sign-off.
const SELF_ID_RX = /\b(?:this is|it'?s|i'?m|i am)\s+clara\b|[—–-]\s*clara\s*(?:,\s*[^.!?\n]{0,40})?[.!]?\s*$/i;

export function identifiesClara(text: string): boolean {
  return SELF_ID_RX.test(text);
}

/**
 * Pure: the text as it will actually be sent — always identifying Clara, never twice, and never
 * with the identification trimmed off: the body is cut to leave room for it.
 */
export function signAsClara(text: string, t: ThreadState | undefined, now: number, max = RELAY_TEXT_MAX): string {
  let body = text.trim();
  if (!body) return body;
  if (identifiesClara(body)) return body.slice(0, max);
  const tag = needsIntro(t, now) ? CLARA_INTRO : CLARA_SIGN_OFF;
  const room = Math.max(0, max - tag.length);
  if (body.length > room) body = `${body.slice(0, Math.max(0, room - 1)).trimEnd()}…`;
  return tag === CLARA_INTRO ? `${tag}${body}` : `${body}${tag}`;
}

/**
 * Record a send BEFORE it goes out. Messages.app can fire the isFromMe echo before BlueBubbles
 * answers Clara's POST; if the echo arrived first and found nothing here, it would read as the owner
 * replying and stand her down for 12 hours after her own first reply.
 */
export function addPendingSend(state: RelayState, chatGuid: string, text: string, now: number, id: string): RelayState {
  const t = { ...(state.threads[chatGuid] ?? {}) };
  t.sent = [...(t.sent ?? []).filter((s) => now - s.at < ECHO_WINDOW_MS), { id, text, at: now }];
  return { ...state, threads: { ...state.threads, [chatGuid]: t } };
}

/**
 * Undo addPendingSend — only for a send BlueBubbles definitely rejected, and only that send's entry.
 * An ambiguous failure (timeout, 5xx) keeps it: the message may have gone out anyway, and its echo
 * must still be recognised. Unconfirmed entries age out with the echo window.
 */
export function dropPendingSend(state: RelayState, chatGuid: string, id: string): RelayState {
  const t = state.threads[chatGuid];
  if (!t?.sent) return state;
  return { ...state, threads: { ...state.threads, [chatGuid]: { ...t, sent: t.sent.filter((s) => s.id !== id) } } };
}

/**
 * Pure: the connection never reached BlueBubbles (DNS failure, refused, unreachable host), so the
 * message cannot have been sent. Timeouts and resets can follow delivery and stay ambiguous.
 */
export function isPreSendFailure(e: unknown): boolean {
  const cause = e && typeof e === "object" ? (e as { cause?: unknown }).cause : undefined;
  const code = cause && typeof cause === "object" ? (cause as { code?: unknown }).code : undefined;
  return typeof code === "string" && ["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "EADDRNOTAVAIL"].includes(code);
}

/** Pure: a 4xx other than timeout/rate-limit means the relay refused the message — it was not sent. */
export function confirmedRejection(status: number): boolean {
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

async function stateFile(): Promise<string> {
  const cfg = await loadConfig();
  await fs.mkdir(cfg.dataDir, { recursive: true });
  return path.join(cfg.dataDir, "imessage-state.json");
}

export async function readRelayState(): Promise<RelayState> {
  try {
    const s = JSON.parse(await fs.readFile(await stateFile(), "utf8")) as RelayState;
    return { threads: s.threads ?? {}, relay: s.relay };
  } catch {
    return { threads: {} };
  }
}

// Serialize read-modify-write so two messages landing together don't lose each other's update.
let chain: Promise<unknown> = Promise.resolve();
export function updateRelayState(fn: (s: RelayState) => RelayState): Promise<RelayState> {
  const run = chain.then(async () => {
    const next = fn(await readRelayState());
    const f = await stateFile();
    await fs.writeFile(`${f}.tmp`, JSON.stringify(next), "utf8");
    await fs.rename(`${f}.tmp`, f);
    return next;
  });
  chain = run.catch(() => {});
  return run;
}

// ── Transport ───────────────────────────────────────────────────────────────────────────────────

export function sendBody(chatGuid: string, message: string, tempGuid = `clara-${randomUUID()}`): Record<string, string> {
  // AppleScript works without BlueBubbles' Private API helper; it's the default the server applies too.
  return { chatGuid, tempGuid, message, method: "apple-script" };
}

/**
 * ok — BlueBubbles confirmed the send. unknown — it may have gone out (timeout, 5xx after sending:
 * BlueBubbles can return 500 for a message Messages.app delivered), so don't claim it failed.
 * `text` is what actually went out: every send is signed as Clara here (signAsClara), the one place
 * all of her work-phone texts pass through, so no caller can forget to.
 */
export async function sendRelayText(chatGuid: string, message: string): Promise<{ ok: boolean; unknown?: boolean; error?: string; text: string }> {
  const cfg = relayConfig();
  if (!cfg) return { ok: false, error: "BlueBubbles relay not configured", text: message };
  const id = randomUUID();
  let body = message;
  // No record, no send: an unrecorded message's echo would read as the owner replying. The signed text is
  // what gets recorded, because the signed text is what echoes back.
  try {
    await updateRelayState((s) => {
      body = signAsClara(message, s.threads[chatGuid], Date.now());
      return addPendingSend(s, chatGuid, body, Date.now(), id);
    });
  } catch (e) {
    return { ok: false, error: `couldn't record the pending send, so didn't send: ${String(e).slice(0, 120)}`, text: body };
  }
  try {
    const r = await fetch(`${cfg.url}/api/v1/message/text?password=${encodeURIComponent(cfg.password)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(sendBody(chatGuid, body)),
      signal: AbortSignal.timeout(20_000),
    });
    if (!r.ok) {
      const error = `relay send ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}`;
      if (!confirmedRejection(r.status)) return { ok: false, unknown: true, error, text: body };
      await updateRelayState((s) => dropPendingSend(s, chatGuid, id)).catch(() => {});
      return { ok: false, error, text: body };
    }
    await updateRelayState((s) => noteMessage(s, chatGuid, "clara", body, Date.now())).catch(() => {});
    return { ok: true, text: body };
  } catch (e) {
    const error = `relay unreachable: ${String((e as { cause?: unknown })?.cause ?? e).slice(0, 160)}`;
    if (isPreSendFailure(e)) {
      await updateRelayState((s) => dropPendingSend(s, chatGuid, id)).catch(() => {});
      return { ok: false, error, text: body };
    }
    // Timed out or dropped mid-request: it may still have gone out, so the pending entry stays.
    return { ok: false, unknown: true, error, text: body };
  }
}

export async function pingRelay(): Promise<boolean> {
  const cfg = relayConfig();
  if (!cfg) return false;
  try {
    const r = await fetch(`${cfg.url}/api/v1/ping?password=${encodeURIComponent(cfg.password)}`, { signal: AbortSignal.timeout(8_000) });
    if (!r.ok) return false;
    const j = await r.json().catch(() => ({})) as { data?: unknown };
    return j.data === "pong";
  } catch {
    return false;
  }
}

// ── Chat history (2026-10-02, owner rule "Clara can read back in the conversation") ─────────────
//
// Clara's local ThreadState only sees messages that moved through the webhook: anything typed on
// The owner's phone before BlueBubbles was wired up, or any backlog older than her first webhook event
// for that chat, is invisible to her. That gap showed up when someone texted on a thread that had
// been going for weeks and her reply ignored the prior context.
//
// Fix: fetch recent messages for the chat directly from BlueBubbles' REST API and feed them into
// the LLM prompt. isFromMe messages come back as either Clara or the owner — mergeChatHistory() uses
// the local Clara-tagged `history` as the key for disambiguation (a BB isFromMe whose text matches
// a prior Clara send inside the echo window is Clara's; otherwise it's the owner's).

export interface ChatHistoryEntry { from: "them" | "clara" | "owner"; text: string; at: number }

/**
 * Pull the last `limit` messages for a chat from BlueBubbles. 3s cap so a slow relay never stalls
 * a text turn. Returns [] on any error — the brain still has local history as a fallback.
 */
export async function fetchChatHistory(chatGuid: string, limit = 20): Promise<ChatHistoryEntry[]> {
  const cfg = relayConfig();
  if (!cfg) return [];
  try {
    const url = `${cfg.url}/api/v1/chat/${encodeURIComponent(chatGuid)}/message` +
      `?password=${encodeURIComponent(cfg.password)}&limit=${limit}&sort=DESC&with=handle`;
    const r = await fetch(url, { signal: AbortSignal.timeout(3_000) });
    if (!r.ok) return [];
    const j = (await r.json().catch(() => null)) as { data?: unknown } | null;
    const rows = Array.isArray(j?.data) ? (j!.data as RawMessage[]) : [];
    const out: ChatHistoryEntry[] = [];
    for (const m of rows) {
      const text = typeof m.text === "string" ? m.text.trim() : "";
      if (!text) continue;
      const at = typeof m.dateCreated === "number" ? m.dateCreated : 0;
      // Until we match against local Clara-sends, every isFromMe is tentatively the owner. The brain's
      // caller runs mergeChatHistory with the local thread before using the result.
      const from: "them" | "owner" = m.isFromMe ? "owner" : "them";
      out.push({ from, text, at });
    }
    return out.sort((a, b) => a.at - b.at);
  } catch {
    return [];
  }
}

/**
 * Pure: merge the authoritative BlueBubbles chat history with Clara's own local history, used ONLY
 * to re-tag messages BB reports as `isFromMe` → the owner back to `clara` when they match something
 * Clara is known to have sent (same text, within the echo window around that message's time).
 * The output is capped at `max` ascending by time — oldest first, which is what the prompt wants.
 */
export function mergeChatHistory(
  bb: readonly ChatHistoryEntry[],
  local: readonly { from: "them" | "clara" | "owner"; text: string; at: number }[] | undefined,
  max = 20,
): ChatHistoryEntry[] {
  const claraSends = (local ?? []).filter((h) => h.from === "clara");
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();
  const out: ChatHistoryEntry[] = bb.map((e) => {
    if (e.from !== "owner") return e;
    const matches = claraSends.some((c) =>
      norm(c.text) === norm(e.text) && Math.abs(c.at - e.at) < ECHO_WINDOW_MS * 2
    );
    return matches ? { ...e, from: "clara" } : e;
  });
  return out.slice(-max);
}

// ── Health ──────────────────────────────────────────────────────────────────────────────────────

export const RELAY_DOWN_EMAIL_AFTER_MS = 15 * 60_000;

/** Pure: next relay health state and whether to email the owner now (once per outage, never by text). */
export function relayHealthStep(prev: RelayState["relay"], ok: boolean, now: number): { relay: NonNullable<RelayState["relay"]>; email: "down" | "recovered" | null } {
  if (ok) {
    return { relay: { lastOk: now }, email: prev?.notified ? "recovered" : null };
  }
  const downSince = prev?.downSince ?? now;
  if (!prev?.notified && now - downSince >= RELAY_DOWN_EMAIL_AFTER_MS) {
    return { relay: { ...prev, downSince, notified: true }, email: "down" };
  }
  return { relay: { ...prev, downSince }, email: null };
}

/** Scheduler job: ping every 5 minutes; email the owner once when it has been down 15 minutes. */
export async function relayHealthTick(now = Date.now()): Promise<string> {
  if (!relayConfig()) return "relay not configured";
  const ok = await pingRelay();
  let decision: ReturnType<typeof relayHealthStep> | null = null;
  await updateRelayState((s) => {
    decision = relayHealthStep(s.relay, ok, now);
    return { ...s, relay: decision.relay };
  });
  const d = decision as ReturnType<typeof relayHealthStep> | null;
  if (d?.email) {
    const cfg = await loadConfig();
    const email = cfg.principals.owner.emails[0];
    if (email) {
      const { sendMail } = await import("./ms-mail");
      const down = d.email === "down";
      await sendMail({
        to: email,
        subject: down ? "Clara can't reach your work texts" : "Clara can see your work texts again",
        body: down
          ? "The Mac that passes your work phone's texts to me hasn't answered for 15 minutes, so I can't read or answer them right now. Calls still reach me.\n\nUsually one of these fixes it: the Mac is asleep or restarted, BlueBubbles isn't open, or it's off the network. Once it's back I'll pick up from there."
          : "The Mac is answering again, so I'm reading and answering your work texts. Anything that came in while it was down is on the Mac and I'll see new messages from here on.",
        headers: { "X-Clara-Notify": "1" },
      }).catch(() => {});
    }
  }
  return ok ? "relay ok" : "relay down";
}
