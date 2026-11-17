// Clara — model-call ledger and spend breaker.
//
// She had NO cost accounting of any kind. `TokenUsage` and `usageSink` existed in engines.ts and
// `completeLMStudio` even called the sink — but nothing ever passed one, so it was dead code. The
// front door, polling every minute and answering every inbound SMS, was the one agent with no idea
// what it cost. FRIDAY has had a full ledger since 2.2; this is
// Clara's.
//
// ── Why this is a file and not store.modelCalls ───────────────────────────────────────────────
// FRIDAY keeps a Collection-per-entity store. Clara has no such thing — her state is the
// Obsidian vault plus loose JSON in dataDir — so this follows the convention she already has:
// append-only JSONL, exactly like ledger.ts. A ledger is append-only by nature, so the fit is
// better than a Collection would have been anyway.
//
// ── Why the recording helpers live here ───────────────────────────────────────────────────────
// Eight call sites hand-roll their own "try LM Studio, fall back to Anthropic" block — engines.ts,
// the SMS route, consolidate, documents, legal-tax, telephony, travel, gifts, business-call-brain.
// Metering only engines.ts would have produced a ledger that looked complete and captured almost
// none of her spend, which is precisely the failure this session has been hunting. So the two
// `record*` helpers below take a response object each site has ALREADY parsed and add one line at
// the site. No control flow moves, nothing re-routes, and every path is counted.

import { promises as fs } from "node:fs";
import path from "node:path";
import { loadConfig } from "./config";

export interface ModelCall {
  id: string;
  ts: string;
  engine: string;
  model?: string;
  /** Which of Clara's jobs this was — "sms", "brief", "consolidate", "legal", … */
  purpose?: string;
  tokensIn?: number;
  tokensOut?: number;
  tokensTotal?: number;
  costUsd?: number;
}

/** $/M tokens. lmstudio is local and therefore free — the row still gets written (see below). */
const ENGINE_PRICES: Record<string, { in?: number; out?: number; total?: number }> = {
  anthropic: { in: 15, out: 75 },  // opus-tier: her direct-API calls pin claude-opus-4-8
  claude: { in: 15, out: 75 },     // CLI, estimate — a subscription login reports no price
  // Gemini via the OS model setting (modelCall.ts / gemini.ts). Deliberately conservative — above
  // current Gemini Pro list prices — so an estimate can only over-count against a budget, never under.
  google: { in: 2.5, out: 15 },
  lmstudio: { total: 0 },
  ollama: { total: 0 },
};

/**
 * Per-MODEL overrides, checked before ENGINE_PRICES when `u.model` matches — the prospecting
 * engine's tier 3/tier 2-fallback calls (llm.ts) pin specific models that are NOT opus-4-8-priced:
 * claude-opus-5 ($5/$25 per MTok) for tier 3, claude-haiku-4-5 ($1/$5 per MTok) for tier 2's paid
 * fallback. Anything calling a model not listed here still falls back to the engine-level price.
 */
const MODEL_PRICES: Record<string, { in: number; out: number }> = {
  "claude-opus-5": { in: 5, out: 25 },
  "claude-haiku-4-5": { in: 1, out: 5 },
};

/** Purposes under this prefix (the prospect intelligence engine) are metered on their OWN ledger
 *  (CLARA_PROSPECT_DAY_MAX_USD below) and exempted from the general day cap and per-purpose call
 *  cap — a 1,000-company job legitimately makes far more than 300 tier-1/2 calls in a day, and its
 *  spend is bounded by each job's own budget_usd (budget.ts) and the OS's provider_requests trigger,
 *  not Clara's $15/day front-door number. */
export function isProspectPurpose(purpose: string | undefined): boolean {
  return Boolean(purpose && purpose.startsWith("prospect:"));
}

export function costFromUsage(engine: string, u: Partial<ModelCall>): number | undefined {
  if (typeof u.costUsd === "number") return u.costUsd; // engine-reported wins over the table
  const p = (u.model && MODEL_PRICES[u.model]) || ENGINE_PRICES[engine];
  if (!p) return undefined;
  if (u.tokensIn != null && u.tokensOut != null && (p.in != null || p.out != null)) {
    return (u.tokensIn / 1e6) * (p.in ?? 0) + (u.tokensOut / 1e6) * (p.out ?? 0);
  }
  if (u.tokensTotal != null && "total" in p && p.total != null) return (u.tokensTotal / 1e6) * p.total;
  return undefined;
}

async function file(): Promise<string> {
  const cfg = await loadConfig();
  await fs.mkdir(cfg.dataDir, { recursive: true });
  return path.join(cfg.dataDir, "model-calls.jsonl");
}

