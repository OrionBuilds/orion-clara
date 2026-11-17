// signals/refresh.ts — the scheduler job this whole framework exists for: `prospect-signal-scan`.
//
// Standalone, NOT a research_tasks pipeline stage (see stages.ts's `signal_scan` skipStub and its
// doc comment for why) — a company-level recurring scan of companies_search results, run hourly by
// Clara's local scheduler (scheduler.ts's JOBS array), same mechanism as prospecting-orchestrator.
// The OS-level `clara.prospect_signal_scan` schedule row (migration
// 20261001100300_prospect_suppressions_roles.sql) is deliberately seeded `mode:'off'` with the
// comment "Clara's local scheduler runs the minute-level work" — this file IS that local work; the
// OS row stays inert by design.
//
// TARGETING: `research_depth: "qualified"` — companies that passed AI qualification, not every bare
// discovered lead. companies_search has no direct "on an active prospect list" filter (`list_id`
// takes exactly one list, not "any list"), so this is the closest available match to the OS seed
// comment's "re-check companies on active prospect lists" intent at the granularity
// companies_search actually offers today. `order: "last_researched_at.desc"` is the closest
// available proxy for staleness-first — companies_search's `order` enum has no true
// oldest-first option.
//
// SEQUENCING (the one deliberate deviation from "independent signals"): for each company,
// website-change runs FIRST. Only when it both ran this tick AND found the homepage itself changed
// does tech-change run at all — re-scanning signatures against unchanged HTML can never produce a
// different result, so skipping it is a pure cost/time saving, not a missed detection. See
// checks/techChange.ts's header comment for the full rationale.
//
// PR 18's 5 new signals (hiring, ad_activity, new_location, leadership_change, permit_growth) have
// NO such dependency on each other or on website/tech-change — each is handled generically by the
// INDEPENDENT_SIGNAL_KEYS loop below, run AFTER the website/tech/review sequence for every company.
// NOTE for future maintainers: SIGNAL_REGISTRY is NOT a generic "iterate every registered signal"
// table on its own — website_change/tech_change/review_velocity are each called BY NAME above
// (tech_change needs website_change's own result this same tick; review_velocity's call needed no
// change). Adding a new key to SIGNAL_REGISTRY alone does NOT make refresh.ts run it; a genuinely
// independent signal (no sequencing need) also needs its key added to INDEPENDENT_SIGNAL_KEYS below.

import { prospectingMode } from "../types";
import { companiesSearch as companiesSearchReal } from "../osBridge";
import { checkSignalBudget as checkSignalBudgetReal, defaultSignalBudgetDeps, type SignalBudgetDeps } from "./budget";
import { SIGNAL_REGISTRY, signalDef } from "./registry";
import { defaultSignalRunDeps } from "./types";
import type { CompanySignalInput, SignalCadence, SignalKey, SignalRunDeps } from "./types";
import { runWebsiteChangeCheck } from "./checks/websiteChange";
import { runTechChangeCheck } from "./checks/techChange";
import { runReviewVelocityCheck } from "./checks/reviewVelocity";

/** Keeps a single scheduler tick fast — see scheduler.ts's JOBS doc comment on why every detached
 *  job keeps its own tick bounded. 100 sits in the middle of the plan's suggested 50-200 range. */
export const BATCH_SIZE = 100;

/** PR 18 — every signal with no sequencing dependency on another signal this same tick. Each one is
 *  gated purely by its OWN cadence + budget (signalDef(key)'s own cost_cents_est), via the single
 *  generic loop in signalRefreshTick below. See this file's header comment for why this is separate
 *  from website_change/tech_change/review_velocity's by-name calls. */
export const INDEPENDENT_SIGNAL_KEYS: SignalKey[] = ["hiring", "ad_activity", "new_location", "leadership_change", "permit_growth"];

export const CADENCE_MS: Record<SignalCadence, number> = {
  hourly: 3600_000,
  daily: 24 * 3600_000,
  weekly: 7 * 24 * 3600_000,
};

