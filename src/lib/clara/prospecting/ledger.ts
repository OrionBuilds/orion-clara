// ledger.ts — the provider-call ledger: a local jsonl (today's source of truth for caching and
// per-job spend) plus a best-effort mirror to the OS `provider_requests` audit trail.
//
// WHY LOCAL-FIRST. The blueprint's design has `provider_requests` (with its budget trigger) as the
// hard cap, but that table doesn't exist until the orion migrations in this plan's Part 1 land, and
// even once it does there is no OS tool to READ a cached row back (only `provider_requests_add` and
// `provider_requests_stats`). So this ledger is the real accounting for PR 5 — cache.ts reads it,
// budget.ts's reserve check (via the orchestrator) sums it — and every write is ALSO mirrored to the
// OS (best-effort, never blocking) so nothing is lost once a read tool exists there.

import { AsyncLocalStorage } from "node:async_hooks";
import { promises as fs } from "node:fs";
import path from "node:path";

/** The job (and company) a stage handler is working for. runStage sets it so code deep in a
 *  handler — llm.ts's Anthropic calls in particular — can bill the right job without every
 *  runTier caller threading a jobId through. */
export interface SpendContext {
  jobId?: string;
  companyId?: string;
}
const spendContext = new AsyncLocalStorage<SpendContext>();
export function withSpendContext<T>(ctx: SpendContext, fn: () => Promise<T>): Promise<T> {
  return spendContext.run(ctx, fn);
}
export function currentSpendContext(): SpendContext | undefined {
  return spendContext.getStore();
}

export interface ProviderCallRecord {
  id: string;
  ts: string;
  provider: string;
  cacheKey?: string;
  jobId?: string;
  /** PR 17: signal-scan calls (review_velocity's Places Details lookup) have no research_job_id —
   *  the scan runs outside any job, company-scoped only — so they're tracked by companyId instead.
   *  Backward-compatible addition: every pre-PR-17 record simply has this undefined. */
  companyId?: string;
  costUsd: number;
  cached: boolean;
  status: "ok" | "error";
  error?: string;
  /** Small payloads only — see MAX_RESPONSE_BYTES. Dropped (not the whole record) when oversized. */
  response?: unknown;
}

const MAX_RESPONSE_BYTES = 16_000;

async function file(): Promise<string> {
  const { loadConfig } = await import("../config");
  const cfg = await loadConfig();
  const dir = path.join(cfg.dataDir, "prospecting");
  await fs.mkdir(dir, { recursive: true });
  return path.join(dir, "provider-calls.jsonl");
}

export async function recordProviderCall(input: Omit<ProviderCallRecord, "id" | "ts">): Promise<ProviderCallRecord> {
  const row: ProviderCallRecord = { ...input, id: crypto.randomUUID(), ts: new Date().toISOString() };
  if (row.response !== undefined) {
    try {
      if (JSON.stringify(row.response).length > MAX_RESPONSE_BYTES) row.response = undefined;
    } catch {
      row.response = undefined;
    }
  }
  try {
    await fs.appendFile(await file(), JSON.stringify(row) + "\n", "utf8");
  } catch {
    /* a bookkeeping failure must never break a discovery call */
  }
  try {
    const { providerRequestAdd } = await import("./osBridge");
    await providerRequestAdd(toOsProviderRequest(row));
  } catch {
    /* OS mirror is best-effort — providerRequestAdd already logs a rejected row */
  }
  return row;
}

/** Shape a ledger row for the OS `provider_requests_add` tool. Field names matter: the OS schema
 *  wants `job_id` (an unknown `research_job_id` is silently stripped, so spend never reaches the
 *  job) and an integer HTTP-style `status` (a string fails validation and the whole row is
 *  rejected). Until 2026-10-08 both were wrong, so the OS budget trigger never saw a cent. */
export function toOsProviderRequest(row: ProviderCallRecord): Record<string, unknown> {
  return {
    provider: row.provider,
    cache_key: row.cacheKey,
    cost_usd: row.costUsd,
    cached: row.cached,
    status: row.status === "ok" ? 200 : 500,
    ...(row.jobId ? { job_id: row.jobId } : {}),
    ...(row.companyId ? { company_id: row.companyId } : {}),
    ...(row.error ? { error: row.error.slice(0, 500) } : {}),
  };
}

let cachedRows: { mtimeMs: number; rows: ProviderCallRecord[] } | null = null;

export async function readProviderCalls(): Promise<ProviderCallRecord[]> {
  const p = await file();
  try {
    const st = await fs.stat(p);
    if (cachedRows && cachedRows.mtimeMs === st.mtimeMs) return cachedRows.rows;
    const raw = await fs.readFile(p, "utf8");
    const rows = raw
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l) as ProviderCallRecord;
        } catch {
          return null;
        }
      })
      .filter((r): r is ProviderCallRecord => r !== null);
    cachedRows = { mtimeMs: st.mtimeMs, rows };
    return rows;
  } catch {
    return [];
  }
}

function isToday(iso: string, now: Date): boolean {
  return iso.slice(0, 10) === now.toISOString().slice(0, 10);
}

export async function spendTodayForJob(jobId: string, now: Date = new Date()): Promise<number> {
  return (await readProviderCalls())
    .filter((r) => r.jobId === jobId && isToday(r.ts, now))
    .reduce((sum, r) => sum + r.costUsd, 0);
}

export async function totalSpendForJob(jobId: string): Promise<number> {
  return (await readProviderCalls()).filter((r) => r.jobId === jobId).reduce((sum, r) => sum + r.costUsd, 0);
}

function monthKey(iso: string): string {
  return iso.slice(0, 7); // YYYY-MM, local-vs-UTC doesn't matter for a monthly cap this loose
}

/** PR 17 — signals/budget.ts's per-company monthly cap. Cents, to match
 *  prospect_settings.signal_budget_cents_per_company (a deliberately tiny per-company figure —
 *  default 15 CENTS, not dollars). */
export async function spendThisMonthForCompany(companyId: string, now: Date = new Date()): Promise<number> {
  const key = monthKey(now.toISOString());
  const usd = (await readProviderCalls())
    .filter((r) => r.companyId === companyId && monthKey(r.ts) === key)
    .reduce((sum, r) => sum + r.costUsd, 0);
  return usd * 100;
}

/** PR 17 — signals/budget.ts's global daily cap. ALL prospecting spend today (every provider,
 *  every job, every company) — prospect_day_max_usd is the account-wide daily ceiling, not a
 *  signals-only sub-budget (see signals/budget.ts's doc comment for why). */
export async function spendTodayGlobal(now: Date = new Date()): Promise<number> {
  return (await readProviderCalls()).filter((r) => isToday(r.ts, now)).reduce((sum, r) => sum + r.costUsd, 0);
}
