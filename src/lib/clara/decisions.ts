// Clara — the plain-language decisions rail (owner-comms overhaul, 2026-09-24).
//
// The owner does not want approval codes. They want to be asked one question at a time, in words, by ONE
// voice — Clara — on behalf of the whole team, and to answer "yes", "go ahead with the Acme Co
// report", "hold that", "send it Monday". This module owns:
//
//   * the unified pending-decision list: Clara's own approvals + FRIDAY's, each phrased
//     as a deterministic question (phraseDecision — no LLM in the ask path, so the same row always
//     reads the same way and a reply can be matched back to it);
//   * the ask pointer store (decisions-asked.json): what was asked, where, when. The rule that makes
//     "yes" unambiguous is ONE OPEN QUESTION PER CHANNEL — the most recent ask on a channel is the
//     only thing a bare yes/no on that channel can mean;
//   * resolveDecision: routes the verdict to whichever app owns the row, with provenance
//     ("owner via clara/sms") so the app's own dashboard shows who decided and how;
//   * decision-ask, the scheduler job that replaces the old SMS nudge: same-day texts ONLY for money
//     or scope items that can't wait for the brief, everything else waits for 08:00 / 08:30.
//
// Codes still exist (shortCode) — for dashboards, logs and the hidden reply-compat parser. They are
// never rendered to the owner from here.

import { promises as fs } from "node:fs";
import path from "node:path";
import { loadConfig } from "./config";
import { listPending as listOwnPending, approve as approveOwn, reject as rejectOwn, type Approval } from "./approvals";
import { fetchFridayApprovals, decideAgentApproval, type AgentApproval, type AgentName } from "./agentProxy";
import { append as ledgerAppend } from "./ledger";

export type DecisionAgent = "clara" | AgentName;
export type DecisionCategory = "money" | "scope" | "other";
export type AskChannel = "sms" | "voice" | "chat" | "email" | "brief";
export type Verdict = "approve" | "reject";

export interface Decision {
  /** Stable composite id: `${agent}:${nativeId}`. */
  id: string;
  agent: DecisionAgent;
  nativeId: string;
  /** The owning app's own action/title — what reference matching runs against. */
  title: string;
  /** One sentence, plain English, no codes: "Send Dana the Acme Co report?" */
  question: string;
  /** Why now, one clause: "Sprint 2 wrapped last night". */
  why: string;
  /** Up to ~300 chars of detail for chat/email/brief. */
  context?: string;
  options: ["yes", "no"];
  /** What happens on silence: "I'll hold it" / "it expires Friday". */
  defaultIfIgnored: string;
  category: DecisionCategory;
  amountUsd?: number;
  subject?: { project?: string; client?: string };
  requestedAt: string;
  expiresAt?: string;
  askedAt?: string;
  askedVia?: AskChannel;
  /** The source row, never rendered. */
  raw: unknown;
}

export const decisionIdFor = (agent: DecisionAgent, nativeId: string): string => `${agent}:${nativeId}`;
export function splitDecisionId(id: string): { agent: DecisionAgent; nativeId: string } | null {
  const m = id.match(/^(clara|friday):(.+)$/);
  return m ? { agent: m[1] as DecisionAgent, nativeId: m[2] } : null;
}

// ── Phrasing (pure) ─────────────────────────────────────────────────────────

