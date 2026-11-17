// Clara — "how would you like me to answer?" for texts to the owner's work phone (2026-09-29).
//
// The owner's rule: anyone who texts the work phone gets an answer from Clara if she can give one;
// otherwise she texts THE OWNER (personal cell, from her own number) and asks how to respond, then sends
// the owner's answer back to them from the work number. Money, contracts and scope always come here — she
// never commits on her own.
//
// Life of an ask:
//   open (texted to the owner, or held until 07:00 in quiet hours) → one reminder after 4 business
//   hours → expired after 24 hours (it lands on the brief's callback list) — or resolved when the owner
//   answers: "I'll handle it"/"ignore" closes it quietly, anything else is relayed.
//
// One ask per thread: more texts from the same person while it's open are appended to it, not
// asked again. Each ask has a short handle ("Jackson", "0100") so the owner can answer when several are
// open; a plain reply goes to the one they were asked about most recently.
//
// Everything that decides is pure and exported for tests; the effects take injectable senders.

import { promises as fs } from "node:fs";
import path from "node:path";
import { loadConfig } from "./config";
import { OWNER_FIRST } from "./owner";
import { inImportantQuietHours } from "./importantText";

const TZ = process.env.CLARA_TZ || "America/New_York";
export const REMIND_AFTER_BUSINESS_MS = 4 * 3_600_000;
export const EXPIRE_AFTER_MS = 24 * 3_600_000;
/** A plain (un-named) reply only counts as an answer this soon after Clara last asked. */
export const PLAIN_REPLY_WINDOW_MS = 12 * 3_600_000;
export const SEND_CLAIM_MS = 2 * 60_000;
const BUSINESS_START = 8;
const BUSINESS_END = 18;

export type AskStatus = "open" | "relayed" | "handled" | "expired";

export interface WorkAsk {
  id: string;
  handle: string;            // "Jackson", "0100" — what the owner can name in a reply
  chatGuid: string;          // BlueBubbles chat to answer in
  address: string;           // their number / iMessage handle
  who: string;               // "Jackson (Acme Co)" or the number
  texts: string[];           // what they wrote, oldest first
  urgent: boolean;
  createdAt: number;
  askedAt?: number;          // when the owner was texted (unset while held for quiet hours)
  remindedAt?: number;
  /** A send in flight (claimed inside updateAsks); a stale claim is ignored after SEND_CLAIM_MS. */
  sendingAt?: number;
  status: AskStatus;
  closedAt?: number;
  answer?: string;           // what was relayed
}

export interface AskState {
  asks: WorkAsk[];
  /** The ask the owner was most recently texted about — where a plain reply goes. */
  lastPrompt?: { id: string; at: number };
}

// ── Pure ────────────────────────────────────────────────────────────────────────────────────────

export function openAsks(s: AskState): WorkAsk[] {
  return s.asks.filter((a) => a.status === "open");
}

