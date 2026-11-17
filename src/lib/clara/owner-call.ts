// Clara — the 08:30 morning call (owner-comms overhaul, 2026-09-24).
//
// The owner gets their brief by email at 08:00 and, at 08:30 on working days, Clara RINGS THEM, reads the
// spoken version (under ninety seconds), then stays on the line: questions, decisions and new tasks
// happen in the conversation, on the same router and the same memory as SMS, chat and email.
//
// What this module owns:
//   * placing the call (placeMorningCall) — destination is OWNER_PERSONAL_PHONE when set, else derived
//     from config and asserted against OWNER_PHONE; there is no `to` parameter anywhere in this path;
//   * the spoken script (buildSpokenScript): the brief rewritten as speech, chunked for <Play>;
//   * each conversational turn (handleOwnerTurn): decision fast path → router (12s race, slow tools
//     deferred and texted) → plain conversation fallback; every exchange persisted to the owner thread;
//   * no-answer / voicemail handling with exactly one retry; finalization with a recap email.
//
// Rules the code enforces (see the plan's "Owner-call safety"): only the owner's number, Twilio-signed
// webhooks, identity from Direction+To (never From), no stranger/lead/business persona, no <Record>,
// quiet hours respected, once per day, ≤20 turns, ≤2 silences.

import { loadConfig } from "./config";
import { OWNER_FIRST } from "./owner";
import { normalizeE164, isLoopNumber } from "./ownerPhones";
import { twilioConfig, placeCall, speak, esc, sendSMS, elevenTTSAudio, elevenKey } from "./channels";
import { append as ledgerAppend } from "./ledger";
import { notifyOwner, inQuietHours } from "./notify";
import { composeBriefModel, loadBriefModel, renderBriefMarkdown, renderBriefSpoken, ymd, stripEmoji, type BriefModel } from "./briefModel";
import { gateBriefForCloud } from "./briefs";
import { complete } from "./engines";
import { principalIdentityWithSoul } from "./persona";
import { sendMail } from "./ms-mail";
import {
  createOwnerSession, getOwnerSession, saveOwnerSession, appendOwnerTurn, claimOwnerFinalize, todaysSession,
  type OwnerCallSession,
} from "./owner-call-sessions";

export const OWNER_CALL_PATH = "/api/channels/twilio/owner-call";
export const OWNER_CALL_STATUS_PATH = "/api/channels/twilio/owner-call/status";
export const MAX_TURNS = 20;
export const MAX_SILENCES = 2;
export const SCRIPT_CHUNK = 700;
export const ROUTER_BUDGET_MS = 12_000;
export const RETRY_AFTER_MS = 15 * 60_000;
export const RETRY_CUTOFF = { hour: 9, minute: 30 };
export const SESSION_TTL_MS = 2 * 60 * 60_000;
const TONE = "owner" as const;

// ── Pure helpers (unit-tested) ─────────────────────────────────────────────

/** Last ten digits — the same comparison principals.ts uses; a formatting difference must never fail the identity check. */
export function phoneKey(raw: string | undefined | null): string {
  return String(raw ?? "").replace(/\D/g, "").slice(-10);
}

