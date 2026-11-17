// Clara — read and change the other agents' autonomy dials by text.
//
// Authority mode decides whether FRIDAY proposes work or just does it. It used to live in
// .env.local, so the single most consequential setting in the operation was also the one thing that
// absolutely required sitting at the machine. FRIDAY now stores its dials as data (its own
// dials.ts) and exposes them over HTTP; this is the client, plus the SMS grammar.
//
// Clara has no dials of her own here on purpose. Her autonomy is bounded by the principal check and
// the tier table, not by a mode switch, and inventing one would be a new lever rather than a
// relocated one.

import { loadConfig } from "./config";
import { append as ledgerAppend } from "./ledger";
import { interagentAuthHeaders } from "@autom8ionlab/agent-core";

export type DialAgent = "friday";

export interface DialView {
  name: string;
  value: string;
  source: "dial" | "env" | "default";
  values: string[];
  describe: string;
  setBy?: string;
  setAt?: string;
}

async function baseFor(_agent: DialAgent): Promise<string> {
  const cfg = await loadConfig();
  return cfg.fridayBaseUrl;
}

/** FRIDAY namespaces its API under /api/friday. */
function dialsPath(_agent: DialAgent): string {
  return "/api/friday/dials";
}

export async function readDials(agent: DialAgent): Promise<DialView[] | null> {
  try {
    const r = await fetch(`${await baseFor(agent)}${dialsPath(agent)}`, {
      headers: { ...interagentAuthHeaders() },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return null;
    const j = (await r.json()) as { dials?: DialView[] };
    return j.dials ?? null;
  } catch {
    return null; // unreachable — the caller reports "couldn't ask", never a wrong value
  }
}

export interface SetDialOutcome {
  ok: boolean;
  message: string;
}

export async function writeDial(agent: DialAgent, name: string, value: string, setBy: string): Promise<SetDialOutcome> {
  try {
    const r = await fetch(`${await baseFor(agent)}${dialsPath(agent)}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...interagentAuthHeaders() },
      body: JSON.stringify({ name, value, setBy }),
      signal: AbortSignal.timeout(10_000),
    });
    const j = (await r.json().catch(() => null)) as { ok?: boolean; message?: string; error?: string } | null;
    const ok = Boolean(r.ok && j?.ok);
    await ledgerAppend({
      kind: "action", actor: "clara",
      what: `${ok ? "set" : "failed to set"} ${agent} dial ${name}=${value} (by ${setBy})`,
      meta: { agent, dial: name, value, ok: String(ok) },
    }).catch(() => {});
    return { ok, message: j?.message ?? j?.error ?? (r.ok ? "no response" : `${agent} returned ${r.status}`) };
  } catch (e) {
    return { ok: false, message: `${agent} unreachable — ${String(e).slice(0, 120)}` };
  }
}

export type InteragentAuthState = "ok" | "unauthorized" | "unreachable";

/**
 * Prove that this agent and `agent` hold the SAME interagent secret.
 *
 * Reachability is not the test, and assuming it is will mislead you: the dials GET is not
 * auth-gated, so it answers happily with the wrong secret, or none.
 *
 * The only honest probe is an authenticated WRITE. This reads a dial's current value and posts
 * that same value straight back — setDial returns early on an unchanged value, before it writes
 * the file or logs the transition, so this is a real round trip through the auth check with no
 * side effect whatsoever. A mismatch (or an unset secret on one side) comes back 401.
 */
export async function probeInteragentAuth(agent: DialAgent): Promise<InteragentAuthState> {
  const dials = await readDials(agent);
  if (!dials?.length) return "unreachable";
  const probe = dials[0];
  try {
    const r = await fetch(`${await baseFor(agent)}${dialsPath(agent)}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...interagentAuthHeaders() },
      body: JSON.stringify({ name: probe.name, value: probe.value, setBy: "interagent-auth-probe" }),
      signal: AbortSignal.timeout(8000),
    });
    if (r.status === 401) return "unauthorized";
    return r.ok ? "ok" : "unreachable";
  } catch {
    return "unreachable";
  }
}

// ── SMS grammar ───────────────────────────────────────────────────────────────────────────────