/** First name if we have one, else the last four digits; unique among open asks. */
export function makeHandle(who: string, address: string, taken: string[]): string {
  const name = /^[+\d\s()-]+$/.test(who) || who === address ? "" : (who.match(/[A-Za-z][A-Za-z'-]*/)?.[0] ?? "");
  const base = name ? name[0].toUpperCase() + name.slice(1) : (address.replace(/\D/g, "").slice(-4) || "them");
  const lower = new Set(taken.map((t) => t.toLowerCase()));
  if (!lower.has(base.toLowerCase())) return base;
  for (let i = 2; ; i++) if (!lower.has(`${base}${i}`.toLowerCase())) return `${base}${i}`;
}

/** Add their text to the thread's open ask, or open a new one. */
export function upsertAsk(
  s: AskState,
  m: { chatGuid: string; address: string; who: string; text: string; urgent: boolean; now: number; id: string },
): { state: AskState; ask: WorkAsk; isNew: boolean } {
  const existing = s.asks.find((a) => a.status === "open" && a.chatGuid === m.chatGuid);
  if (existing) {
    const ask = { ...existing, texts: [...existing.texts, m.text].slice(-10), urgent: existing.urgent || m.urgent, who: existing.who === existing.address ? m.who : existing.who };
    return { state: { ...s, asks: s.asks.map((a) => (a.id === ask.id ? ask : a)) }, ask, isNew: false };
  }
  const ask: WorkAsk = {
    id: m.id, handle: makeHandle(m.who, m.address, openAsks(s).map((a) => a.handle)), chatGuid: m.chatGuid,
    address: m.address, who: m.who, texts: [m.text], urgent: m.urgent, createdAt: m.now, status: "open",
  };
  return { state: { ...s, asks: [...s.asks, ask] }, ask, isNew: true };
}

const quote = (t: string, n = 220) => {
  const one = t.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};

/** The text the owner gets. Plain English, no codes; the handle tells them how to point a reply. */
export function askText(ask: WorkAsk, opts: { reminder?: boolean; othersOpen?: number } = {}): string {
  const said = ask.texts.length > 1 ? ask.texts.map((t) => `"${quote(t, 140)}"`).join(" / ") : `"${quote(ask.texts[0] ?? "")}"`;
  const lead = opts.reminder ? `Still need your answer for ${ask.who}` : `${ask.who} texted your work phone`;
  const n = opts.othersOpen ?? 0;
  const tail = n > 0 ? ` (re: ${ask.handle} — ${n} other${n === 1 ? " is" : "s are"} waiting too, so start with "${ask.handle}:" to answer this one.)` : ` (re: ${ask.handle})`;
  return `${lead}: ${said}. How would you like me to respond? Reply with what to tell them, or "I'll handle it".${tail}`;
}

export type OwnerVerdict = "handle" | "relay";

/** "I'll handle it" / "ignore" / "leave it" close the ask without sending anything. */
export function classifyOwnerReply(text: string): OwnerVerdict {
  const t = text.trim().toLowerCase().replace(/[.!]+$/, "");
  if (/^(i'?ll|i will|let me|i can) (handle|take care of|deal with|call|text|reply to|get back to|answer) (it|this|that|him|her|them)\b/.test(t)) return "handle";
  if (/^(ignore( it| this| that| them)?|leave it|skip( it)?|no reply|don'?t (reply|respond|answer)|nothing|never ?mind|nvm|i got it|got it,? thanks)$/.test(t)) return "handle";
  return "relay";
}

const escapeRx = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Which open ask a reply is aimed at, and the reply with any "Jackson:" / "re Jackson" pointer removed. */
export function pickAsk(s: AskState, text: string, now: number): { ask: WorkAsk; body: string; named: boolean } | null {
  const open = openAsks(s).filter((a) => a.askedAt !== undefined);
  if (!open.length) return null;
  for (const a of open) {
    const h = escapeRx(a.handle);
    const pointer = new RegExp(`^\\s*(?:re:?\\s*${h}\\b[\\s,:—-]*|${h}\\s*[:,—-]\\s*)`, "i");
    if (pointer.test(text)) return { ask: a, body: text.replace(pointer, "").trim(), named: true };
    // "tell Jackson yes" → "tell them yes", which relayWording then unwraps.
    const addressed = new RegExp(`^(\\s*(?:please\\s+)?(?:tell|text|let|reply to|answer)\\s+)${h}\\b`, "i");
    if (addressed.test(text)) return { ask: a, body: text.replace(addressed, "$1them").trim(), named: true };
  }
  const p = s.lastPrompt;
  if (!p || now - p.at > PLAIN_REPLY_WINDOW_MS) return null;
  const ask = open.find((a) => a.id === p.id);
  return ask ? { ask, body: text.trim(), named: false } : null;
}

/** A plain reply that is really the owner asking Clara something, not an answer for the texter. */
export function looksLikeOwnerCommand(text: string): boolean {
  const t = text.trim();
  if (/^clara\b/i.test(t)) return true;
  if (/^(tell|say|let|reply|answer|text|yes|no|yeah|yep|nope|sure|ok|okay|sounds good|thursday|monday|tuesday|wednesday|friday|saturday|sunday|tomorrow|today)\b/i.test(t)) return false;
  if (/\?\s*$/.test(t) && /^(what|when|where|who|how|why|can you|could you|do i|did|is|are|any)\b/i.test(t)) return true;
  return /^(status|what'?s down|sweep|clear (my )?inbox|dials?|raise|restart|call me|skip|brief)\b/i.test(t);
}

const PRONOUNS: Array<[RegExp, string]> = [
  [/\bI'm\b/g, "they're"], [/\bI am\b/g, "they are"], [/\bI was\b/g, "they were"], [/\bI'll\b/g, "they'll"], [/\bI've\b/g, "they've"], [/\bI'd\b/g, "they'd"],
  [/\bI\b/g, "they"], [/\bme\b/g, OWNER_FIRST], [/\bmy\b/g, "their"], [/\bmine\b/g, "theirs"], [/\bmyself\b/g, "themselves"],
];

/**
 * The owner's words in Clara's voice, facts untouched: "tell him yes, Thursday 2pm works" → "the owner says yes,
 * Thursday 2pm works." Only the instruction wrapper and first-person pronouns change — times,
 * prices, dates and yes/no stay exactly as the owner wrote them.
 */
export function relayWording(raw: string): string {
  let t = raw.trim().replace(/\s+/g, " ");
  t = t.replace(/^(?:please\s+)?(?:tell|text)\s+(?:him|her|them)\s*(?:that\s+)?[:,-]?\s*/i, "");
  t = t.replace(/^(?:please\s+)?let\s+(?:him|her|them)\s+know\s*(?:that\s+)?[:,-]?\s*/i, "");
  t = t.replace(/^(?:please\s+)?(?:say|reply|respond|answer)(?:\s+with|\s+that)?\s*[:,-]?\s*/i, "");
  t = t.replace(/^["'“”]+|["'“”]+$/g, "").trim();
  if (!t) return "";
  for (const [rx, to] of PRONOUNS) t = t.replace(rx, to);
  const first = t.split(/[\s,]/)[0];
  if (/^(yes|no|yeah|yep|nope|sure|ok|okay|they|they're|they'll|they've|they'd|we|we'll|the|that|thanks|thank|sounds|works|perfect|great|absolutely|definitely|not)$/i.test(first)) t = t[0].toLowerCase() + t.slice(1);
  const ended = /[.!?]$/.test(t) ? t : `${t}.`;
  return `${OWNER_FIRST} says ${ended}`;
}

function zonedParts(d: Date, tz = TZ): { weekday: number; hour: number; minute: number } {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", hour: "numeric", minute: "numeric", hourCycle: "h23" });
  const parts = Object.fromEntries(f.formatToParts(d).map((p) => [p.type, p.value]));
  const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday);
  return { weekday: wd, hour: Number(parts.hour) % 24, minute: Number(parts.minute) };
}

/** Milliseconds of business time (Mon–Fri 08:00–18:00, America/New_York) between two instants. */
export function businessMsBetween(from: number, to: number, tz = TZ): number {
  const STEP = 5 * 60_000;
  let ms = 0;
  for (let t = from; t < to; t += STEP) {
    const { weekday, hour } = zonedParts(new Date(t), tz);
    if (weekday >= 1 && weekday <= 5 && hour >= BUSINESS_START && hour < BUSINESS_END) ms += Math.min(STEP, to - t);
  }
  return ms;
}

export type DueAction = "ask" | "remind" | "expire" | null;

/** What the tick should do for one open ask right now. */
export function dueAction(a: WorkAsk, now: number): DueAction {
  if (a.status !== "open") return null;
  if (a.askedAt === undefined) return a.urgent || !inImportantQuietHours(new Date(now)) ? "ask" : null;
  if (now - a.askedAt >= EXPIRE_AFTER_MS) return "expire";
  if (!a.remindedAt && businessMsBetween(a.askedAt, now) >= REMIND_AFTER_BUSINESS_MS && !inImportantQuietHours(new Date(now))) return "remind";
  return null;
}

// ── Persistence ─────────────────────────────────────────────────────────────────────────────────

async function stateFile(): Promise<string> {
  const cfg = await loadConfig();
  await fs.mkdir(cfg.dataDir, { recursive: true });
  return path.join(cfg.dataDir, "workline-asks.json");
}

export async function readAsks(): Promise<AskState> {
  try {
    const s = JSON.parse(await fs.readFile(await stateFile(), "utf8")) as AskState;
    return { asks: Array.isArray(s.asks) ? s.asks : [], lastPrompt: s.lastPrompt };
  } catch {
    return { asks: [] };
  }
}

let chain: Promise<unknown> = Promise.resolve();
/** Serialised read-modify-write; closed asks older than a week are dropped. */
export function updateAsks<T>(fn: (s: AskState) => { state: AskState; result: T }): Promise<T> {
  const run = chain.then(async () => {
    const { state, result } = fn(await readAsks());
    const cutoff = Date.now() - 7 * 86_400_000;
    const kept: AskState = { ...state, asks: state.asks.filter((a) => a.status === "open" || (a.closedAt ?? a.createdAt) >= cutoff) };
    const f = await stateFile();
    await fs.writeFile(`${f}.tmp`, JSON.stringify(kept, null, 1), "utf8");
    await fs.rename(`${f}.tmp`, f);
    return result;
  });
  chain = run.catch(() => {});
  return run;
}

// ── Effects ─────────────────────────────────────────────────────────────────────────────────────

export interface AskDeps {
  /** Text the owner's personal cell from Clara's number. */
  textOwner: (text: string) => Promise<boolean>;
  /** Send in the texter's thread from the work number. `text` is what actually went out (signed as Clara). */
  relay: (chatGuid: string, text: string) => Promise<{ ok: boolean; unknown?: boolean; error?: string; text?: string }>;
  /** Log to the work-line record / brief and vault memory. */
  record: (a: WorkAsk, did: string, opts: { callback: boolean; resolved?: boolean; key?: string }) => Promise<boolean>;
}

async function defaultDeps(): Promise<AskDeps> {
  return {
    textOwner: async (text) => {
      const { ownerDeliveryPhone } = await import("./ownerPhones");
      const to = await ownerDeliveryPhone();
      if (!to) {
        const cfg = await loadConfig();
        const email = cfg.principals.owner.emails[0];
        if (!email) return false;
        const { sendMail } = await import("./ms-mail");
        const r = await sendMail({ to: email, subject: "Clara: how should I answer this text?", body: text, headers: { "X-Clara-Notify": "1" } }).catch(() => ({ ok: false }));
        return r.ok;
      }
      const { sendSMS } = await import("./channels");
      const r = await sendSMS(to, text.slice(0, 900)).catch(() => ({ ok: false }));
      if (r.ok) {
        const { appendMessage } = await import("./messages");
        await appendMessage("clara", text, undefined, { channel: "sms", from: to, principal: true }).catch(() => {});
      }
      return r.ok;
    },
    relay: async (chatGuid, text) => (await import("./bluebubbles")).sendRelayText(chatGuid, text),
    record: async (a, did, opts) => {
      const { recordWorkLine } = await import("./workLineLog");
      return recordWorkLine(
        { at: new Date().toISOString(), channel: "text", from: a.address, who: a.who, need: quote(a.texts[a.texts.length - 1] ?? "", 140), did, callback: opts.callback, ...(opts.resolved ? { resolved: true } : {}), ...(opts.key ? { key: opts.key } : {}) },
        { threadKey: a.address.replace(/[^\w@.+-]/g, ""), subject: a.who === a.address ? undefined : a.who.replace(/\s*\(.*\)$/, ""), detail: `They wrote: ${a.texts.map((t) => `"${quote(t, 200)}"`).join(" / ")}` },
      );
    },
  };
}

async function deps(d?: Partial<AskDeps>): Promise<AskDeps> {
  return { ...(await defaultDeps()), ...(d ?? {}) };
}

/**
 * A work text Clara can't answer herself. Opens (or extends) the thread's ask and texts the owner now —
 * or at 07:00 if it's quiet hours and not urgent. Returns what happened, for the caller's log line.
 */
export async function askOwnerAbout(
  m: { chatGuid: string; address: string; who: string; text: string; urgent: boolean },
  opts: { now?: number; deps?: Partial<AskDeps> } = {},
): Promise<"asked" | "held" | "appended" | "failed"> {
  const now = opts.now ?? Date.now();
  const d = await deps(opts.deps);
  const { randomUUID } = await import("node:crypto");
  const { ask, isNew } = await updateAsks((s) => {
    const r = upsertAsk(s, { ...m, now, id: randomUUID() });
    return { state: r.state, result: r };
  });
  if (!isNew && ask.askedAt !== undefined) return "appended";
  if (!isNew && !ask.urgent) return "held";
  if (dueAction(ask, now) !== "ask") return "held";
  return (await sendAsk(ask.id, now, d, false)) ? "asked" : "failed";
}

/** Claim, text, then commit — only the caller that claims the ask texts the owner about it. */
async function sendAsk(id: string, now: number, d: AskDeps, reminder: boolean): Promise<boolean> {
  const claim = await updateAsks((st) => {
    const a = st.asks.find((x) => x.id === id);
    const free = a && a.status === "open" && !(a.sendingAt && now - a.sendingAt < SEND_CLAIM_MS)
      && (reminder ? a.askedAt !== undefined && !a.remindedAt : a.askedAt === undefined);
    if (!a || !free) return { state: st, result: null };
    const others = openAsks(st).filter((x) => x.id !== id && x.askedAt !== undefined).length;
    return { state: { ...st, asks: st.asks.map((x) => (x.id === id ? { ...x, sendingAt: now } : x)) }, result: { ask: a, others } };
  });
  if (!claim) return false;
  const ok = await d.textOwner(askText(claim.ask, { reminder, othersOpen: claim.others })).catch(() => false);
  await updateAsks((st) => ({
    state: {
      ...st,
      asks: st.asks.map((x) => (x.id === id ? { ...x, sendingAt: undefined, ...(ok ? (reminder ? { remindedAt: now } : { askedAt: now }) : {}) } : x)),
      lastPrompt: ok ? { id, at: now } : st.lastPrompt,
    },
    result: null,
  }));
  return ok;
}

/**
 * The owner texting Clara's number. Returns the line to text them back when the message answered an open
 * ask, or null so the normal owner path handles it. Checked before the decision rail only when a
 * decision wasn't asked more recently than this ask.
 */
export async function tryHandleWorkAskReply(
  text: string,
  opts: { now?: number; deps?: Partial<AskDeps>; lastDecisionAskAt?: number } = {},
): Promise<string | null> {
  const now = opts.now ?? Date.now();
  const s = await readAsks();
  const picked = pickAsk(s, text, now);
  if (!picked) return null;
  if (!picked.named) {
    if (looksLikeOwnerCommand(text)) return null;
    if (opts.lastDecisionAskAt !== undefined && s.lastPrompt && opts.lastDecisionAskAt > s.lastPrompt.at) return null;
  }
  const d = await deps(opts.deps);
  const { ask, body } = picked;
  const close = (status: AskStatus, answer?: string) => updateAsks((st) => {
    const asks = st.asks.map((x) => (x.id === ask.id ? { ...x, status, closedAt: now, ...(answer ? { answer } : {}) } : x));
    const next = asks.filter((x) => x.status === "open" && x.askedAt !== undefined).sort((a, b) => (b.askedAt ?? 0) - (a.askedAt ?? 0))[0];
    return { state: { asks, lastPrompt: next ? { id: next.id, at: next.remindedAt ?? next.askedAt ?? now } : undefined }, result: next };
  });
  const stillOpen = (next: WorkAsk | undefined) => (next ? ` Still waiting on you: ${next.who} (re: ${next.handle}).` : "");

  if (classifyOwnerReply(body) === "handle") {
    const next = await close("handled");
    await d.record(ask, "You said you'd handle it yourself, so I didn't reply further.", { callback: true, resolved: false });
    return `Okay — I'll leave ${ask.handle} to you.${stillOpen(next)}`;
  }
  const wording = relayWording(body);
  if (!wording) return `What should I tell ${ask.handle}? Reply with the words, or "I'll handle it".`;
  const { isOnDnc } = await import("./dnc");
  if (await isOnDnc(ask.address).catch(() => false)) {
    const next = await close("handled");
    await d.record(ask, "They've opted out of texts, so I couldn't send your answer.", { callback: true });
    return `I can't text ${ask.handle} — they opted out of texts from this number. You'll need to reach them yourself.${stillOpen(next)}`;
  }
  const sent = await d.relay(ask.chatGuid, wording);
  if (!sent.ok && !sent.unknown) {
    await d.record(ask, `Your answer didn't go out — the Mac relay refused it (${sent.error ?? "unknown"}).`, { callback: true });
    return `That didn't go through to ${ask.handle} — the Mac relay refused it (${quote(sent.error ?? "unknown error", 80)}). It's still open; reply again to retry, or reach them yourself.`;
  }
  // What went out carries her sign-off (bluebubbles.signAsClara); that is what they are shown.
  const went = sent.text ?? wording;
  const next = await close("relayed", went);
  await d.record(ask, sent.ok ? `I sent your answer: "${quote(went, 160)}"` : `I sent your answer, but the Mac didn't confirm it went out: "${quote(went, 120)}"`, { callback: false, resolved: true });
  return `${sent.ok ? "Sent" : "Sent (the Mac didn't confirm delivery)"} to ${ask.handle}: "${quote(went, 200)}"${stillOpen(next)}`;
}

/** Scheduler tick: send held asks after quiet hours, one reminder, expiry to the callback list. */
export async function workAskTick(opts: { now?: number; deps?: Partial<AskDeps> } = {}): Promise<string> {
  const now = opts.now ?? Date.now();
  const d = await deps(opts.deps);
  const s = await readAsks();
  const done: string[] = [];
  for (const a of openAsks(s)) {
    try {
      const act = dueAction(a, now);
      if (act === "ask" || act === "remind") {
        if (await sendAsk(a.id, now, d, act === "remind")) done.push(`${act} ${a.handle}`);
      } else if (act === "expire") {
        // The callback line must be durable before the ask stops being retried; its key makes a
        // retry after a failed state write a no-op instead of a second callback.
        const recorded = await d.record(a, "You didn't tell me how to answer, so I left it — it's on your callback list.", { callback: true, key: `ask-expired:${a.id}` });
        if (!recorded) { done.push(`expiry of ${a.handle} not recorded — retrying next tick`); continue; }
        await updateAsks((st) => ({ state: { ...st, asks: st.asks.map((x) => (x.id === a.id ? { ...x, status: "expired" as const, closedAt: now } : x)), lastPrompt: st.lastPrompt?.id === a.id ? undefined : st.lastPrompt }, result: null }));
        done.push(`expired ${a.handle}`);
      }
    } catch (e) {
      done.push(`${a.handle} failed (${String(e).slice(0, 80)})`);
    }
  }
  return done.length ? done.join(", ") : "nothing due";
}