export interface RefreshDeps {
  companiesSearch: typeof companiesSearchReal;
  checkSignalBudget: (companyId: string, estCostCents: number) => ReturnType<typeof checkSignalBudgetReal>;
  signalRunDeps: SignalRunDeps;
  now: () => Date;
}

export const defaultRefreshDeps: RefreshDeps = {
  companiesSearch: companiesSearchReal,
  checkSignalBudget: (companyId, estCostCents) => checkSignalBudgetReal(companyId, estCostCents, defaultSignalBudgetDeps as SignalBudgetDeps),
  signalRunDeps: defaultSignalRunDeps,
  now: () => new Date(),
};

export interface SignalRefreshTickResult {
  scanned: number;
  signals_fired: number;
  budget_stopped: number;
  notes: string[];
}

/** companies_search's real OS shape is `{rows, total, page_size, offset}` (confirmed reading
 *  orion/mcp-server/src/tools/prospects.ts directly) — NOT a bare array, unlike several other
 *  osBridge calls. Defensive about both shapes the same way companiesGet/prospectSettingsGet are
 *  about their own envelopes, so this actually works against a running OS rather than silently
 *  scanning nothing (the failure mode stages.ts's own companiesSearch callers have today, since
 *  they only check `Array.isArray`). */
function extractCompanyRows(raw: unknown): CompanySignalInput[] {
  let arr: unknown[] = [];
  if (Array.isArray(raw)) arr = raw;
  else if (raw && typeof raw === "object" && Array.isArray((raw as { rows?: unknown }).rows)) arr = (raw as { rows: unknown[] }).rows;

  const companies: CompanySignalInput[] = arr.map((r) => {
    const x = (r ?? {}) as Record<string, unknown>;
    return {
      id: typeof x.id === "string" ? x.id : "",
      name: typeof x.name === "string" ? x.name : undefined,
      website_url: typeof x.website_url === "string" ? x.website_url : undefined,
      google_place_id: typeof x.google_place_id === "string" ? x.google_place_id : undefined,
      // PR 18 — permit_growth's county lookup (pickPermitJurisdiction) and, as a query-quality
      // nicety, hiring/ad_activity/new_location's search queries. Optional/additive — PR 17's own 3
      // checks never read these two fields.
      city: typeof x.city === "string" ? x.city : undefined,
      state: typeof x.state === "string" ? x.state : undefined,
    };
  });
  return companies.filter((c) => Boolean(c.id));
}

function isDue(lastCheckedIso: string | undefined, cadenceMs: number, now: Date): boolean {
  if (!lastCheckedIso) return true; // never checked for this company — always due
  const t = Date.parse(lastCheckedIso);
  if (!Number.isFinite(t)) return true;
  return now.getTime() - t >= cadenceMs;
}

async function lastCheckedAt(companyId: string, fieldName: string, deps: SignalRunDeps): Promise<string | undefined> {
  const rows = await deps.factsList({ subject_type: "company", subject_id: companyId, field_name: fieldName });
  return rows[0]?.observed_at;
}