/**
 * Append one call. Best-effort by design and wrapped by every caller — a bookkeeping failure must
 * never break a completion, and a dropped row is a smaller problem than a dropped reply.
 */
export async function recordModelCall(call: Omit<ModelCall, "id" | "ts">): Promise<void> {
  try {
    const row: ModelCall = { ...call, id: crypto.randomUUID(), ts: new Date().toISOString() };
    if (row.costUsd == null) row.costUsd = costFromUsage(row.engine, row);
    await fs.appendFile(await file(), JSON.stringify(row) + "\n", "utf8");
  } catch { /* never break a completion over the ledger */ }
}

/**
 * Record an OpenAI-shaped response (LM Studio). Local inference is free, so this contributes $0 —
 * but the row is still written, because "how much work went to the local brain vs the paid one" is
 * a question the ledger should be able to answer, and it cannot if free calls are invisible.
 */
export async function recordLMStudioCall(
  json: unknown,
  ctx: { model?: string; purpose?: string },
): Promise<void> {
  const u = (json as { usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } })?.usage;
  await recordModelCall({
    engine: "lmstudio",
    model: ctx.model,
    purpose: ctx.purpose,
    tokensIn: u?.prompt_tokens,
    tokensOut: u?.completion_tokens,
    tokensTotal: u?.total_tokens ?? (((u?.prompt_tokens ?? 0) + (u?.completion_tokens ?? 0)) || undefined),
  });
}

/**
 * Record an Anthropic Messages API response. This is the path that actually costs money, and the
 * API reports exact input/output tokens — the highest-fidelity usage anywhere in Clara.
 */
export async function recordAnthropicCall(
  json: unknown,
  ctx: { model?: string; purpose?: string },
): Promise<void> {
  const u = (json as { usage?: { input_tokens?: number; output_tokens?: number } })?.usage;
  const tokensIn = u?.input_tokens;
  const tokensOut = u?.output_tokens;
  await recordModelCall({
    engine: "anthropic",
    model: ctx.model,
    purpose: ctx.purpose,
    tokensIn,
    tokensOut,
    tokensTotal: (tokensIn ?? 0) + (tokensOut ?? 0) || undefined,
  });
}

// ── Reading + breaker ─────────────────────────────────────────────────────────

export async function readCalls(): Promise<ModelCall[]> {
  try {
    const raw = await fs.readFile(await file(), "utf8");
    return raw.split("\n").filter(Boolean).map((l) => JSON.parse(l) as ModelCall);
  } catch {
    return [];
  }
}

const num = (v: string | undefined, d: number) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };
/**
 * Daily ceiling on Clara's own model spend. Lower than FRIDAY's $40 because most of her volume is
 * meant to be local: sensitivity.ts force-routes anything sensitive to LM Studio, and several of
 * her jobs prefer it outright. A day that blows this is usually a sign work stopped going local,
 * not that she got busier — which is exactly the thing worth a page.
 */
export const dayMaxCostUsd = () => num(process.env.CLARA_DAY_MAX_COST_USD, 15);

/**
 * The owner's calendar day (America/New_York), as YYYY-MM-DD. Every "today" bucket in this file keys
 * on it — the UTC day used before rolled over at 20:00 EDT, so the job tripwire that tripped at
 * ~09:00 held every non-exempt job through the working day and reset at dinner time (2026-09-24).
 */
const OWNER_TZ = process.env.CLARA_TZ?.trim() || "America/New_York";
const dayFmt = new Intl.DateTimeFormat("en-CA", { timeZone: OWNER_TZ, year: "numeric", month: "2-digit", day: "2-digit" });
export function localDayKey(d: Date = new Date()): string {
  const t = d.getTime();
  if (Number.isNaN(t)) return "";
  return dayFmt.format(d); // en-CA renders YYYY-MM-DD
}
const dayOf = (iso: string | undefined): string => (iso ? localDayKey(new Date(iso)) : "");

export async function spendToday(): Promise<number> {
  const today = localDayKey();
  return (await readCalls())
    .filter((c) => dayOf(c.ts) === today)
    .reduce((sum, c) => sum + (c.costUsd ?? 0), 0);
}

/** spendToday() minus prospect:* purposes — what the GENERAL $15/day cap actually watches. The
 *  prospect intelligence engine has its own ledger (prospectSpendToday/effectiveProspectDayMaxUsd
 *  below); it must never count against or be throttled by the front-door number. */
export async function spendTodayGeneral(): Promise<number> {
  const today = localDayKey();
  return (await readCalls())
    .filter((c) => dayOf(c.ts) === today && !isProspectPurpose(c.purpose))
    .reduce((sum, c) => sum + (c.costUsd ?? 0), 0);
}