export interface DialCommand {
  agent: DialAgent;
  /** Absent = read the agent's dials rather than change one. */
  name?: string;
  value?: string;
}

const AGENT_RE = "(friday)";
// "money auto" reads naturally in a text but the dial is money_auto; both spellings are accepted.
const NAME_RE = "(authority|money[ _]auto|os[ _]tasks|os[ _]bridge)";
const VALUE_RE = "(off|shadow|active|on)";

/**
 * Parse "friday authority shadow", "friday money auto off", or the read forms
 * "friday authority" / "friday dials".
 *
 * Anchored to start with an agent name so ordinary sentences mentioning an agent cannot trip it —
 * "ask friday about the authority for that campaign" must not silently change a mode. The value
 * is enumerated rather than free text for the same reason: a typo should be rejected, not
 * interpreted.
 */
export function parseDialCommand(text: string): DialCommand | null {
  const t = text.trim().toLowerCase().replace(/[.!?]+$/, "").replace(/\s+/g, " ");

  // Read-all: "friday dials" / "friday modes"
  const readAll = new RegExp(`^${AGENT_RE} (dials|modes|settings)$`).exec(t);
  if (readAll) return { agent: readAll[1] as DialAgent };

  // Read one: "friday authority"
  const readOne = new RegExp(`^${AGENT_RE} ${NAME_RE}$`).exec(t);
  if (readOne) return { agent: readOne[1] as DialAgent, name: normalizeName(readOne[2]) };

  // Set: "friday money auto off"
  const set = new RegExp(`^${AGENT_RE} ${NAME_RE} ${VALUE_RE}$`).exec(t);
  if (set) return { agent: set[1] as DialAgent, name: normalizeName(set[2]), value: set[3] };

  return null;
}

function normalizeName(raw: string): string {
  return raw.replace(/ /g, "_");
}

/** Render an agent's dials for SMS, saying where each value came from. */
export function formatDials(agent: DialAgent, dials: DialView[], only?: string): string {
  const rows = only ? dials.filter((d) => d.name === only) : dials;
  if (!rows.length) return `${agent.toUpperCase()} has no dial called "${only}".`;
  const lines = rows.map((d) => {
    // "(env)" and "(default)" are worth showing: they mean nobody has set this remotely yet, so it
    // will revert to the env file's value if the dials file is ever lost.
    const origin = d.source === "dial" ? (d.setBy ? ` — set by ${d.setBy}` : "") : ` (${d.source})`;
    return `${d.name}: ${d.value}${origin}`;
  });
  return `${agent.toUpperCase()} — ${lines.join("\n")}`;
}

// ── Same-day spend raise ──────────────────────────────────────────────────────────────────────
// FRIDAY pages the owner when its own model-spend cap holds scheduled work. That page is
// only useful if it can be answered from the same phone, so this is the grant path: "raise friday
// budget 20" adds $20 to TODAY's cap and nothing beyond today.
//
// Deliberately NOT a dial. Dials are standing settings; this is a one-day exception that expires on
// its own. Modelling it as a dial would make the exception permanent by default, which is the exact
// failure mode the breaker exists to prevent.

export interface BudgetCommand {
  /** "clara" is handled locally — she grants her own rather than asking herself over HTTP. */
  agent: DialAgent | "clara";
  /** Exactly one is set — the ceilings are raised independently on purpose. */
  extraUsd?: number;
  extraRuns?: number;
  extraJobs?: number;
  extraCalls?: number;
}

/**
 * Parse a same-day ceiling raise, for either limit:
 *   budget — "raise friday budget 20" / "friday budget +20" / "add 20 to friday budget"
 *   runs   — "raise friday runs 25"   / "friday runs +10"   / "add 10 to friday runs"
 *
 * The amount is required in every form — no bare "raise the budget" — because the one thing that
 * must never be guessed is how much to authorise. "budget" and "runs" stay separate words rather
 * than one generic "limit" verb: they are different ceilings guarding different runaways, and a
 * text that does not say which one it means should be rejected, not interpreted.
 */