export async function signalRefreshTick(deps: RefreshDeps = defaultRefreshDeps): Promise<SignalRefreshTickResult> {
  const res: SignalRefreshTickResult = { scanned: 0, signals_fired: 0, budget_stopped: 0, notes: [] };

  // TWO independent gates, both honored: scheduler.ts's CLARA_SIGNAL_SCAN decides whether this tick
  // fires AT ALL (matches() — the kill switch for signal-scanning specifically); CLARA_PROSPECTING's
  // shared off|shadow|active mode (read here) decides, if it DOES fire, whether it's a no-op (off —
  // e.g. the whole OS prospect surface is disabled), shadow-safe (writes facts/signals but never
  // pays for a Places Details call), or fully live. Either flag alone can stop this job; neither
  // one papering over the other is a bug.
  const mode = prospectingMode();
  if (mode === "off") {
    res.notes.push("prospecting mode off — signal-scan tick is a no-op");
    return res;
  }

  // One allowLive decision for the whole tick (prospectingMode()==="active" — "shadow" never makes
  // a paid call, same convention every other prospecting stage uses).
  const signalRunDeps: SignalRunDeps = { ...deps.signalRunDeps, allowLive: mode === "active" };
  const now = signalRunDeps.now();

  let rawCompanies: unknown;
  try {
    rawCompanies = await deps.companiesSearch({ research_depth: "qualified", order: "last_researched_at.desc", limit: BATCH_SIZE });
  } catch (e) {
    res.notes.push(`companiesSearch failed: ${e instanceof Error ? e.message : String(e)}`);
    return res;
  }
  const companies = extractCompanyRows(rawCompanies);

  const websiteDef = signalDef("website_change");
  const techDef = signalDef("tech_change");
  const reviewDef = signalDef("review_velocity");
  if (!websiteDef || !techDef || !reviewDef) {
    res.notes.push("signal registry missing an expected entry — tick aborted");
    return res;
  }
  const independentDefs = INDEPENDENT_SIGNAL_KEYS.map((k) => signalDef(k));
  if (independentDefs.some((d) => !d)) {
    res.notes.push("signal registry missing an expected entry — tick aborted");
    return res;
  }

  for (const company of companies) {
    res.scanned++;

    // ── website_change (home + services + financing; also feeds tech_change's sequencing) ─────
    let homepageChanged: boolean | undefined;
    let homepageHtml: string | undefined;
    const websiteLastChecked = await lastCheckedAt(company.id, websiteDef.lastCheckedField, signalRunDeps);
    if (isDue(websiteLastChecked, CADENCE_MS[websiteDef.cadence], now)) {
      const budget = await deps.checkSignalBudget(company.id, websiteDef.cost_cents_est);
      if (!budget.ok) {
        res.budget_stopped++;
        res.notes.push(`${company.id}: website_change budget-stopped (${budget.reason})`);
      } else {
        const r = await runWebsiteChangeCheck(company, signalRunDeps);
        if (r.signalFired) res.signals_fired++;
        homepageChanged = r.homepageChanged;
        homepageHtml = r.homepageHtml;
      }
    }

    // ── tech_change — ONLY when website_change ran THIS tick and the homepage itself changed ───
    if (homepageChanged === true) {
      const budget = await deps.checkSignalBudget(company.id, techDef.cost_cents_est);
      if (!budget.ok) {
        res.budget_stopped++;
        res.notes.push(`${company.id}: tech_change budget-stopped (${budget.reason})`);
      } else {
        const r = await runTechChangeCheck(company, signalRunDeps, { homepageChanged, homepageHtml });
        if (r.signalFired) res.signals_fired++;
      }
    }

    // ── review_velocity — independent cadence, the only signal with real per-call spend ────────
    const reviewLastChecked = await lastCheckedAt(company.id, reviewDef.lastCheckedField, signalRunDeps);
    if (isDue(reviewLastChecked, CADENCE_MS[reviewDef.cadence], now)) {
      const budget = await deps.checkSignalBudget(company.id, reviewDef.cost_cents_est);
      if (!budget.ok) {
        res.budget_stopped++;
        res.notes.push(`${company.id}: review_velocity budget-stopped (${budget.reason})`);
      } else {
        const r = await runReviewVelocityCheck(company, signalRunDeps);
        if (r.signalFired) res.signals_fired++;
      }
    }

    // ── PR 18's 5 independent signals — each its own cadence/budget, no sequencing between them ──
    for (const def of independentDefs) {
      if (!def) continue; // unreachable (checked above) — keeps TS narrowed without a non-null cast
      const lastChecked = await lastCheckedAt(company.id, def.lastCheckedField, signalRunDeps);
      if (!isDue(lastChecked, CADENCE_MS[def.cadence], now)) continue;
      const budget = await deps.checkSignalBudget(company.id, def.cost_cents_est);
      if (!budget.ok) {
        res.budget_stopped++;
        res.notes.push(`${company.id}: ${def.key} budget-stopped (${budget.reason})`);
        continue;
      }
      const r = await def.run(company, signalRunDeps);
      if (r.signalFired) res.signals_fired++;
    }
  }

  return res;
}

export { SIGNAL_REGISTRY };