/** Against the cap IN FORCE (standing budget + any same-day grant), not the standing one. */
export async function withinSpendBudget(): Promise<boolean> {
  return (await spendTodayGeneral()) < (await effectiveDayMaxUsd());
}

// ── Prospecting's own day-wide ledger ──────────────────────────────────────────
// §31/§32: one cross-job cap on everything the prospect intelligence engine spends in a day
// (discovery + AI + email/mobile lookups across every job), independent of each job's own
// budget_usd. Same same-day-grant mechanism as the general cap, via grantIncrease("prospectBudget", …).
export const prospectDayMaxUsd = () => num(process.env.CLARA_PROSPECT_DAY_MAX_USD, 40);

export async function prospectSpendToday(): Promise<number> {
  const today = localDayKey();
  return (await readCalls())
    .filter((c) => dayOf(c.ts) === today && isProspectPurpose(c.purpose))
    .reduce((sum, c) => sum + (c.costUsd ?? 0), 0);
}

export async function withinProspectDayBudget(): Promise<boolean> {
  return (await prospectSpendToday()) < (await effectiveProspectDayMaxUsd());
}

/** Today's calls and cost per engine — the local-vs-paid split. */
export async function spendByEngineToday(): Promise<Record<string, { calls: number; costUsd: number }>> {
  const today = localDayKey();
  const out: Record<string, { calls: number; costUsd: number }> = {};
  for (const c of await readCalls()) {
    if (dayOf(c.ts) !== today) continue;
    const row = out[c.engine] ?? { calls: 0, costUsd: 0 };
    row.calls += 1;
    row.costUsd += c.costUsd ?? 0;
    out[c.engine] = row;
  }
  return out;
}

/** Today's cost grouped by job, so an expensive day can be traced to what caused it. */
export async function spendByPurposeToday(): Promise<Record<string, { calls: number; costUsd: number }>> {
  const today = localDayKey();
  const out: Record<string, { calls: number; costUsd: number }> = {};
  for (const c of await readCalls()) {
    if (dayOf(c.ts) !== today) continue;
    const k = c.purpose ?? "unattributed";
    const row = out[k] ?? { calls: 0, costUsd: 0 };
    row.calls += 1;
    row.costUsd += c.costUsd ?? 0;
    out[k] = row;
  }
  return out;
}

// ── Per-job call ceiling ─────────────────────────────────────────────────────
// FRIDAY has taskOverBudget() — 25 calls or $5 per task — and Clara never had an equivalent. Her
// runaway shape is a job whose call count scales with INPUT VOLUME rather than with a fixed number
// of steps: one inbox-zero pass made 54 classify() calls because 54 messages were eligible. That is
// healthy at 54 and a bug at 5,000, and nothing would have stopped the second case.
//
// Counted per purpose per day rather than per invocation, deliberately. Per-invocation counting
// would need a correlation id threaded through all 16 call sites; per-purpose-per-day catches the
// failure that actually matters (a job looping) without that plumbing, and for jobs that run once
// or twice a day the two are nearly the same number anyway.

/** Ceiling on how many model calls any single job may make in a day. Generous — this is a
 *  runaway guard, not a budget. Inbox-zero legitimately does ~50-60 on a busy morning. */
export const jobMaxCallsPerDay = () => num(process.env.CLARA_JOB_MAX_CALLS, 300);

export async function callsForPurposeToday(purpose: string): Promise<number> {
  const today = localDayKey();
  return (await readCalls()).filter((c) => dayOf(c.ts) === today && c.purpose === purpose).length;
}

/** True when a job has blown its per-day call ceiling — check before starting an expensive pass.
 *  `prospect:*` purposes are exempt (see isProspectPurpose): a 1,000-company deep job legitimately
 *  makes far more than 300 tier-1/2 calls, and is bounded by its own budget_usd + CLARA_PROSPECT_DAY_MAX_USD instead. */
export async function jobOverCallBudget(purpose: string): Promise<boolean> {
  if (isProspectPurpose(purpose)) return false;
  return (await callsForPurposeToday(purpose)) >= (await effectiveJobMaxCalls());
}

