// Clara — one owner conversation across every channel.
//
// Until 2026-09-24 each surface remembered differently: /chat passed the browser transcript, SMS
// passed nothing to the router (and never persisted tool turns), voice passed nothing and persisted
// nothing, email inlined a per-address block into the prompt. So "what did I text you an hour ago"
// from the desk, or a "yes" by SMS to something Clara asked on the phone, had no context to land on.
//
// This module is the single seam: read the owner's recent turns from messages.jsonl regardless of
// channel, shape them into router history, run the intent loop, and write the exchange back tagged
// with its channel. Strangers and clients never enter this path — they keep recentMessagesFor.

import { randomUUID } from "node:crypto";
import { classify } from "./sensitivity";
import { runIntent, type IntentContext, type IntentOutcome } from "./intent";
import { recentOwnerMessages, appendMessage, type StoredMessage } from "./messages";

export type OwnerChannel = "sms" | "voice" | "chat" | "email";

export interface OwnerTurnInput {
  channel: OwnerChannel;
  from?: string;
  text: string;
  requestRef?: string;
  deferSlow?: IntentContext["deferSlow"];
  onToken?: (t: string) => void;
  /**
   * Turns placed BEFORE the stored history (the morning call seeds the brief she just read so a
   * question about "the second meeting" lands). Must open on a user turn; kept out of messages.jsonl.
   */
  seedHistory?: OwnerTurnResult["history"];
}

export interface OwnerTurnResult {
  outcome: IntentOutcome;
  /** Exactly what the router was given as prior context (for tests and the ledger). */
  history: { role: "user" | "assistant"; content: string }[];
}

const DEFAULT_MAX_TURNS = 20;
const DEFAULT_MAX_CHARS = 6000;
const WINDOW_HOURS = 24;
const TOOL_REPLY_CHARS = 300;

function clock(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "America/New_York" });
}

/**
 * Pure. Turns stored rows into router history: newest last, last 24h, at most `maxTurns` turns and
 * `maxChars` characters. User turns carry a "[channel hh:mm]" prefix so the model knows where each
 * thing was said (the assistant side stays plain so it never learns to emit prefixes). Tool turns
 * collapse to "(ran: a, b) <first 300 chars>" — the outcome matters, not the prose around it. When
 * over budget, assistant ground-truth blocks after the first blank line are dropped first, then the
 * oldest turns.
 */
export function buildOwnerHistory(
  rows: StoredMessage[],
  now: number = Date.now(),
  caps: { maxTurns?: number; maxChars?: number } = {},
): OwnerTurnResult["history"] {
  const maxTurns = caps.maxTurns ?? DEFAULT_MAX_TURNS;
  const maxChars = caps.maxChars ?? DEFAULT_MAX_CHARS;
  const cutoff = now - WINDOW_HOURS * 60 * 60 * 1000;

  const recent = rows
    .filter((m) => m.principal !== false && m.text && m.text.trim() && new Date(m.ts).getTime() >= cutoff)
    .sort((a, b) => a.ts.localeCompare(b.ts))
    .slice(-maxTurns);

  const render = (m: StoredMessage, trimmed: boolean): { role: "user" | "assistant"; content: string } => {
    if (m.role === "user") {
      const ch = m.channel ?? "web";
      const t = clock(m.ts);
      return { role: "user", content: `[${ch}${t ? ` ${t}` : ""}] ${m.text.trim()}` };
    }
    let text = m.text.trim();
    if (m.tools?.length) {
      text = `(ran: ${m.tools.join(", ")}) ${text.slice(0, TOOL_REPLY_CHARS)}`;
    } else if (trimmed) {
      text = text.split("\n\n")[0];
    }
    return { role: "assistant", content: text };
  };

  let history = recent.map((m) => render(m, false));
  const size = (h: OwnerTurnResult["history"]) => h.reduce((n, t) => n + t.content.length, 0);
  if (size(history) > maxChars) history = recent.map((m) => render(m, true));
  while (history.length && size(history) > maxChars) history.shift();
  // The intent loop requires the first message to be a user turn; it drops leading assistant
  // rows itself, but dropping them here keeps `history` (returned for the ledger) honest.
  while (history.length && history[0].role !== "user") history.shift();
  return history;
}

/**
 * Run one owner turn with cross-channel memory. Never throws: a store read failure means "no
 * history", a router failure is whatever runIntent reports (it already degrades honestly). Does NOT
 * persist — the caller decides after any fallback path (recordOwnerTurn).
 */
/**
 * Recalled turns are cloud-bound context (the router and the conversational fallbacks run on hosted
 * engines), so every recalled row goes through the same sensitivity gate as a live request: a turn
 * that mentions medical, tax, banking or privileged material is left out rather than replayed.
 */
export function dropSensitiveRows(rows: StoredMessage[]): StoredMessage[] {
  return rows.filter((m) => !classify({ text: m.text }).sensitive);
}

/** The owner's recent cross-channel history, gated for cloud use. One call for every channel. */
export async function loadOwnerHistory(opts: { hours?: number; limit?: number } = {}): Promise<OwnerTurnResult["history"]> {
  const rows = await recentOwnerMessages({ hours: opts.hours ?? WINDOW_HOURS, limit: opts.limit ?? 60 }).catch(() => [] as StoredMessage[]);
  return buildOwnerHistory(dropSensitiveRows(rows));
}

/** Read-before: a user/assistant pair carrying what Clara's vault memory says about this request.
 *  Cloud-bound like the recalled history, so it goes through the same sensitivity gate; any failure
 *  (import or read) means "no memory", never a failed turn. */
