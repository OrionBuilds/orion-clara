// signals/registry.ts — the 3 signals PR 17 implements, as pure data (+ each one's `run` function,
// already fully implemented in signals/checks/*.ts). refresh.ts is the only thing that iterates
// this table at runtime; registry.test.ts asserts its cost_cents_est/score_delta values directly so
// a future PR can't silently regress them without a failing test.

import { runWebsiteChangeCheck, WEBSITE_CHANGE_SCORE_DELTA } from "./checks/websiteChange";
import { runTechChangeCheck, TECH_CHANGE_SCORE_DELTA } from "./checks/techChange";
import { runReviewVelocityCheck, REVIEW_VELOCITY_SCORE_DELTA_HIGH, PLACES_DETAILS_COST_USD } from "./checks/reviewVelocity";
import { runHiringCheck, HIRING_LAST_SCAN_FIELD, HIRING_SALES_OPS_SCORE_DELTA, BRAVE_QUERY_COST_USD as HIRING_BRAVE_COST_USD } from "./checks/hiring";
import { runAdActivityCheck, AD_ACTIVITY_HASH_FIELD, AD_ACTIVITY_SCORE_DELTA, BRAVE_QUERY_COST_USD as AD_ACTIVITY_BRAVE_COST_USD } from "./checks/adActivity";
import { runNewLocationCheck, KNOWN_PLACE_IDS_FIELD, NEW_LOCATION_SCORE_DELTA, PLACES_TEXT_SEARCH_COST_USD } from "./checks/newLocation";
import { runLeadershipChangeCheck, LEADERSHIP_NAMES_FIELD, LEADERSHIP_CHANGE_SCORE_DELTA } from "./checks/leadershipChange";
import { runPermitGrowthCheck, LAST_PERMIT_SCAN_FIELD, PERMIT_GROWTH_SCORE_DELTA } from "./checks/permitGrowth";
import type { SignalDef } from "./types";

