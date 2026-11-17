// signals/budget.ts — the two budget gates refresh.ts enforces BEFORE running a signal (never just
// before writing its result): a per-company monthly cap and a global daily cap.
//
// PER-COMPANY MONTHLY CAP — prospect_settings.signal_budget_cents_per_company (default 15 CENTS,
// confirmed by reading the migration directly: orion/supabase/migrations/
// 20261001100300_prospect_suppressions_roles.sql's prospect_settings table — this really is a tiny,
// deliberately tight per-company monthly ceiling, not a typo). Tracked via ledger.ts's
// spendThisMonthForCompany, which sums ProviderCallRecord rows by the (PR 17-added) `companyId`
// field — the SAME local-ledger file every other prospecting cost already goes through (see
// ledger.ts's own "WHY LOCAL-FIRST" doc comment), just keyed by company instead of job since a
// signal scan has no research_job_id (it runs outside any job).
//
// GLOBAL DAILY CAP — prospect_settings.prospect_day_max_usd (default $40). DESIGN CHOICE: this
// gates ALL prospecting spend today (every provider, every job, every company — ledger.ts's
// spendTodayGlobal), not a signals-only sub-budget. prospect_settings' own column name
// ("prospect_day_max_usd", no "signal" in it) and comment ("Clara's local scheduler runs the
// minute-level work" — one shared budget, not a per-mechanism one) both read as "the account-wide
// daily ceiling," so a signal-scan tick shares the SAME cap research_tasks spend already competes
// for, rather than carving out its own signals-only fraction of it. A job burning through its daily
// budget on crawls/AI calls will correctly starve signal-scans of their share too, and vice versa —
// that's the intended, simpler behavior for one global account-wide number.

import { prospectSettingsGet as prospectSettingsGetReal } from "../osBridge";
import { spendThisMonthForCompany as spendThisMonthForCompanyReal, spendTodayGlobal as spendTodayGlobalReal } from "../ledger";

export const DEFAULT_SIGNAL_BUDGET_CENTS_PER_COMPANY = 15;
export const DEFAULT_PROSPECT_DAY_MAX_USD = 40;

export interface SignalBudgetDeps {
  prospectSettingsGet: typeof prospectSettingsGetReal;
  spendThisMonthForCompany: typeof spendThisMonthForCompanyReal;
  spendTodayGlobal: typeof spendTodayGlobalReal;
  now: () => Date;
}

export const defaultSignalBudgetDeps: SignalBudgetDeps = {
  prospectSettingsGet: prospectSettingsGetReal,
  spendThisMonthForCompany: spendThisMonthForCompanyReal,
  spendTodayGlobal: spendTodayGlobalReal,
  now: () => new Date(),
};

export interface SignalBudgetCheck {
  ok: boolean;
  reason?: "per_company_monthly_cap" | "global_daily_cap";
  spentThisMonthCents: number;
  capCentsPerCompany: number;
  spentTodayUsd: number;
  dailyCapUsd: number;
}

/**
 * Would running a signal estimated at `estCostCents` blow either budget? Checked BEFORE the signal
 * actually runs, not just before signals_add/facts_add write anything — a signal whose check
 * itself calls a paid provider (today, only review_velocity's Places Details lookup) never even
 * attempts that call once either cap is exceeded. `estCostCents<=0` (website/tech-change under
 * today's $0 crawl rates) always passes trivially — there is nothing to gate.
 */
export async function checkSignalBudget(companyId: string, estCostCents: number, deps: SignalBudgetDeps = defaultSignalBudgetDeps): Promise<SignalBudgetCheck> {
  const settings = await deps.prospectSettingsGet();
  const capCentsPerCompany = settings?.signal_budget_cents_per_company ?? DEFAULT_SIGNAL_BUDGET_CENTS_PER_COMPANY;
  const dailyCapUsd = settings?.prospect_day_max_usd ?? DEFAULT_PROSPECT_DAY_MAX_USD;

  const now = deps.now();
  const spentThisMonthCents = await deps.spendThisMonthForCompany(companyId, now);
  const spentTodayUsd = await deps.spendTodayGlobal(now);

  if (estCostCents > 0 && spentThisMonthCents + estCostCents > capCentsPerCompany) {
    return { ok: false, reason: "per_company_monthly_cap", spentThisMonthCents, capCentsPerCompany, spentTodayUsd, dailyCapUsd };
  }
  if (estCostCents > 0 && spentTodayUsd + estCostCents / 100 > dailyCapUsd) {
    return { ok: false, reason: "global_daily_cap", spentThisMonthCents, capCentsPerCompany, spentTodayUsd, dailyCapUsd };
  }
  return { ok: true, spentThisMonthCents, capCentsPerCompany, spentTodayUsd, dailyCapUsd };
}