// ── Daily job counter ────────────────────────────────────────────────────────
// A tripwire for something re-firing in a loop, NOT a throttle. Clara's job count is near-constant
// day to day, so a cap anywhere near the baseline would simply kill whichever job happens to run
// last — on an ordinary evening, the 20:30 brief.
//
// Sizing it needs the real number. Measured from job-runs.jsonl on 2026-09-24 (the earlier table
// here guessed ~837/day and was wrong by 5x — the cap tripped at ~09:00 every day for a week):
//
//   overnight-worker      every 5 min (was 2)  = 288/day
//   delegation-watch      every 5 min (was 2)  = 288/day
//   portal-ticket-triage  every 2 min          = 720/day
//   email-commands        every 3 min          = 480/day
//   client-email-triage   every 4 min          = 360/day
//   scope-escalation      every 5 min          = 288/day
//   outbound-flush        every 5 min          = 288/day
//   routing-clarify-watch every 5 min          = 288/day
//   transcribe-pending    every 10 min         = 144/day
//   meeting-ingest        every 10 min         = 144/day
//   sync-tasks-work       every 15 min         =  96/day
//   drive-activity-scan   every 15 min         =  96/day
//   scorecard             every 15 min         =  96/day
//   approval/decision ask every 30 min         =  48/day
//   scans, briefs, syncs, weekly work           ~100/day
//   ------------------------------------------------------
//   non-exempt total      ~3,700/day after the 5-min trims (~4,600 before), plus the exempt OS polls.
//
// 9,000 is ~2x the pre-trim baseline: normal operation never reaches it, a runaway is still caught
// the same day. The day key is the OWNER's calendar day (localDayKey), so a trip resets at local
// midnight, not at 20:00 EDT.
export const dailyJobCap = () => num(process.env.CLARA_DAILY_JOB_CAP, 9000);

interface JobRun { ts: string; name: string }

async function jobFile(): Promise<string> {
  const cfg = await loadConfig();
  await fs.mkdir(cfg.dataDir, { recursive: true });
  return path.join(cfg.dataDir, "job-runs.jsonl");
}

let lastRotatedDay = "";
/** Keep job-runs.jsonl to the last two owner-days. It is parsed in full on every non-exempt tick. */
async function rotateJobRuns(file: string, today: string): Promise<void> {
  if (lastRotatedDay === today) return;
  lastRotatedDay = today;
  try {
    const raw = await fs.readFile(file, "utf8");
    const keep: string[] = [];
    const cutoff = new Date(Date.now() - 2 * 24 * 3600_000);
    for (const line of raw.split("\n")) {
      if (!line) continue;
      try {
        const ts = (JSON.parse(line) as JobRun).ts;
        if (ts && new Date(ts) >= cutoff) keep.push(line);
      } catch { /* drop torn line */ }
    }
    const tmp = `${file}.tmp`;
    await fs.writeFile(tmp, keep.length ? keep.join("\n") + "\n" : "", "utf8");
    await fs.rename(tmp, file);
  } catch { /* rotation is housekeeping — never block a job on it */ }
}

// Appends and the once-a-day rotation share one file; serialise them so an append cannot land
// between the rotation's read and its rename (where it would be lost).
let jobRunWrites: Promise<void> = Promise.resolve();
export async function recordJobRun(name: string): Promise<void> {
  const next = jobRunWrites.then(async () => {
    try {
      const file = await jobFile();
      await rotateJobRuns(file, localDayKey());
      await fs.appendFile(file, JSON.stringify({ ts: new Date().toISOString(), name } as JobRun) + "\n", "utf8");
    } catch { /* never break a job over its own bookkeeping */ }
  });
  jobRunWrites = next.catch(() => {});
  await next;
}

export async function jobsToday(): Promise<number> {
  try {
    const raw = await fs.readFile(await jobFile(), "utf8");
    const today = localDayKey();
    let n = 0;
    for (const line of raw.split("\n")) {
      if (!line) continue;
      // Parse rather than slicing at a byte offset: the offset trick breaks the moment the field
      // order or a key length changes, and it would fail by silently counting zero.
      try {
        if (dayOf((JSON.parse(line) as JobRun).ts) === today) n++;
      } catch { /* skip a torn line rather than losing the whole count */ }
    }
    return n;
  } catch {
    return 0;
  }
}

export async function withinJobBudget(): Promise<boolean> {
  return (await jobsToday()) < (await effectiveDailyJobCap());
}

// ── Same-day grants (all three ceilings) ─────────────────────────────────────
// Same dated-record design as FRIDAY: one grant covering every ceiling, expiring by
// construction because it is keyed to the date. Clara grants her own rather than being asked over
// HTTP — she is the one holding the phone conversation.

interface DailyOverride {
  date: string;
  extraUsd?: number;
  extraJobs?: number;
  extraJobCalls?: number;
  /** Same-day grant on top of CLARA_PROSPECT_DAY_MAX_USD — kept separate from extraUsd so a
   *  prospecting grant never silently widens the general $15/day cap or vice versa. */
  extraProspectUsd?: number;
  grantedBy: string;
  grantedAt: string;
  reason?: string;
}