export const SIGNAL_REGISTRY: SignalDef[] = [
  {
    key: "website_change",
    // Web pages don't change hour to hour; a daily re-check is enough to catch a real redesign,
    // new pricing page, etc. without wasting crawl attempts on 23 of every 24 hourly ticks.
    cadence: "daily",
    // Crawling is $0 under today's rates.json (http_fetch/jina_read/playwright_render all 0) — kept
    // as a real (not hardcoded-0) constant so a future paid-crawl-rung rate change is honored here
    // without touching this table again.
    cost_cents_est: 0,
    score_delta: WEBSITE_CHANGE_SCORE_DELTA,
    lastCheckedField: "website_hash",
    run: runWebsiteChangeCheck,
  },
  {
    key: "tech_change",
    // Advisory only — see checks/techChange.ts's header comment. Its REAL gate is "did
    // website-change find a homepage diff this tick," enforced by refresh.ts's sequencing, not by
    // this cadence. Set to the same cadence as website_change purely so a standalone/ad-hoc caller
    // of runTechChangeCheck (no refresh.ts sequencing) still has a sane cadence to read.
    cadence: "daily",
    cost_cents_est: 0,
    score_delta: TECH_CHANGE_SCORE_DELTA,
    lastCheckedField: "tech_scan_hash",
    run: runTechChangeCheck,
  },
  {
    key: "review_velocity",
    // Needs a ~30d-ago AND a ~90d-ago snapshot to compute anything — weekly scans keep snapshots
    // dense enough that both targets are almost always within checks/reviewVelocity.ts's ±5 day
    // tolerance, without paying for a Places Details call every single day.
    cadence: "weekly",
    cost_cents_est: PLACES_DETAILS_COST_USD * 100, // 0.5 cents
    // The registry value is always the HIGH tier (the plan's one precisely-specified rule, ≥20% in
    // 90 days); the medium tier's smaller delta is computed inside runReviewVelocityCheck itself —
    // see reviewVelocity.ts's reviewVelocityStrength doc comment.
    score_delta: REVIEW_VELOCITY_SCORE_DELTA_HIGH,
    lastCheckedField: "review_snapshot",
    run: runReviewVelocityCheck,
  },
  // ── PR 18 — 5 more signals, each independent of every other signal (no sequencing gate the way
  // tech_change depends on website_change) and of each other. refresh.ts's generic
  // INDEPENDENT_SIGNAL_KEYS loop runs each of these 5 for every company, gated only by its own
  // cadence/budget — see refresh.ts's doc comment on why that generic loop exists (SIGNAL_REGISTRY
  // alone was NOT enough to "just work" for PR 17's 3 signals, which are called by name/sequenced;
  // these 5 needed that one addition).
  {
    key: "hiring",
    // Job postings/listings don't churn hour to hour; weekly keeps the 2 Brave queries (the only
    // real per-run spend) affordable against the tiny $0.15/month per-company signal budget
    // (budget.ts) alongside this PR's other 4 signals and PR 17's review_velocity.
    cadence: "weekly",
    // 2 Brave queries (indeed + linkedin) x $0.005 = $0.01 = 1 cent. The careers-page crawl and the
    // tier-1 extraction are both $0 under today's rates.json (crawl rungs free; llm_t1_call: 0).
    cost_cents_est: HIRING_BRAVE_COST_USD * 2 * 100,
    score_delta: HIRING_SALES_OPS_SCORE_DELTA,
    lastCheckedField: HIRING_LAST_SCAN_FIELD,
    run: runHiringCheck,
  },
  {
    key: "ad_activity",
    // Same cost-conscious reasoning as hiring — ad campaigns don't start/stop hour to hour either.
    cadence: "weekly",
    // Only the brave ad-badge heuristic has a real cost (1 query x $0.005 = 0.5 cents); the
    // tech-facts read is free, and the Meta Ad Library call is $0 whether or not a token is
    // configured (either skipped outright with no network call, or billed at $0 — Meta's API has no
    // listed per-call cost in rates.json).
    cost_cents_est: AD_ACTIVITY_BRAVE_COST_USD * 100,
    score_delta: AD_ACTIVITY_SCORE_DELTA,
    lastCheckedField: AD_ACTIVITY_HASH_FIELD,
    run: runAdActivityCheck,
  },
  {
    key: "new_location",
    // A new branch opening is a slow-moving, high-value event — weekly is already generous; the
    // real constraint here is cost, not freshness (see cost_cents_est below, the priciest of this
    // PR's 5 signals).
    cadence: "weekly",
    // 1 Places Text Search call = rates.json's places_search (0.035 USD) = 3.5 cents — by itself
    // already ~23% of the default $0.15/month per-company cap in a single run; budget.ts's existing
    // gate is what keeps this honest, not a cheaper cadence (a monthly cadence would risk missing a
    // real expansion for weeks, which defeats the point of a "new location" signal).
    // Math.round(...*100)/100 avoids a float-multiplication artifact (0.035*100 is
    // 3.5000000000000004 in IEEE754, not exactly 3.5) — same concern PLACES_DETAILS_COST_USD*100
    // above happens not to hit, but this one does.
    cost_cents_est: Math.round(PLACES_TEXT_SEARCH_COST_USD * 100 * 100) / 100,
    score_delta: NEW_LOCATION_SCORE_DELTA,
    lastCheckedField: KNOWN_PLACE_IDS_FIELD,
    run: runNewLocationCheck,
  },
  {
    key: "leadership_change",
    cadence: "weekly",
    // Crawl ($0) + tier-1 extraction ($0) — free under today's rates.json, same as website/
    // tech-change.
    cost_cents_est: 0,
    score_delta: LEADERSHIP_CHANGE_SCORE_DELTA,
    lastCheckedField: LEADERSHIP_NAMES_FIELD,
    run: runLeadershipChangeCheck,
  },
  {
    key: "permit_growth",
    cadence: "weekly",
    // Both county adapters are free, unauthenticated (Hillsborough confirmed real, Pinellas
    // best-guess — see flPermits/pinellas.ts) public ArcGIS queries; rates.json has no line item for
    // either, so $0 like crawling.
    cost_cents_est: 0,
    score_delta: PERMIT_GROWTH_SCORE_DELTA,
    lastCheckedField: LAST_PERMIT_SCAN_FIELD,
    run: runPermitGrowthCheck,
  },
];

export function signalDef(key: string): SignalDef | undefined {
  return SIGNAL_REGISTRY.find((s) => s.key === key);
}

export type { SignalDef, SignalKey, SignalCadence, CompanySignalInput, SignalRunDeps, SignalRunResult, SignalRunContext } from "./types";