export async function memorySeed(text: string): Promise<OwnerTurnResult["history"]> {
  try {
    const { memoryBlock } = await import("./vaultMemory");
    const mem = await memoryBlock({ query: text });
    if (!mem || classify({ text: mem }).sensitive) return [];
    return [{ role: "user", content: `(context) ${mem}` }, { role: "assistant", content: "Understood — I'll use that." }];
  } catch {
    return [];
  }
}

/** Join the memory seed onto the turns that follow it without two assistant turns in a row: when the
 *  next turn is the assistant's, the seed's acknowledgement is dropped. */
export function joinSeed(seed: OwnerTurnResult["history"], rest: OwnerTurnResult["history"]): OwnerTurnResult["history"] {
  if (!seed.length) return rest;
  return rest[0]?.role === "assistant" ? [seed[0], ...rest] : [...seed, ...rest];
}

/** Write-after: an owner request that ran tools becomes (or extends) a thread in vault memory. */
export async function recordOwnerRequest(channel: OwnerChannel, text: string, outcome: IntentOutcome, requestRef?: string): Promise<void> {
  if (!outcome.calls.length) return; // chit-chat is not memory
  // Sensitive requests stay out of vault memory: it is recalled into cloud-bound context later.
  if (classify({ text }).sensitive) return;
  const { recordOutcome, localStamp, slugify, shortHash } = await import("./vaultMemory");
  const day = localStamp().slice(0, 10);
  const failed = outcome.failed || outcome.calls.some((c) => !c.ok);
  // Readable prefix + a unique suffix: two same-day requests that start alike are separate threads.
  const identity = requestRef || randomUUID();
  await recordOutcome({
    thread: `owner-${day}-${slugify(text.split(/\s+/).slice(0, 7).join(" "), 40)}-${shortHash(identity, 8)}`,
    kind: "owner-request", status: outcome.clarifying ? "waiting" : failed ? "failed" : "done",
    title: text.replace(/\s+/g, " ").slice(0, 140),
    done: `Via ${channel}; ran ${outcome.calls.map((c) => `${c.name}${c.ok ? "" : " (failed)"}`).join(", ")}.`,
    outcome: memoryOutcome(outcome.reply, outcome.calls),
    leftOff: outcome.clarifying ? "Asked the owner a clarifying question." : failed ? "Something failed; see the outcome." : undefined,
  }).catch(() => {});
}

export async function ownerTurn(input: OwnerTurnInput): Promise<OwnerTurnResult> {
  const history = joinSeed(await memorySeed(input.text), [...(input.seedHistory ?? []), ...(await loadOwnerHistory())]);
  const ctx: IntentContext = {
    principal: "owner",
    source: input.channel,
    history,
    ...(input.from ? { from: input.from } : {}),
    ...(input.requestRef ? { requestRef: input.requestRef } : {}),
    ...(input.deferSlow ? { deferSlow: input.deferSlow } : {}),
    ...(input.onToken ? { onToken: input.onToken } : {}),
  };
  try {
    const outcome = await runIntent(input.text, ctx);
    await recordOwnerRequest(input.channel, input.text, outcome, input.requestRef);
    return { outcome, history };
  } catch (e) {
    return {
      outcome: {
        reply: `I hit a snag and did not act on that: ${String((e as Error)?.message ?? e).slice(0, 160)}. Nothing was changed.`,
        calls: [], failed: true, clarifying: false,
      },
      history,
    };
  }
}

/** Persist one exchange to messages.jsonl, tagged by channel, so every other surface sees it. */
export async function recordOwnerTurn(input: {
  channel: OwnerChannel;
  from?: string;
  userText: string;
  reply: string;
  tools?: string[];
  citations?: StoredMessage["citations"];
  kind?: StoredMessage["kind"];
}): Promise<void> {
  const channel: StoredMessage["channel"] = input.channel === "chat" ? "web" : input.channel;
  const info = { channel, ...(input.from ? { from: input.from } : {}), principal: true };
  if (input.userText.trim()) await appendMessage("user", input.userText, undefined, info).catch(() => {});
  if (input.reply.trim()) {
    await appendMessage("clara", input.reply, input.citations, info, { tools: input.tools, kind: input.kind }).catch(() => {});
  }
}

/** Tool-name list in the stored shape ("name" or "name!" for a failure). */
export function toolTags(outcome: IntentOutcome): string[] {
  return outcome.calls.map((c) => `${c.name}${c.ok ? "" : "!"}`);
}

/** What goes into memory: Clara's own answer, without the raw tool output (event ids, row dumps)
 *  the router appends as ground truth — that data is re-fetchable and makes notes unreadable. */
export function memoryOutcome(reply: string, calls: Array<{ resultLine?: string }> = []): string {
  // Longest first, so a result that ends with a shorter result is removed whole, not truncated.
  const lines = calls.map((c) => (c.resultLine ?? "").trim()).filter(Boolean).sort((a, b) => b.length - a.length);
  // The router appends each tool's result after the answer. Peel exact tool results off the END of
  // the reply (any length, multi-line safe); never touch text that merely resembles one.
  let text = reply.trimEnd();
  for (let changed = true; changed; ) {
    changed = false;
    for (const l of lines) {
      if (text.endsWith(l)) {
        const before = text.slice(0, text.length - l.length);
        if (before === "" || /\n\s*$/.test(before)) { text = before.trimEnd(); changed = true; break; }
      }
    }
  }
  return text.replace(/\s+/g, " ").trim().slice(0, 600);
}