export function parseBudgetCommand(text: string): BudgetCommand | null {
  const t = text.trim().toLowerCase().replace(/[.!?]+$/, "").replace(/\s+/g, " ").replace(/\$/g, "");
  // Written as regex LITERALS, not strings passed to new RegExp. The string form needs "\\d" to
  // mean \d, and a single "\d" silently collapses to a literal "d" — which is exactly what happened
  // here and made every form fail to match while the negative cases still "passed".
  // clara adds two ceilings of her own: "jobs" (the daily scheduler tripwire) and "calls" (the
  // per-job model-call ceiling). Kept as distinct words rather than a generic "limit" for the same
  // reason as budget/runs — a text that does not say which ceiling it means gets rejected.
  const forms: Array<[RegExp, "agent-kind-amt" | "amt-agent-kind"]> = [
    [/^raise (friday|clara) (budget|runs|jobs|calls) (?:by )?(\d+(?:\.\d{1,2})?)$/, "agent-kind-amt"],
    [/^(friday|clara) (budget|runs|jobs|calls) \+?(\d+(?:\.\d{1,2})?)$/, "agent-kind-amt"],
    [/^add (\d+(?:\.\d{1,2})?) to (friday|clara) (budget|runs|jobs|calls)$/, "amt-agent-kind"],
  ];
  for (const [re, shape] of forms) {
    const m = re.exec(t);
    if (!m) continue;
    const agent = (shape === "amt-agent-kind" ? m[2] : m[1]) as DialAgent | "clara";
    const kind = shape === "amt-agent-kind" ? m[3] : m[2];
    const amount = Number(shape === "amt-agent-kind" ? m[1] : m[3]);
    if (!Number.isFinite(amount) || amount <= 0) return null;

    // Ceilings that count THINGS are whole numbers; "raise runs 2.5" is a typo, not a request for
    // half a run. Only budget keeps its decimals.
    const whole = Math.floor(amount);
    if (kind === "budget") return { agent, extraUsd: amount };
    if (kind === "runs") return { agent, extraRuns: whole };
    if (kind === "jobs") return { agent, extraJobs: whole };
    return { agent, extraCalls: whole };
  }
  return null;
}

function budgetPath(_agent: DialAgent): string {
  return "/api/friday/budget";
}

export async function readBudget(agent: DialAgent): Promise<
  {
    spentUsd: number; effectiveCapUsd: number; grantedUsd: number;
    runsToday: number; effectiveRunCap: number; grantedRuns: number;
    blocked?: string[];
  } | null
> {
  try {
    const r = await fetch(`${await baseFor(agent)}${budgetPath(agent)}`, {
      headers: { ...interagentAuthHeaders() },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

export async function grantBudget(
  agent: DialAgent,
  grant: { extraUsd?: number; extraRuns?: number },
  grantedBy: string,
): Promise<SetDialOutcome> {
  const label = grant.extraUsd != null ? `$${grant.extraUsd.toFixed(2)} budget` : `${grant.extraRuns} run(s)`;
  try {
    const r = await fetch(`${await baseFor(agent)}${budgetPath(agent)}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...interagentAuthHeaders() },
      body: JSON.stringify({ ...grant, grantedBy, reason: "granted by SMS to clear client work" }),
      signal: AbortSignal.timeout(10_000),
    });
    const j = (await r.json().catch(() => null)) as { ok?: boolean; message?: string; error?: string } | null;
    const ok = Boolean(r.ok && j?.ok);
    // Money decisions are logged whether or not they land — a refused raise is as worth knowing as
    // a granted one when reconstructing why work stalled.
    await ledgerAppend({
      kind: "action", actor: "clara",
      what: `${ok ? "granted" : "failed to grant"} ${agent} a same-day raise of ${label} (by ${grantedBy})`,
      meta: { agent, extraUsd: String(grant.extraUsd ?? ""), extraRuns: String(grant.extraRuns ?? ""), ok: String(ok) },
    }).catch(() => {});
    return { ok, message: j?.message ?? j?.error ?? (r.ok ? "no response" : `${agent} returned ${r.status}`) };
  } catch (e) {
    return { ok: false, message: `${agent} unreachable — ${String(e).slice(0, 120)}` };
  }
}