async function overrideFile(): Promise<string> {
  const cfg = await loadConfig();
  await fs.mkdir(cfg.dataDir, { recursive: true });
  return path.join(cfg.dataDir, "daily-override.json");
}

async function readOverride(): Promise<DailyOverride | null> {
  try {
    const o = JSON.parse(await fs.readFile(await overrideFile(), "utf8")) as DailyOverride;
    return o?.date === localDayKey() ? o : null;
  } catch {
    return null;
  }
}

async function writeOverride(patch: Partial<DailyOverride>, grantedBy: string, reason?: string): Promise<void> {
  const current = await readOverride();
  const next: DailyOverride = {
    date: localDayKey(),
    extraUsd: patch.extraUsd ?? current?.extraUsd,
    extraJobs: patch.extraJobs ?? current?.extraJobs,
    extraJobCalls: patch.extraJobCalls ?? current?.extraJobCalls,
    extraProspectUsd: patch.extraProspectUsd ?? current?.extraProspectUsd,
    grantedBy, grantedAt: new Date().toISOString(), reason,
  };
  const p = await overrideFile();
  const tmp = `${p}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(next, null, 2), "utf8");
  await fs.rename(tmp, p);
}

// OS per-agent limits (agentSettings.ts) can only NARROW these: the cap in force is the lower of
// (env cap + same-day grant) and the OS value. daily_budget_usd narrows both the general and the
// prospecting day caps; max_calls_per_day narrows the per-job call ceiling. Null = env cap alone.
async function osLimits() {
  const { getAgentSettings } = await import("./agentSettings");
  return (await getAgentSettings()).root.limits;
}
export async function effectiveDayMaxUsd(): Promise<number> {
  const { narrowCap } = await import("./agentSettings");
  return narrowCap(dayMaxCostUsd() + ((await readOverride())?.extraUsd ?? 0), (await osLimits()).daily_budget_usd);
}
export async function effectiveDailyJobCap(): Promise<number> {
  return dailyJobCap() + ((await readOverride())?.extraJobs ?? 0);
}
export async function effectiveJobMaxCalls(): Promise<number> {
  const { narrowIntCap } = await import("./agentSettings");
  return narrowIntCap(jobMaxCallsPerDay() + ((await readOverride())?.extraJobCalls ?? 0), (await osLimits()).max_calls_per_day);
}
export async function effectiveProspectDayMaxUsd(): Promise<number> {
  const { narrowCap } = await import("./agentSettings");
  return narrowCap(prospectDayMaxUsd() + ((await readOverride())?.extraProspectUsd ?? 0), (await osLimits()).daily_budget_usd);
}

export interface GrantResult { ok: boolean; message: string }

/** Additive, so a second grant tops up rather than silently revoking the first. */
export async function grantIncrease(
  kind: "budget" | "jobs" | "calls" | "prospectBudget",
  amount: number,
  grantedBy: string,
): Promise<GrantResult> {
  if (!Number.isFinite(amount) || amount <= 0 || amount > 500) {
    return { ok: false, message: `that amount isn't valid (must be between 0 and 500).` };
  }
  const cur = await readOverride();
  if (kind === "budget") {
    const extra = Math.max(0, (cur?.extraUsd ?? 0) + amount);
    await writeOverride({ extraUsd: extra }, grantedBy, "granted by SMS");
    return { ok: true, message: `budget +$${amount.toFixed(2)} — cap now $${(await effectiveDayMaxUsd()).toFixed(2)}.` };
  }
  if (kind === "jobs") {
    const extra = Math.max(0, Math.floor((cur?.extraJobs ?? 0) + amount));
    await writeOverride({ extraJobs: extra }, grantedBy, "granted by SMS");
    return { ok: true, message: `jobs +${Math.floor(amount)} — cap now ${await effectiveDailyJobCap()}.` };
  }
  if (kind === "prospectBudget") {
    const extra = Math.max(0, (cur?.extraProspectUsd ?? 0) + amount);
    await writeOverride({ extraProspectUsd: extra }, grantedBy, "granted by SMS");
    return { ok: true, message: `prospecting budget +$${amount.toFixed(2)} — cap now $${(await effectiveProspectDayMaxUsd()).toFixed(2)}.` };
  }
  const extra = Math.max(0, Math.floor((cur?.extraJobCalls ?? 0) + amount));
  await writeOverride({ extraJobCalls: extra }, grantedBy, "granted by SMS");
  return { ok: true, message: `per-job calls +${Math.floor(amount)} — cap now ${await effectiveJobMaxCalls()}.` };
}
