// Clara — understanding the owner's answer to a question she asked (owner-comms overhaul).
//
// The reply parser is deterministic and conservative, ported from FRIDAY's approvalEmail.ts
// classifier: an APPROVE must be short, question-mark-free, and lead with the yes — "can you do it
// tomorrow?" is a question, "don't do it" is a reject, "yes to the Acme Co report, hold the Initech
// bump" is two answers. The optional model tie-break can move a hedged yes to defer/reject/question;
// it can never mint an approve from nothing.
//
// Which question is the owner answering? In order: an explicit reference in the reply ("the Acme Co
// report"), then the ONE open question on this channel (decisions.ts keeps at most one), then the
// only pending item if it was asked anywhere in the last day. Anything less certain gets a one-line
// "which one — X or Y?" — never a numbered list, never a code. Money needs the first two.

import {
  listPendingDecisions, resolveDecision, renderAsk, markAsked, lastAskedOn, askedAnywhere, clearAsked, deferDecision,
  sortByUrgency, type Decision, type AskChannel,
} from "./decisions";

export type ReplyVerdict = "approve" | "reject" | "defer" | "question" | "none";
export interface Classified { verdict: ReplyVerdict; deferUntil?: string; note?: string; strong: boolean }

const APPROVE_TOKENS = /\b(yes|yep|yeah|yup|ok|okay|sure|fine|go ahead|do it|send it|ship it|proceed|confirm(?:ed)?|approved?|green ?light|sounds good|all good|go for it|absolutely|please do|make it so)\b/i;
const REJECT_LEAD = /^(no|nope|nah|hold(?: off| it| that)?|don'?t|do not|not yet|not now|leave it|skip(?: it| that)?|reject|decline|cancel|pass|never mind|nevermind|kill it|stop)\b/i;
const REJECT_TOKENS = /\b(no|nope|nah|reject(?:ed)?|decline|don'?t (?:do|send|ship|run|call|approve) (?:it|that|this)|do not (?:do|send|ship|run|call|approve)|hold (?:off|it|that|this|on)|not yet|not now|leave it|skip (?:it|that|this)|cancel (?:it|that|this))\b/i;
const TIME_PHRASE = /\b(tomorrow|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|next week|next month|later(?: today| this week)?|after (?:the |my )?\w+|end of (?:the )?(?:day|week|month)|this afternoon|this evening|in (?:an? |\d+ )?(?:hour|hours|day|days|week|weeks))\b/i;
const APPROVE_TOKENS_G = new RegExp(APPROVE_TOKENS.source, "gi");
const FILLER = /\b(please|pls|thanks|thank you|thx|then|that|it|this|with|the|one|ones|and|sir|clara|by|me|both|all|of|them|those|these|for|to|now|today|yes|yep|yeah|yup|ok|okay|sure|fine|good|great|perfect|cool|right|ahead|go)\b/gi;
const CODE_REPLY = /(^|\s)#[0-9A-F]{3,6}\b|\bapprove all\b|\breject all\b/i;

/** Quoted-mail stripper (same rules as emailCommands.stripQuoted; duplicated to avoid a module cycle). */
export function stripQuotedReply(body: string): string {
  const out: string[] = [];
  for (const line of body.split(/\r?\n/)) {
    const t = line.trim();
    if (/^On .{0,200}wrote:\s*$/.test(t)) break;
    if (/^-{2,}\s*Original Message\s*-{2,}$/i.test(t)) break;
    if (/^From:\s.+$/.test(t) && out.length > 0) break;
    if (t === "--") break;
    if (/^\s*>/.test(line)) continue;
    out.push(line);
  }
  return out.join("\n").trim();
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim().replace(/[.!,;:\s]+$/, "");
const firstWords = (s: string, n: number) => s.toLowerCase().split(/\s+/).slice(0, n).join(" ");

/** Parse a defer phrase into an ISO reminder time (local). Coarse on purpose: morning of that day. */
export function parseDeferUntil(text: string, now = new Date()): string | undefined {
  const m = text.match(TIME_PHRASE);
  if (!m) return undefined;
  const p = m[1].toLowerCase();
  const at = (d: Date, h = 8) => { const x = new Date(d); x.setHours(h, 0, 0, 0); return x; };
  const addDays = (d: Date, n: number) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
  const days = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  if (p === "tomorrow") return at(addDays(now, 1)).toISOString();
  if (p === "tonight" || p === "this evening") return at(now, 18).toISOString();
  if (p === "this afternoon") return at(now, 13).toISOString();
  if (p === "next week") { const d = addDays(now, (8 - now.getDay()) % 7 || 7); return at(d).toISOString(); }
  if (p === "next month") { const d = new Date(now); d.setMonth(d.getMonth() + 1, 1); return at(d).toISOString(); }
  if (p.startsWith("end of")) {
    // The real end of the named period, always later than now: today 17:00 (or tomorrow 08:00 once
    // that has passed), this Friday 17:00 (next Friday after that), or the month's last day 17:00.
    let d: Date;
    if (/week/.test(p)) { d = at(addDays(now, (5 - now.getDay() + 7) % 7), 17); if (d <= now) d = at(addDays(d, 7), 17); }
    else if (/month/.test(p)) { d = new Date(now.getFullYear(), now.getMonth() + 1, 0); d = at(d, 17); if (d <= now) { d = new Date(now.getFullYear(), now.getMonth() + 2, 0); d = at(d, 17); } }
    else { d = at(now, 17); if (d <= now) d = at(addDays(now, 1), 8); }
    return d.toISOString();
  }
  if (p.startsWith("later")) return new Date(now.getTime() + 4 * 3600_000).toISOString();
  const di = days.indexOf(p);
  if (di >= 0) { let n = (di - now.getDay() + 7) % 7; if (n === 0) n = 7; return at(addDays(now, n)).toISOString(); }
  const inM = p.match(/^in (an?|\d+)? ?(hour|hours|day|days|week|weeks)$/);
  if (inM) {
    const n = inM[1] && inM[1] !== "a" && inM[1] !== "an" ? Number(inM[1]) : 1;
    const ms = /hour/.test(inM[2]) ? 3600_000 : /day/.test(inM[2]) ? 86400_000 : 7 * 86400_000;
    return new Date(now.getTime() + n * ms).toISOString();
  }
  return new Date(now.getTime() + 24 * 3600_000).toISOString();
}

/**
 * What did the reply mean? Pure. `askedAgoMs` (time since the question on this channel) only
 * affects `strong`.
 */
export function classifyDecisionReply(raw: string, opts: { askedAgoMs?: number; hasReference?: boolean; now?: Date } = {}): Classified {
  const t = norm(stripQuotedReply(raw));
  if (!t) return { verdict: "question", strong: false };
  const isQuestion = t.includes("?");
  const short = t.length <= 120;
  const lead3 = firstWords(t, 3);
  const approveLead = APPROVE_TOKENS.test(lead3);
  const approveAnywhere = APPROVE_TOKENS.test(t);
  const rejectLead = REJECT_LEAD.test(t);
  const rejectAnywhere = REJECT_TOKENS.test(t) || rejectLead;
  const timed = TIME_PHRASE.test(t);
  const strong = !!opts.hasReference || (opts.askedAgoMs != null && opts.askedAgoMs <= 10 * 60_000);

  // A LEADING negation governs the sentence: "don't do it", "no, send it Monday", "do not send it"
  // are a no (or a hold-until), whatever approve words follow. Mixed signals anywhere else
  // ("yes but actually no") never decide — the safe reading is "ask".
  if (rejectLead && !isQuestion) {
    if (timed) return { verdict: "defer", deferUntil: parseDeferUntil(t, opts.now), strong };
    return { verdict: "reject", strong };
  }
  if (approveAnywhere && rejectAnywhere) return { verdict: "question", strong };
  if (rejectAnywhere) {
    if (timed && !isQuestion) return { verdict: "defer", deferUntil: parseDeferUntil(t, opts.now), strong };
    return { verdict: "reject", strong };
  }
  if (isQuestion) return { verdict: approveAnywhere || rejectAnywhere ? "question" : "none", strong };
  if (timed && (approveAnywhere || /^(maybe|let'?s|do (?:it|that|this)|send (?:it|that|this))\b/i.test(t))) {
    return { verdict: "defer", deferUntil: parseDeferUntil(t, opts.now), strong };
  }
  // A yes is only a yes when nothing else is being asked for: "ok what's the weather" leads with
  // "ok" but the rest is a request, not a reference. Strip the approve words and filler; whatever
  // is left must be nothing, or the reference that named the item.
  const residual = t.toLowerCase()
    .replace(APPROVE_TOKENS_G, " ")
    .replace(FILLER, " ")
    .replace(/[^a-z0-9$ ]+/g, " ").replace(/\s+/g, " ").trim();
  if (approveLead && short && (!residual || opts.hasReference)) return { verdict: "approve", strong };
  // "go ahead with the Acme Co report" — approve words plus a reference, no other verb clauses.
  if (approveAnywhere && short && opts.hasReference && /^(please )?(yes|yep|ok|okay|sure|go ahead|do it|send it|ship it|approve[d]?|proceed|confirm(ed)?|green ?light)\b/i.test(t)) {
    return { verdict: "approve", strong: true };
  }
  return { verdict: "none", strong };
}

// ── Reference matching ──────────────────────────────────────────────────────

const STOP = new Set(["the", "a", "an", "to", "of", "for", "on", "in", "at", "and", "or", "with", "that", "this", "it", "one", "ones", "yes", "no", "ok", "okay", "please", "go", "ahead", "do", "send", "hold", "approve", "reject", "sure", "fine", "yep", "nope", "report", "thing", "item", "request", "change", "update", "friday", "clara", "want", "you", "i", "me", "we", "them", "him", "her", "is", "are", "be", "should", "can", "could", "would", "will", "just", "not", "yet", "now", "later", "monday", "tomorrow"]);
const tokens = (s: string): Set<string> =>
  new Set(s.toLowerCase().replace(/[^a-z0-9$ ]+/g, " ").split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w)));

/** Which pending decisions does the reply name? ≥2 shared significant tokens, an exact subject name, or the amount. */
export function matchByReference(text: string, pending: Decision[]): Decision[] {
  const t = text.toLowerCase();
  const tk = tokens(text);
  const hits: Decision[] = [];
  for (const d of pending) {
    const subj = [d.subject?.project, d.subject?.client].filter((x): x is string => !!x).map((x) => x.toLowerCase());
    if (subj.some((s) => s.length > 2 && t.includes(s))) { hits.push(d); continue; }
    // A distinctive single word of the subject ("Initech", "Netlify") is enough: proper nouns are
    // how the owner refers to clients and projects in a five-word text.
    const subjWords = subj.flatMap((s) => s.split(/\s+/)).filter((w) => w.length >= 4 && !STOP.has(w) && !/^(roofing|company|inc|llc|website|site|project|client)$/.test(w));
    if (subjWords.some((w) => tk.has(w))) { hits.push(d); continue; }
    if (d.amountUsd != null && new RegExp(`\\$\\s?${Math.round(d.amountUsd)}\\b`).test(text)) { hits.push(d); continue; }
    const dk = tokens(`${d.title} ${d.question}`);
    let overlap = 0;
    for (const w of tk) if (dk.has(w)) overlap++;
    if (overlap >= 2) hits.push(d);
  }
  return hits;
}

export type Resolution =
  | { kind: "hit"; decision: Decision; via: "reference" | "last-asked" | "only-one" }
  | { kind: "clarify"; candidates: Decision[] }
  | { kind: "none" };

const LAST_ASKED_MS = 6 * 3600_000;
const ONLY_ONE_MS = 24 * 3600_000;

/** Pure target resolution. `askedAnywhereIds` = pending ids asked on any channel within 24h. */
export function resolveTarget(
  text: string,
  pending: Decision[],
  lastAsked: { id: string; askedAt: string } | null,
  askedAnywhereIds: Set<string>,
  now = Date.now(),
): Resolution {
  if (!pending.length) return { kind: "none" };
  const refs = matchByReference(text, pending);
  if (refs.length === 1) return { kind: "hit", decision: refs[0], via: "reference" };
  if (refs.length > 1) return { kind: "clarify", candidates: sortByUrgency(refs).slice(0, 2) };
  if (lastAsked && now - Date.parse(lastAsked.askedAt) <= LAST_ASKED_MS) {
    const d = pending.find((p) => p.id === lastAsked.id);
    if (d) return { kind: "hit", decision: d, via: "last-asked" };
  }
  if (pending.length === 1 && askedAnywhereIds.has(pending[0].id)) return { kind: "hit", decision: pending[0], via: "only-one" };
  return { kind: "clarify", candidates: sortByUrgency(pending).slice(0, 2) };
}

/** Money must be resolved by an explicit reference or the question just asked on this channel. */
export function moneyGuardPasses(r: Resolution): boolean {
  if (r.kind !== "hit") return false;
  if (r.decision.category !== "money") return true;
  return r.via === "reference" || r.via === "last-asked";
}

// ── The fast path ───────────────────────────────────────────────────────────

export function decisionsMode(): "words" | "codes" {
  return (process.env.CLARA_DECISIONS ?? "words").trim().toLowerCase() === "codes" ? "codes" : "words";
}

const shortTitle = (d: Decision) => d.title.length > 60 ? `${d.title.slice(0, 57).replace(/\s+\S*$/, "")}…` : d.title;

function clarifyLine(cands: Decision[]): string {
  const [a, b] = cands;
  if (!b) return `Just to be sure — do you mean ${shortTitle(a)}?`;
  return `Which one — ${shortTitle(a)}, or ${shortTitle(b)}?`;
}

async function nextAskLine(exclude: Set<string>, channel: AskChannel): Promise<string> {
  const { decisions } = await listPendingDecisions();
  const next = decisions.find((d) => !exclude.has(d.id));
  if (!next) return "";
  await markAsked(next.id, channel, undefined, { question: next.question }).catch(() => {});
  return ` One more: ${renderAsk(next, channel)}`;
}

/** Split an email/chat answer that covers several items: "yes to X; hold Y" / newlines / ", and". */
export function splitClauses(text: string): string[] {
  return norm(stripQuotedReply(text))
    .split(/\s*(?:;|\n|,\s*and\s+|\.\s+(?=(?:yes|no|hold|send|go|don'?t|skip|approve|reject)\b))\s*/i)
    .map((c) => c.trim())
    .filter(Boolean);
}

export interface FastPathCtx { channel: AskChannel; from?: string; requestRef?: string; now?: number }

/**
 * Pre-router fast path: returns a reply when the turn was an answer to something Clara asked,
 * else null so the router sees the message. Only ever acts on the owner's own turns — callers gate on
 * principal before calling this.
 */
export async function tryHandleDecisionReply(text: string, ctx: FastPathCtx): Promise<string | null> {
  const now = ctx.now ?? Date.now();
  const raw = norm(stripQuotedReply(text));
  if (!raw) return null;

  // Hidden back-compat: a literal code or "approve all" still runs the old grammar (SMS only).
  if (CODE_REPLY.test(raw) && ctx.channel === "sms" && ctx.from) {
    const { tryHandleApprovalCommand } = await import("./ownerCommands");
    return tryHandleApprovalCommand(raw, ctx.from).catch(() => null);
  }
  if (decisionsMode() === "codes") return null;

  const { decisions: pending } = await listPendingDecisions();
  if (!pending.length) return null;
  const lastAsked = await lastAskedOn(ctx.channel, LAST_ASKED_MS, now).catch(() => null);
  const askedIds = new Set<string>();
  for (const d of pending) if (await askedAnywhere(d.id, ONLY_ONE_MS, now).catch(() => false)) askedIds.add(d.id);

  // Entry guard: ordinary conversation must never land here.
  const refsAny = matchByReference(raw, pending).length > 0;
  const openHere = !!lastAsked && pending.some((d) => d.id === lastAsked.id);
  const first = classifyDecisionReply(raw, { hasReference: refsAny, askedAgoMs: lastAsked ? now - Date.parse(lastAsked.askedAt) : undefined, now: new Date(now) });
  const decisive = first.verdict === "approve" || first.verdict === "reject" || first.verdict === "defer";
  if (!(refsAny || openHere || (decisive && askedIds.size > 0))) return null;

  // Several answers in one message (email/chat): each clause must name its item unless only one is pending.
  const clauses = (ctx.channel === "email" || ctx.channel === "chat") ? splitClauses(raw) : [raw];
  if (clauses.length > 1) {
    const out: string[] = [];
    const done = new Set<string>();
    for (const clause of clauses) {
      const refs = matchByReference(clause, pending.filter((d) => !done.has(d.id)));
      const target = refs.length === 1 ? refs[0] : (pending.length === 1 ? pending[0] : null);
      if (!target) { out.push(`"${clause.slice(0, 40)}" — I couldn't tell which item you meant.`); continue; }
      const c = classifyDecisionReply(clause, { hasReference: true, now: new Date(now) });
      const line = await actOn(c, target, ctx, now);
      if (line) { out.push(line); done.add(target.id); }
    }
    return out.length ? out.join(" ") : null;
  }

  const res = resolveTarget(raw, pending, lastAsked, askedIds, now);
  if (res.kind === "none") return null;
  if (res.kind === "clarify") {
    if (!decisive && !refsAny) return null; // not an answer at all — let the router have it
    for (const c of res.candidates) await markAsked(c.id, ctx.channel, ctx.requestRef, { pointer: false, question: c.question }).catch(() => {});
    return clarifyLine(res.candidates);
  }
  const c = classifyDecisionReply(raw, { hasReference: res.via === "reference", askedAgoMs: lastAsked ? now - Date.parse(lastAsked.askedAt) : undefined, now: new Date(now) });
  if (c.verdict === "question" || c.verdict === "none") {
    return openHere || refsAny ? null : null; // a question about it goes to the router, which can answer
  }
  if (!moneyGuardPasses(res)) {
    // Money resolved by "only one pending" is not good enough — ask it explicitly so the next yes
    // hits the last-asked rule.
    await markAsked(res.decision.id, ctx.channel, ctx.requestRef, { question: res.decision.question }).catch(() => {});
    return `To confirm — ${renderAsk(res.decision, ctx.channel === "brief" ? "email" : ctx.channel)}`;
  }
  return actOn(c, res.decision, ctx, now);
}

async function actOn(c: Classified, d: Decision, ctx: FastPathCtx, now: number): Promise<string | null> {
  const { appendMessage } = await import("./messages");
  const chan = ctx.channel === "brief" ? "email" : ctx.channel;
  const thread = { channel: chan as "sms" | "voice" | "email" | "chat" | "web", from: ctx.from, principal: true as const };
  const threadChannel = thread.channel === "chat" ? "web" : thread.channel;
  if (c.verdict === "defer") {
    const until = c.deferUntil ?? new Date(now + 24 * 3600_000).toISOString();
    await deferDecision(d.id, until).catch(() => {});
    const when = new Date(until).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric" });
    const line = `Noted — I'll hold ${shortTitle(d)} and ask again ${when}.`;
    await appendMessage("clara", line, undefined, { channel: threadChannel, from: ctx.from, principal: true }, { kind: "decided" }).catch(() => {});
    return line;
  }
  if (c.verdict !== "approve" && c.verdict !== "reject") return null;
  const r = await resolveDecision(d.id, c.verdict, { channel: ctx.channel, note: c.note });
  const verb = c.verdict === "approve" ? "Approved" : "Held";
  const head = r.ok ? `${verb}: ${shortTitle(d)} — ${r.line}.` : `${verb}, but ${r.line}: ${shortTitle(d)}.`;
  if (r.ok) await clearAsked(d.id).catch(() => {});
  await appendMessage("clara", head, undefined, { channel: threadChannel, from: ctx.from, principal: true }, { kind: "decided" }).catch(() => {});
  const more = r.ok ? await nextAskLine(new Set([d.id]), ctx.channel).catch(() => "") : "";
  return `${head}${more}`;
}