/** Split spoken prose into ≤max-char chunks on sentence boundaries (a single over-long sentence is hard-cut). */
export function chunkScript(text: string, max = SCRIPT_CHUNK): string[] {
  const clean = stripEmoji(text).replace(/\s+/g, " ").trim();
  if (!clean) return [];
  const sentences = clean.match(/[^.!?]+[.!?]+["')\]]*|[^.!?]+$/g)?.map((s) => s.trim()).filter(Boolean) ?? [clean];
  const out: string[] = [];
  let cur = "";
  for (let s of sentences) {
    while (s.length > max) { out.push(s.slice(0, max).trim()); s = s.slice(max).trim(); }
    if (!s) continue;
    if (!cur) cur = s;
    else if (cur.length + 1 + s.length <= max) cur = `${cur} ${s}`;
    else { out.push(cur); cur = s; }
  }
  if (cur) out.push(cur);
  return out;
}

const END_CORE = "(?:that'?s (?:all|it|everything)|nothing else|(?:i'?m|that'?s) (?:all )?(?:good|fine|set)|(?:all )?done|bye|goodbye|good bye|talk (?:to you )?later|thanks,? clara|thank you,? clara|hang up)";
// Anchored at both ends: "that's all wrong, redo it" is not a goodbye. A few tails are allowed
// ("for now", "thanks", "Clara", "sir") because people say them.
const END_RX = new RegExp(`^(?:ok(?:ay)?,?\\s*|alright,?\\s*|no,?\\s*|yeah,?\\s*)?${END_CORE}(?:,?\\s*(?:for now|for today|thanks|thank you|clara|sir|then))*[.!\\s]*$`, "i");
export function isEndPhrase(speech: string): boolean {
  return END_RX.test(speech.trim());
}

/** Retry only once, only for a first attempt that went unanswered, and only if it's still early. */
export function shouldRetry(input: { attempt: number; status: string; now?: Date }): boolean {
  const now = input.now ?? new Date();
  if (input.attempt !== 1) return false;
  if (!["no-answer", "busy", "failed", "canceled"].includes(input.status)) return false;
  const mins = now.getHours() * 60 + now.getMinutes();
  return mins < RETRY_CUTOFF.hour * 60 + RETRY_CUTOFF.minute;
}

export function voicemailText(counts: { meetings: number; decisions: number }): string {
  const m = `${counts.meetings} meeting${counts.meetings === 1 ? "" : "s"}`;
  const d = counts.decisions === 0 ? "nothing waiting on you" : `${counts.decisions} thing${counts.decisions === 1 ? "" : "s"} waiting on you`;
  return `Morning, ${OWNER_FIRST}. It's Clara with your brief. It's in your email. Short version: ${m} today, ${d}. Call or text me when you're free.`;
}

/** The only identity check on this route: the call must be one we placed, to the number we placed it to. */
export function identityOk(params: { Direction?: string; To?: string }, session: { to: string }): boolean {
  const dir = String(params.Direction ?? "").toLowerCase();
  if (!dir.startsWith("outbound")) return false;
  const k = phoneKey(params.To);
  return k.length === 10 && k === phoneKey(session.to);
}

export type EnvLike = Record<string, string | undefined>;
export function isCallDay(now: Date, env: EnvLike = process.env): boolean {
  const weekends = (env.CLARA_MORNING_CALL_WEEKENDS ?? "off").trim().toLowerCase() === "on";
  const day = now.getDay();
  if (!weekends && (day === 0 || day === 6)) return false;
  const holidays = (env.CLARA_HOLIDAYS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return !holidays.includes(ymd(now));
}

export function callTime(env: EnvLike = process.env): { hour: number; minute: number } | null {
  const raw = (env.CLARA_MORNING_CALL ?? "08:30").trim().toLowerCase();
  if (raw === "off") return null;
  const m = raw.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return { hour: 8, minute: 30 };
  return { hour: Math.min(23, Number(m[1])), minute: Math.min(59, Number(m[2])) };
}

export function briefSummaryLine(m: BriefModel): string {
  const { meetings, emails, decisions } = m.counts;
  return `${meetings} meeting${meetings === 1 ? "" : "s"}, ${emails} email${emails === 1 ? "" : "s"} that need you, ${decisions} decision${decisions === 1 ? "" : "s"}`;
}

// ── TwiML ──────────────────────────────────────────────────────────────────

function turnUrl(base: string, sid: string, t: number, silence = false): string {
  return `${base}${OWNER_CALL_PATH}?sid=${encodeURIComponent(sid)}&t=${t}${silence ? "&silence=1" : ""}`;
}

/** A Gather with barge-in that redirects to the silence branch when nothing is said. */
export function gatherTwiml(chunks: string[], base: string, sid: string, nextTurn: number): string {
  const plays = chunks.map((c) => speak(c, base, TONE)).join("");
  return `<Response>` +
    `<Gather input="speech" speechTimeout="auto" timeout="6" action="${esc(turnUrl(base, sid, nextTurn))}" method="POST">${plays}</Gather>` +
    `<Redirect method="POST">${esc(turnUrl(base, sid, nextTurn, true))}</Redirect>` +
    `</Response>`;
}

export function hangupTwiml(text: string, base: string): string {
  return `<Response>${speak(text, base, TONE)}<Hangup/></Response>`;
}

export function voicemailTwiml(session: OwnerCallSession, base: string): string {
  return hangupTwiml(voicemailText(session.counts), base);
}

// ── Script ─────────────────────────────────────────────────────────────────

const SCRIPT_RULES =
  `Rewrite this morning brief as what you would SAY on a phone call to ${OWNER_FIRST}. Under 200 words. Plain spoken ` +
  "prose — no markdown, no bullet lists read aloud, no emoji, no codes, no URLs. Address them by first name at most " +
  "once. Order: meetings first with times, then what needs their decision, then what FRIDAY did, " +
  "then anything you prepared and where it is (say 'in your email' or 'in Google Drive under Clara, Prep'). " +
  "If a section is empty, one short sentence says so. End with exactly: What do you need from me?";

export async function buildSpokenScript(model: BriefModel): Promise<{ chunks: string[]; via: "llm" | "fallback" }> {
  const fallback = renderBriefSpoken(model);
  let text = "";
  try {
    const gated = gateBriefForCloud(renderBriefMarkdown(model)).text;
    const system = await principalIdentityWithSoul();
    const out = await complete({ system, prompt: `${SCRIPT_RULES}\n\nThe brief:\n\n${gated}`, timeoutMs: 30_000, temperature: 0.3, purpose: "brief" });
    text = stripEmoji(out).replace(/[*_#`>]+/g, "").replace(/https?:\/\/\S+/g, "in your email").replace(/\s+/g, " ").trim();
  } catch { text = ""; }
  const words = text.split(/\s+/).filter(Boolean).length;
  const ok = words >= 25 && words <= 320 && /what do you need from me\??$/i.test(text);
  return ok ? { chunks: chunkScript(text), via: "llm" } : { chunks: chunkScript(fallback), via: "fallback" };
}

async function warmTts(chunks: string[]): Promise<void> {
  if (!elevenKey()) return;
  for (const c of chunks) void elevenTTSAudio(c, { telephony: true, tone: TONE }).catch(() => {});
}

// ── Placement ──────────────────────────────────────────────────────────────

async function resolveOwnerNumber(): Promise<{ ok: true; to: string } | { ok: false; error: string }> {
  // Their personal cell, once set, is where they are reached — the work line forwards to Clara, so ringing
  // it would ring her. Env-sourced like OWNER_PHONE, so the same "never from a caller" rule holds.
  const personal = process.env.OWNER_PERSONAL_PHONE?.trim();
  if (personal) {
    const to = normalizeE164(personal);
    if (to && isLoopNumber(process.env, to)) return { ok: false, error: "OWNER_PERSONAL_PHONE is the work phone or one of Clara's lines" };
    return to ? { ok: true, to } : { ok: false, error: "OWNER_PERSONAL_PHONE is not a valid number" };
  }
  const cfg = await loadConfig();
  const to = cfg.principals.owner.phones[0];
  // With the work phone forwarding everything to Clara, calling it would ring her own work line.
  if (isLoopNumber(process.env, to)) return { ok: false, error: "the only owner number on file is the work phone, which forwards to Clara — set OWNER_PERSONAL_PHONE" };
  const env = process.env.OWNER_PHONE?.trim();
  if (!to || !env) return { ok: false, error: "OWNER_PHONE is not configured" };
  if (phoneKey(to) !== phoneKey(env) || phoneKey(to).length !== 10) return { ok: false, error: "owner number mismatch — refusing to place the call" };
  return { ok: true, to };
}

async function briefForToday(date: string): Promise<BriefModel> {
  const cached = await loadBriefModel(date).catch(() => null);
  if (cached && Date.now() - new Date(cached.now).getTime() <= 90 * 60_000) return cached;
  return composeBriefModel();
}

async function dial(session: OwnerCallSession): Promise<{ ok: boolean; sid?: string; error?: string }> {
  const tw = twilioConfig();
  if (!tw?.publicBase) return { ok: false, error: "CLARA_PUBLIC_WEBHOOK_BASE not configured" };
  const base = tw.publicBase;
  const res = await placeCall(
    session.to,
    { url: `${base}${OWNER_CALL_PATH}?sid=${encodeURIComponent(session.sessionId)}` },
    {
      statusCallback: `${base}${OWNER_CALL_STATUS_PATH}?sid=${encodeURIComponent(session.sessionId)}`,
      statusCallbackEvent: ["completed"],
      machineDetection: "DetectMessageEnd",
      timeoutSec: 25,
    },
  );
  if (res.ok && res.sid) {
    session.callSid = res.sid;
    session.status = "ringing";
    session.retryAt = undefined;
  } else {
    session.status = "failed";
  }
  await saveOwnerSession(session);
  await ledgerAppend({
    kind: "call", actor: "clara",
    what: res.ok ? `morning call placed to ${session.to} (attempt ${session.attempt}${session.purpose === "dry-run" ? ", dry run" : ""})` : `morning call FAILED to place: ${res.error}`,
    ref: res.sid, meta: { direction: "outbound", context: "owner-morning-call", sessionId: session.sessionId, attempt: session.attempt, purpose: session.purpose },
  }).catch(() => {});
  return res;
}

export async function placeMorningCall(opts: { dry?: boolean } = {}): Promise<{ ok: boolean; sid?: string; sessionId?: string; script?: string[]; error?: string }> {
  const dry = Boolean(opts.dry);
  const tw = twilioConfig();
  if (!tw?.publicBase) return { ok: false, error: "CLARA_PUBLIC_WEBHOOK_BASE not configured" };
  const num = await resolveOwnerNumber();
  if (!num.ok) return { ok: false, error: num.error };
  if (!dry && (await inQuietHours())) return { ok: false, error: "quiet hours" };
  const date = ymd(new Date());
  if (!dry) {
    const existing = await todaysSession(date);
    if (existing) return { ok: false, error: `already called today (${existing.status})`, sessionId: existing.sessionId };
  }

  const model = await briefForToday(date);
  const script = await buildSpokenScript(model);
  void warmTts(script.chunks);
  const session = await createOwnerSession({
    date, purpose: dry ? "dry-run" : "morning-brief", to: num.to,
    script: script.chunks, briefSummary: briefSummaryLine(model), counts: model.counts,
  });
  const res = await dial(session);
  return { ok: res.ok, sid: res.sid, sessionId: session.sessionId, script: script.chunks, error: res.error };
}

/** Scheduler entry: places today's call, or the single retry once its time has come. */
export async function morningCallTick(now = new Date()): Promise<string> {
  const date = ymd(now);
  const s = await todaysSession(date);
  if (!s) {
    const r = await placeMorningCall();
    return r.ok ? `placed (${r.sid})` : `not placed: ${r.error}`;
  }
  if (s.attempt === 1 && s.retryAt && !s.finalized && new Date(s.retryAt).getTime() <= now.getTime() && s.status === "no-answer") {
    s.attempt = 2;
    s.status = "placing";
    s.silenceCount = 0;
    await saveOwnerSession(s);
    const r = await dial(s);
    return r.ok ? `retry placed (${r.sid})` : `retry failed: ${r.error}`;
  }
  return `nothing to do (${s.status}, attempt ${s.attempt})`;
}

// ── Turns ──────────────────────────────────────────────────────────────────

const CLOSING = `Understood. Have a good one, ${OWNER_FIRST}.`;
const SNAG = "I hit a snag; your brief is in your email.";

export function openingTwiml(session: OwnerCallSession, base: string): string {
  return gatherTwiml(session.script.length ? session.script : [`Good morning, ${OWNER_FIRST}. Your brief is in your email. What do you need from me?`], base, session.sessionId, 1);
}

async function seedHistoryFor(session: OwnerCallSession): Promise<{ role: "user" | "assistant"; content: string }[]> {
  const script = session.script.join(" ");
  const seed: { role: "user" | "assistant"; content: string }[] = [
    { role: "user", content: `(context) This morning's brief, which you just read to me on the phone:\n${script}` },
    { role: "assistant", content: "Understood." },
  ];
  for (const t of session.turns.slice(-8)) seed.push({ role: t.role === "user" ? "user" : "assistant", content: t.text });
  return seed;
}

async function conversationalReply(session: OwnerCallSession, speech: string): Promise<string> {
  const system = await principalIdentityWithSoul();
  const transcript = session.turns.slice(-8).map((t) => `${t.role === "user" ? OWNER_FIRST : "You"}: ${t.text}`).join("\n");
  const prompt =
    `You are on the phone with ${OWNER_FIRST} after reading them this morning's brief. Reply in at most 90 words of plain spoken prose — no lists, no markdown, no codes.\n\n` +
    `The brief you read:\n${session.script.join(" ")}\n\n${transcript ? `So far on this call:\n${transcript}\n\n` : ""}${OWNER_FIRST} just said: "${speech}"\n\nYour reply:`;
  const out = await complete({ system, prompt, timeoutMs: ROUTER_BUDGET_MS, temperature: 0.5, purpose: "voice" });
  return stripEmoji(out).replace(/[*_#`>]+/g, "").replace(/\s+/g, " ").trim();
}

/**
 * One spoken turn. Returns the TwiML to send back and updates the session on disk.
 * `speech` is what Twilio transcribed; `silence` means the Gather timed out with nothing.
 */
export async function handleOwnerTurn(
  session: OwnerCallSession,
  input: { speech: string; silence: boolean; callSid: string; base: string },
): Promise<string> {
  const { base } = input;
  const sid = session.sessionId;
  const speech = input.speech.trim();

  if (input.silence || !speech) {
    session.silenceCount += 1;
    await saveOwnerSession(session);
    if (session.silenceCount >= MAX_SILENCES) return await endCall(session, base, "silence");
    return gatherTwiml([`Still there, ${OWNER_FIRST}? Anything else?`], base, sid, session.turnCount + 1);
  }
  session.silenceCount = 0;
  await appendOwnerTurn(sid, { role: "user", text: speech });

  if (isEndPhrase(speech)) return await endCall(session, base, "owner said goodbye");
  if (session.turnCount >= MAX_TURNS) return await endCall(session, base, "turn ceiling");

  let reply = "";
  let tools: string[] = [];
  try {
    const { tryHandleDecisionReply } = await import("./decisionReply");
    const decided = await tryHandleDecisionReply(speech, { channel: "voice", from: session.to, requestRef: input.callSid }).catch(() => null);
    if (decided !== null) {
      reply = decided;
      tools = ["decide"];
      session.approvalsDecided.push(speech.slice(0, 120));
    } else {
      reply = await routerTurn(session, speech, input.callSid);
      tools = lastTools;
    }
  } catch (e) {
    await ledgerAppend({ kind: "call", actor: "clara", what: `morning call turn failed: ${String(e).slice(0, 160)}`, ref: input.callSid, meta: { sessionId: sid } }).catch(() => {});
    return hangupTwiml(SNAG, base);
  }

  // Anything a deferred tool finished since the last turn gets read out first.
  if (session.pendingResults.length) {
    const also = session.pendingResults.splice(0, session.pendingResults.length).map((r) => r.split("\n")[0].slice(0, 200)).join(" ");
    reply = `Also — ${also} ${reply}`;
  }
  const spoken = stripEmoji(reply.split("\n\n")[0]).replace(/https?:\/\/\S+/g, "the link is in your email").slice(0, 600).trim() || "Done.";
  await appendOwnerTurn(sid, { role: "clara", text: spoken });
  const { recordOwnerTurn } = await import("./ownerTurn");
  await recordOwnerTurn({ channel: "voice", from: session.to, userText: speech, reply: spoken, tools }).catch(() => {});
  return gatherTwiml(chunkScript(spoken, SCRIPT_CHUNK), base, sid, session.turnCount + 1);
}

let lastTools: string[] = [];

async function routerTurn(session: OwnerCallSession, speech: string, callSid: string): Promise<string> {
  const { ownerTurn, toolTags } = await import("./ownerTurn");
  lastTools = [];
  const seedHistory = await seedHistoryFor(session);
  const sid = session.sessionId;

  const run = ownerTurn({
    channel: "voice", from: session.to, text: speech, requestRef: callSid, seedHistory,
    deferSlow: (tool, args) => {
      void (async () => {
        try {
          const out = await tool.run(args, { principal: "owner", source: "voice" });
          const s = await getOwnerSession(sid);
          if (s && !s.finalized) { s.pendingResults.push(out.line); await saveOwnerSession(s); }
          await notifyOwner({ kind: "voice.deferred_result", priority: "normal", text: `From our call — ${out.line}`.slice(0, 1200), dedupeKey: `owner-call-deferred:${callSid}:${tool.name}` });
        } catch (e) {
          await notifyOwner({ kind: "voice.deferred_result", priority: "critical", text: `From our call — ${tool.name} did not complete: ${String(e).slice(0, 200)}`, dedupeKey: `owner-call-deferred-fail:${callSid}:${tool.name}` }).catch(() => {});
        }
      })();
    },
  });

  const timeout = new Promise<null>((r) => setTimeout(() => r(null), ROUTER_BUDGET_MS));
  const result = await Promise.race([run, timeout]);
  if (result === null) {
    // Let it finish detached; its answer is read out on the next turn or texted.
    void run.then(async ({ outcome }) => {
      const s = await getOwnerSession(sid);
      const line = outcome.reply.split("\n\n")[0].slice(0, 300);
      if (s && !s.finalized) { s.pendingResults.push(line); await saveOwnerSession(s); }
      else await notifyOwner({ kind: "voice.deferred_result", priority: "normal", text: `From our call — ${line}`, dedupeKey: `owner-call-late:${callSid}:${Date.now()}` }).catch(() => {});
    }).catch(() => {});
    return "I'm working on that; I'll have it for you in a moment, or by text.";
  }

  const { outcome } = result;
  lastTools = toolTags(outcome);
  if (outcome.calls.some((c) => c.name === "add_task" && c.ok)) session.tasksCreated.push(speech.slice(0, 120));
  if (outcome.calls.length || outcome.failed || outcome.clarifying) return outcome.reply;
  // Nothing to act on — plain conversation with the principal identity, never telephony.respond().
  return conversationalReply(session, speech);
}

async function endCall(session: OwnerCallSession, base: string, reason: string): Promise<string> {
  session.status = "ended";
  await appendOwnerTurn(session.sessionId, { role: "clara", text: CLOSING });
  await saveOwnerSession(session);
  void finalizeOwnerCall(session.sessionId, reason);
  return hangupTwiml(CLOSING, base);
}

// ── Finalization ───────────────────────────────────────────────────────────

export async function finalizeOwnerCall(sessionId: string, reason: string): Promise<{ ok: boolean; recap?: boolean }> {
  const s = await claimOwnerFinalize(sessionId, reason);
  if (!s) return { ok: false };
  if (s.status === "ringing" || s.status === "in-progress" || s.status === "placing") s.status = "ended";
  await saveOwnerSession(s);

  const talked = s.turns.some((t) => t.role === "user");
  await ledgerAppend({
    kind: "call", actor: "clara",
    what: `morning call ${s.status} (${reason}): ${s.turns.filter((t) => t.role === "user").length} turns, ${s.tasksCreated.length} task(s), ${s.approvalsDecided.length} decision(s)`,
    ref: s.callSid, meta: { sessionId, status: s.status, turns: s.turns.length, tasksCreated: s.tasksCreated, approvalsDecided: s.approvalsDecided, pending: s.pendingResults, purpose: s.purpose },
  }).catch(() => {});

  if (!talked || s.purpose === "dry-run" || s.status === "voicemail" || s.status === "no-answer") return { ok: true, recap: false };

  let recap = "";
  try {
    const system = await principalIdentityWithSoul();
    const transcript = s.turns.map((t) => `${t.role === "user" ? OWNER_FIRST : "Clara"}: ${t.text}`).join("\n");
    const facts = [
      s.tasksCreated.length ? `Tasks created from: ${s.tasksCreated.join("; ")}` : "No tasks created.",
      s.approvalsDecided.length ? `Decisions given: ${s.approvalsDecided.join("; ")}` : "No decisions given.",
      s.pendingResults.length ? `Still running / finished after the call: ${s.pendingResults.join("; ")}` : "",
    ].filter(Boolean).join("\n");
    recap = await complete({
      system,
      prompt: `Write the call notes for this morning's call as 4 to 6 plain sentences: what was discussed, any tasks you took, any decisions they gave, anything still running. No lists, no markdown, no codes.\n\nTranscript:\n${transcript}\n\nFacts:\n${facts}\n\nCall notes:`,
      timeoutMs: 30_000, temperature: 0.3, purpose: "brief",
    });
    recap = stripEmoji(recap).replace(/[*_#`>]+/g, "").trim();
  } catch { recap = ""; }
  if (!recap) {
    recap = `We spoke for ${s.turns.filter((t) => t.role === "user").length} turns this morning. ` +
      (s.tasksCreated.length ? `I took ${s.tasksCreated.length} task${s.tasksCreated.length === 1 ? "" : "s"}. ` : "") +
      (s.approvalsDecided.length ? `You gave ${s.approvalsDecided.length} decision${s.approvalsDecided.length === 1 ? "" : "s"}. ` : "") +
      "The full brief is in the earlier email.";
  }
  // Memory first and on its own: a failed recap email must not lose the record of the call.
  try {
    const { recordOutcome } = await import("./vaultMemory");
    await recordOutcome({ thread: `call-${s.date}`, kind: "call", status: s.pendingResults.length ? "open" : "done",
      title: `Morning call ${s.date}`, outcome: recap,
      done: `${s.turns.filter((t) => t.role === "user").length} turns; ${s.tasksCreated.length} task(s); ${s.approvalsDecided.length} decision(s).`,
      leftOff: s.pendingResults.length ? `Still running after the call: ${s.pendingResults.join("; ")}` : undefined });
  } catch { /* memory is best-effort */ }
  try {
    const cfg = await loadConfig();
    const to = cfg.principals.owner.emails[0];
    if (to) await sendMail({ to, subject: `Call notes — ${s.date}`, body: `${recap}\n\n— Clara` });
    return { ok: true, recap: true };
  } catch { return { ok: true, recap: false }; }
}

// ── Status callback handling ───────────────────────────────────────────────

export async function handleCallStatus(session: OwnerCallSession, callStatus: string, now = new Date()): Promise<string> {
  const st = callStatus.toLowerCase();
  if (st === "completed") {
    if (session.status === "ringing" || session.status === "placing") session.status = "no-answer"; // answered-by never fired
    if (session.status === "in-progress") session.status = "ended";
    await saveOwnerSession(session);
    if (session.status === "no-answer" && session.purpose !== "dry-run" && shouldRetry({ attempt: session.attempt, status: "no-answer", now })) {
      session.retryAt = new Date(now.getTime() + RETRY_AFTER_MS).toISOString();
      await saveOwnerSession(session);
      await sendSMS(session.to, "Tried calling with your brief — it's in your email. I'll try once more in 15 minutes; text me 'skip' if not.").catch(() => {});
      return "no-answer, retry scheduled";
    }
    if (session.status === "voicemail" && session.purpose !== "dry-run" && now.getHours() * 60 + now.getMinutes() < RETRY_CUTOFF.hour * 60 + RETRY_CUTOFF.minute) {
      await sendSMS(session.to, "Left you a voicemail; text 'call me' for the live version.").catch(() => {});
    }
    await finalizeOwnerCall(session.sessionId, `twilio ${st}`);
    return session.status;
  }
  if (["no-answer", "busy", "failed", "canceled"].includes(st)) {
    session.status = "no-answer";
    if (session.purpose !== "dry-run" && shouldRetry({ attempt: session.attempt, status: st, now })) {
      session.retryAt = new Date(now.getTime() + RETRY_AFTER_MS).toISOString();
      await saveOwnerSession(session);
      await sendSMS(session.to, "Tried calling with your brief — it's in your email. I'll try once more in 15 minutes; text me 'skip' if not.").catch(() => {});
      return "no-answer, retry scheduled";
    }
    await saveOwnerSession(session);
    if (session.purpose !== "dry-run") await sendSMS(session.to, "Couldn't reach you; the brief is in your email.").catch(() => {});
    await finalizeOwnerCall(session.sessionId, `twilio ${st}`);
    return "no-answer, finalized";
  }
  return `ignored ${st}`;
}

/** Owner texted "skip" after a missed call: cancel the retry. */
export async function cancelRetry(date = ymd(new Date())): Promise<boolean> {
  const s = await todaysSession(date);
  if (!s?.retryAt) return false;
  s.retryAt = undefined;
  await saveOwnerSession(s);
  await finalizeOwnerCall(s.sessionId, "retry skipped by owner");
  return true;
}

export function sessionExpired(s: OwnerCallSession, now = Date.now()): boolean {
  return now - new Date(s.startedAt).getTime() > SESSION_TTL_MS;
}