const stripEmoji = (s: string) => s.replace(/[\p{Extended_Pictographic}️‍]/gu, "").replace(/\s{2,}/g, " ").trim();
const tidy = (s: string) => stripEmoji(s).replace(/\s*\(#[0-9A-Z]{3,6}\)\s*/g, " ").replace(/\[#[0-9A-Z]{3,6}\]\s*/g, "").replace(/\s+/g, " ").trim().replace(/[.?!]+$/, "");
const lowerFirst = (s: string) => (s ? s.charAt(0).toLowerCase() + s.slice(1) : s);
const oneSentence = (s: string | undefined, max = 140): string => {
  if (!s) return "";
  const t = stripEmoji(s).replace(/\s+/g, " ").trim();
  const first = t.split(/(?<=[.!?])\s+/)[0] ?? t;
  return first.length > max ? `${first.slice(0, max - 1).replace(/\s+\S*$/, "")}…` : first;
};
const MONEY_WORDS = /\$\s?\d|\b(budget|spend|bid|invoice|payment|charge|refund|price|pricing|contract|agreement|signature|sign(?:ing)?|proposal|quote|purchase|buy|subscription|renewal)\b/i;
const SCOPE_WORDS = /\b(out[- ]of[- ]scope|outside (?:the |our )?(?:agreed )?scope|scope change|change order|not in (?:the )?contract)\b/i;


function whenExpires(iso?: string): string | undefined {
  if (!iso) return undefined;
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return undefined;
  return t.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
}

function phraseClara(row: Approval): Pick<Decision, "question" | "why" | "context" | "category" | "amountUsd" | "subject" | "defaultIfIgnored"> {
  const title = tidy(row.title);
  const amount = row.amountUsd;
  const money = amount != null || MONEY_WORDS.test(title) || row.kind === "vendor.quote-req";
  let question: string;
  switch (row.kind) {
    case "call.business": question = `OK for me to make the call: ${title}?`; break;
    case "email.send": question = `Send this email: ${title}?`; break;
    case "drive.modify": question = `Go ahead and make this edit: ${title}?`; break;
    case "drive.trash": question = `Move this to the Drive trash: ${title}?`; break;
    case "vendor.quote-req": question = `Send the quote request: ${title}?`; break;
    case "scope.out-of-bounds": question = `This is outside the agreed scope — do you want to take it on anyway: ${title}?`; break;
    default: question = `Should I go ahead with this: ${title}?`;
  }
  return {
    question,
    why: oneSentence(row.summary) || `Queued ${new Date(row.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`,
    context: row.summary ? stripEmoji(row.summary).slice(0, 300) : undefined,
    category: row.kind === "scope.out-of-bounds" ? "scope" : money ? "money" : "other",
    amountUsd: amount,
    defaultIfIgnored: row.kind === "call.business" ? "I won't place the call" : "I'll hold it",
  };
}

function phraseAgent(agent: AgentName, a: AgentApproval): Pick<Decision, "question" | "why" | "context" | "category" | "amountUsd" | "subject" | "defaultIfIgnored" | "expiresAt"> {
  const who = agent.toUpperCase();
  const title = tidy(a.headline ?? a.title);
  const factsKind = (a.kind ?? "").toLowerCase();
  const text = `${title} ${a.summary ?? ""} ${a.detail ?? ""}`;
  let category: DecisionCategory = "other";
  if (/spend|budget|money|invoice|contract|signature/.test(factsKind) || MONEY_WORDS.test(text)) category = "money";
  else if (/scope/.test(factsKind) || SCOPE_WORDS.test(text)) category = "scope";

  let question: string;
  if (a.needsDecision?.question) question = tidy(a.needsDecision.question) + "?";

  else if (/^(send|email|publish|post|launch|enable|pause|raise|lower|increase|decrease|deploy|merge|ship|create|update|change|reply|file|book|schedule|cancel|move)\b/i.test(title)) question = `Do you want ${who} to ${lowerFirst(title)}?`;
  else question = `Should ${who} go ahead with this: ${title}?`;

  const amountMatch = `${text} ${a.fromValue ?? ""} ${a.toValue ?? ""}`.match(/\$\s?(\d[\d,]*(?:\.\d+)?)/);
  const amountUsd = a.amountUsd ?? (amountMatch ? Number(amountMatch[1].replace(/,/g, "")) : undefined);
  const exp = whenExpires(a.expiresAt);
  return {
    question: question.replace(/\?\?$/, "?"),
    why: oneSentence(a.summary ?? a.detail) || `${who} queued it ${new Date(a.requestedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`,
    context: (a.summary ?? a.detail) ? stripEmoji(a.summary ?? a.detail ?? "").slice(0, 300) : undefined,
    category,
    amountUsd: Number.isFinite(amountUsd) ? amountUsd : undefined,
    subject: (a.projectName || a.clientName) ? { project: a.projectName, client: a.clientName } : undefined,
    defaultIfIgnored: exp ? `it expires ${exp}` : `${who} holds it`,
    expiresAt: a.expiresAt,
  };
}

/** Deterministic templating from the source row. Same row → same words, always. */
export function phraseDecision(agent: DecisionAgent, row: unknown): Decision {
  if (agent === "clara") {
    const r = row as Approval;
    return {
      id: decisionIdFor("clara", r.id), agent: "clara", nativeId: r.id, title: tidy(r.title),
      options: ["yes", "no"], requestedAt: r.createdAt, raw: r,
      ...phraseClara(r),
    };
  }
  const a = row as AgentApproval;
  return {
    id: decisionIdFor(agent, a.id), agent, nativeId: a.id, title: tidy(a.headline ?? a.title),
    options: ["yes", "no"], requestedAt: a.requestedAt, raw: a,
    ...phraseAgent(agent, a),
  };
}

const URGENCY: Record<DecisionCategory, number> = { money: 0, scope: 1, other: 2 };
/** Money first, then scope, then the rest; oldest first within a category. */
export function sortByUrgency(ds: Decision[]): Decision[] {
  return [...ds].sort((x, y) => (URGENCY[x.category] - URGENCY[y.category]) || x.requestedAt.localeCompare(y.requestedAt));
}

/** How Clara asks, per channel. Never a code, never a numbered list. */
export function renderAsk(d: Decision, channel: AskChannel): string {
  const q = d.question.replace(/\s+/g, " ").trim();
  const why = d.why ? ` ${d.why.replace(/[.]+$/, "")}.` : "";
  const dflt = ` If I don't hear back, ${d.defaultIfIgnored}.`;
  if (channel === "voice") return `${q}${why}`.trim();
  if (channel === "sms") {
    const full = `${q}${why}${dflt}`;
    return (full.length <= 300 ? full : `${q}${dflt}`).slice(0, 300);
  }
  const ctx = d.context && !d.why.startsWith(d.context.slice(0, 40)) ? ` ${d.context}` : "";
  return `${q}${why}${ctx}${dflt}`.replace(/\s+/g, " ").trim();
}

// ── Pending list ────────────────────────────────────────────────────────────

export interface PendingDecisions {
  decisions: Decision[];
  stale: Partial<Record<DecisionAgent, boolean>>;
}

export async function listPendingDecisions(): Promise<PendingDecisions> {
  const [own, friday] = await Promise.all([
    listOwnPending().catch(() => [] as Approval[]),
    fetchFridayApprovals().catch(() => ({ approvals: [] as AgentApproval[], fromCache: true })),
  ]);
  const asked = await loadAsked();
  const decorate = (d: Decision): Decision => {
    const hist = asked.byDecision[d.id];
    const last = hist?.[hist.length - 1];
    return last ? { ...d, askedAt: last.askedAt, askedVia: last.via } : d;
  };
  // scope.out-of-bounds rows belong to the client-reply path (scopeEscalation.ts: the client picks
  // "anyway" / "in scope", setScopeDecision then executes). Surfacing them here would let a "yes"
  // from the owner approve the row without a scope decision set, stranding the client's later reply.
  const ownDecidable = own.filter((r) => r.kind !== "scope.out-of-bounds");
  const decisions = sortByUrgency([
    ...ownDecidable.map((r) => phraseDecision("clara", r)),
    ...friday.approvals.map((a) => phraseDecision("friday", a)),

  ].map(decorate));
  return { decisions, stale: { friday: friday.fromCache } };
}

// ── Ask pointer store ───────────────────────────────────────────────────────

export interface AskRecord { askedAt: string; via: AskChannel; ref?: string; remindAt?: string }
export interface AskedStore {
  byDecision: Record<string, AskRecord[]>;
  lastAsked: Partial<Record<AskChannel, { id: string; askedAt: string }>>;
}

const RETAIN_MS = 14 * 24 * 3600_000;

async function askedFile(): Promise<string> {
  const cfg = await loadConfig();
  await fs.mkdir(cfg.dataDir, { recursive: true });
  return path.join(cfg.dataDir, "decisions-asked.json");
}
export async function loadAsked(): Promise<AskedStore> {
  try {
    const raw = JSON.parse(await fs.readFile(await askedFile(), "utf8")) as Partial<AskedStore>;
    return { byDecision: raw.byDecision ?? {}, lastAsked: raw.lastAsked ?? {} };
  } catch { return { byDecision: {}, lastAsked: {} }; }
}
async function saveAsked(s: AskedStore): Promise<void> {
  const cutoff = Date.now() - RETAIN_MS;
  for (const [id, list] of Object.entries(s.byDecision)) {
    const kept = list.filter((r) => Date.parse(r.askedAt) >= cutoff);
    if (kept.length) s.byDecision[id] = kept; else delete s.byDecision[id];
  }
  const f = await askedFile();
  const tmp = `${f}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(s, null, 2), "utf8");
  await fs.rename(tmp, f);
}

/** Vault-memory writes are best-effort: neither the import nor the write may interrupt decision state. */
async function rememberDecision(input: import("./vaultMemory").OutcomeInput): Promise<void> {
  try {
    const { recordOutcome } = await import("./vaultMemory");
    await recordOutcome(input);
  } catch { /* memory is best-effort */ }
}

/** Record that a question was put to the owner on a channel. Sets the channel's single open pointer. */
export async function markAsked(id: string, via: AskChannel, ref?: string, opts: { pointer?: boolean; question?: string } = {}): Promise<void> {
  const s = await loadAsked();
  const rec: AskRecord = { askedAt: new Date().toISOString(), via, ...(ref ? { ref } : {}) };
  // Vault memory: the first time a question goes out on a channel (the brief re-marks daily; that is not news).
  if (!(s.byDecision[id] ?? []).some((r) => r.via === via)) {
    await rememberDecision({ thread: `decision-${id}`, kind: "decision", status: "waiting",
      title: opts.question ?? `Question for the owner (${id})`, done: `Asked the owner by ${via}.`, next: "Wait for their answer in plain words." });
  }
  s.byDecision[id] = [...(s.byDecision[id] ?? []), rec];
  if (opts.pointer !== false) s.lastAsked[via] = { id, askedAt: rec.askedAt };
  await saveAsked(s);
}
/** The one open question on a channel, if it was asked within the window. */
export async function lastAskedOn(via: AskChannel, withinMs: number, now = Date.now()): Promise<{ id: string; askedAt: string } | null> {
  const s = await loadAsked();
  const p = s.lastAsked[via];
  if (!p) return null;
  return now - Date.parse(p.askedAt) <= withinMs ? p : null;
}
export async function askedAnywhere(id: string, withinMs: number, now = Date.now()): Promise<boolean> {
  const s = await loadAsked();
  return (s.byDecision[id] ?? []).some((r) => now - Date.parse(r.askedAt) <= withinMs);
}
/** Forget a decision (decided, deferred or gone): drops its history and any channel pointer to it. */
export async function clearAsked(id: string): Promise<void> {
  const s = await loadAsked();
  delete s.byDecision[id];
  for (const ch of Object.keys(s.lastAsked) as AskChannel[]) if (s.lastAsked[ch]?.id === id) delete s.lastAsked[ch];
  await saveAsked(s);
}
/** "Send it Monday": no decision now, re-ask at `remindAt` (decision-ask honours it). */
export async function deferDecision(id: string, remindAt: string): Promise<void> {
  await rememberDecision({ thread: `decision-${id}`, kind: "decision", status: "waiting",
    title: `Deferred until ${remindAt.slice(0, 16).replace("T", " ")}`, outcome: "The owner asked to be asked again later.", next: `Re-ask at ${remindAt}.` });
  const s = await loadAsked();
  for (const ch of Object.keys(s.lastAsked) as AskChannel[]) if (s.lastAsked[ch]?.id === id) delete s.lastAsked[ch];
  const list = s.byDecision[id] ?? [];
  const last = list[list.length - 1] ?? { askedAt: new Date().toISOString(), via: "chat" as AskChannel };
  s.byDecision[id] = [...list.slice(0, -1), { ...last, remindAt }];
  await saveAsked(s);
}
export function deferredUntil(hist: AskRecord[] | undefined, now = Date.now()): boolean {
  const last = hist?.[hist.length - 1];
  return !!last?.remindAt && Date.parse(last.remindAt) > now;
}

// ── Resolution (routes to the owning app) ───────────────────────────────────

export interface Resolved { ok: boolean; agent: DecisionAgent; title: string; line: string; status: number }

export async function resolveDecision(id: string, verdict: Verdict, by: { channel: AskChannel; note?: string }): Promise<Resolved> {
  const r = await resolveDecisionInner(id, verdict, by);
  await rememberDecision({
    thread: `decision-${id}`, kind: "decision", status: r.ok ? "done" : "waiting",
    title: `${verdict === "approve" ? "Approved" : verdict === "reject" ? "Held" : verdict}: ${r.title}`,
    outcome: `The owner said ${verdict === "approve" ? "yes" : "no"} by ${by.channel}; ${r.line}.`,
    leftOff: r.ok ? undefined : "The answer didn't go through; the question stays open.",
  });
  return r;
}

async function resolveDecisionInner(id: string, verdict: Verdict, by: { channel: AskChannel; note?: string }): Promise<Resolved> {
  const parts = splitDecisionId(id);
  if (!parts) return { ok: false, agent: "clara", title: id, line: "I couldn't tell which item that was.", status: 400 };
  const decidedBy = `owner via clara/${by.channel}`;
  if (parts.agent === "clara") {
    const row = verdict === "approve" ? await approveOwn(parts.nativeId, by.note, decidedBy) : await rejectOwn(parts.nativeId, by.note, decidedBy);
    if (!row) return { ok: false, agent: "clara", title: parts.nativeId, line: "that item is gone", status: 404 };
    if (row.status !== (verdict === "approve" ? "approved" : "rejected")) {
      return { ok: false, agent: "clara", title: row.title, line: `already ${row.status}`, status: 409 };
    }
    const line = verdict === "approve"
      ? (row.result?.ok ? "done" : `approved, but it failed: ${row.result?.error ?? "unknown error"}`)
      : "held";
    return { ok: verdict === "reject" || !!row.result?.ok, agent: "clara", title: row.title, line, status: 200 };
  }
  const r = await decideAgentApproval(parts.agent, parts.nativeId, verdict, { source: "clara", decidedBy, note: by.note });
  const who = parts.agent.toUpperCase();
  await ledgerAppend({
    kind: "action", actor: "owner",
    what: `${verdict === "approve" ? "approved" : "rejected"} ${who} item ${parts.nativeId.slice(0, 8)} (${decidedBy}) → ${r.ok ? "OK" : `HTTP ${r.status}`}`,
    meta: { agent: parts.agent, id: parts.nativeId, verdict, status: r.status },
  }).catch(() => {});
  if (r.ok) await clearAsked(id).catch(() => {});
  const line = r.ok
    ? (verdict === "approve" ? `${who} is on it` : `${who} will hold it`)
    : r.status === 409 ? `${who} says it was already decided`
      : r.status === 0 ? `${who} isn't reachable right now — I'll keep the question open`
        : `${who} refused (HTTP ${r.status}) — I'll keep the question open`;
  return { ok: r.ok, agent: parts.agent, title: id, line, status: r.status };
}

// ── decision-ask: the scheduler job that replaced the SMS nudge ─────────────

const SAME_DAY_AGE_MS = 2 * 3600_000;
const SAME_DAY_EXPIRY_MS = 24 * 3600_000;
const OPEN_QUESTION_MS = 6 * 3600_000;

/** Should this decision be texted today rather than wait for the brief? Pure. */
export function needsSameDayAsk(d: Decision, now = Date.now(), businessHours = true): boolean {
  if (d.category === "other") return false;
  const raw = d.raw as { clientWaiting?: boolean } | undefined;
  if (raw?.clientWaiting) return true;
  if (d.expiresAt && Date.parse(d.expiresAt) - now < SAME_DAY_EXPIRY_MS) return true;
  return businessHours && now - Date.parse(d.requestedAt) > SAME_DAY_AGE_MS;
}

export async function runDecisionAsk(now = Date.now()): Promise<string> {
  const { isBusinessHours } = await import("./slaTimer");
  const { decisions } = await listPendingDecisions();
  if (!decisions.length) return "nothing pending";
  const asked = await loadAsked();
  const open = await lastAskedOn("sms", OPEN_QUESTION_MS, now);
  if (open && decisions.some((d) => d.id === open.id)) return `open question on sms (${open.id.slice(0, 16)}), waiting`;

  const due = decisions.find((d) => {
    const hist = asked.byDecision[d.id];
    if (deferredUntil(hist, now)) return false;
    const last = hist?.[hist.length - 1];
    if (last?.remindAt && Date.parse(last.remindAt) <= now) return true; // deferred and now due
    if (last && now - Date.parse(last.askedAt) < OPEN_QUESTION_MS) return false; // asked recently somewhere
    return needsSameDayAsk(d, now, isBusinessHours(new Date(now)));
  });
  if (!due) return `${decisions.length} pending, none need a same-day ask`;

  const to = await (await import("./ownerPhones")).ownerDeliveryPhone();
  if (!to) return "no owner number";
  const { sendSMS } = await import("./channels");
  const { appendMessage } = await import("./messages");
  const text = renderAsk(due, "sms");
  const r = await sendSMS(to, text).catch(() => ({ ok: false }));
  if (!r.ok) return `ask failed for ${due.id.slice(0, 16)}`;
  await markAsked(due.id, "sms", undefined, { question: due.question });
  await appendMessage("clara", text, undefined, { channel: "sms", from: to, principal: true }, { kind: "asked" }).catch(() => {});
  await ledgerAppend({ kind: "sms.sent", actor: "clara", what: `asked (${due.category}): ${due.title.slice(0, 80)}`, meta: { decision: due.id } }).catch(() => {});
  return `asked ${due.id.slice(0, 16)} by sms`;
}
