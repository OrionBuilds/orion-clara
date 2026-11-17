// signals/types.ts — shared shapes for PR 17's signals framework, split out from registry.ts so
// checks/*.ts can import them without a registry.ts <-> checks/*.ts runtime import cycle (registry.ts
// imports each check's `run` function; the checks only need these TYPES back).

import { factsList as factsListReal, type CompanyFactRow } from "../osBridge";
import { crawlPage as crawlPageReal } from "../crawler/waterfall";
import { writeLastCheckedFact as writeLastCheckedFactReal, fireSignal as fireSignalReal } from "./writers";
import { getPlaceDetails as getPlaceDetailsReal, findBusiness as findBusinessReal } from "../../places";
import { cachedCall as cachedCallReal } from "../cache";
import { webSearch as webSearchReal } from "../../brave-search";
import { lookupPermits as lookupHillsboroughPermitsReal } from "../publicdata/flPermits/hillsborough";
import { lookupPermits as lookupPinellasPermitsReal } from "../publicdata/flPermits/pinellas";
import { runTier as runTierReal } from "../llm";

export type SignalKey =
  | "website_change" | "tech_change" | "review_velocity"
  // PR 18: hiring, ad_activity, new_location, leadership_change, permit_growth — see
  // checks/hiring.ts, checks/adActivity.ts, checks/newLocation.ts, checks/leadershipChange.ts,
  // checks/permitGrowth.ts for each one's own doc comment.
  | "hiring" | "ad_activity" | "new_location" | "leadership_change" | "permit_growth";
export type SignalCadence = "hourly" | "daily" | "weekly";

/** The bare minimum a company row needs for signal-scanning — a subset of companies_search's /
 *  companies_get's much larger shape, kept intentionally small so tests don't need a full fixture.
 *  `city`/`state` (PR 18) are optional, additive fields — only permit_growth (county lookup) and,
 *  as a query-quality nicety, hiring/ad_activity/new_location (narrowing a name search) read them;
 *  the 3 PR 17 checks never look at them, so adding the fields is non-breaking for those. */
export interface CompanySignalInput {
  id: string;
  name?: string;
  website_url?: string;
  google_place_id?: string;
  city?: string;
  state?: string;
}

/** Everything a signal check's `run()` might need, injected — the same "one shared deps bag, each
 *  caller destructures what it uses" convention stages.ts's StageDeps already follows. Budget
 *  gating itself happens in refresh.ts BEFORE `run()` is even called (using the registry's
 *  cost_cents_est) — these deps are purely about doing the check's own work once refresh.ts has
 *  already decided it's due and affordable. */
export interface SignalRunDeps {
  now: () => Date;
  factsList: (args: { subject_type?: "company" | "person"; subject_id: string; field_name?: string; include_history?: boolean; limit?: number }) => Promise<CompanyFactRow[]>;
  writeLastCheckedFact: typeof writeLastCheckedFactReal;
  fireSignal: typeof fireSignalReal;
  crawlPage: typeof crawlPageReal;
  /** Reads an evidence text file off disk (crawlPage's CrawlPageResult only hands back a txtPath,
   *  not the text itself — see crawler/evidence.ts). Injected so tests never touch a real disk. */
  readFile: (path: string) => Promise<string>;
  cachedCall: typeof cachedCallReal;
  getPlaceDetails: typeof getPlaceDetailsReal;
  /** PR 18 — hiring's job-board queries, ad-activity's Google-Ads-badge heuristic (see
   *  checks/adActivity.ts's doc comment on that heuristic's real, honestly-documented limits). */
  webSearch: typeof webSearchReal;
  /** PR 18 — new_location's Places Text Search (ALL candidates, not just pickBestCandidate's one
   *  winner — see checks/newLocation.ts). */
  findBusiness: typeof findBusinessReal;
  /** PR 18 — permit_growth's two county adapters (PR 9). Kept as two separate deps, not one
   *  "lookupPermits(jurisdiction, term)" dispatcher, so each check keeps exactly the same
   *  `typeof <real export>` injection convention every other dep here already uses, and so a test
   *  can fake just the one county it's exercising. */
  lookupHillsboroughPermits: typeof lookupHillsboroughPermitsReal;
  lookupPinellasPermits: typeof lookupPinellasPermitsReal;
  /** PR 18 — hiring's role-title extraction and leadership_change's name/title extraction (both
   *  tier-1, see each check's doc comment on why). */
  runTier: typeof runTierReal;
  /** prospectingMode()==="active" — computed ONCE per tick by refresh.ts and threaded down, rather
   *  than each check re-reading the env var, so a shadow-mode tick is consistently shadow for every
   *  company/signal it touches within that run. */
  allowLive: boolean;
}

export interface SignalRunResult {
  /** True once this check actually attempted its work this call (false for an internal skip, e.g.
   *  "no website_url" — distinct from refresh.ts's OWN due/budget skip, which never calls run() at
   *  all). */
  ran: boolean;
  /** True iff a genuine, signal-worthy change was found (diffChanged()'s sense — never true on a
   *  first-ever baseline scan). */
  changed: boolean;
  /** True iff signals_add was actually called this run. */
  signalFired: boolean;
  /** Real spend this call incurred (cents) — review_velocity's Places Details call; $0 for
   *  website/tech-change under today's rates.json (crawling is free). */
  costCentsSpent: number;
  notes: string[];
  skippedReason?: string;
}

/** Extra context threaded ONLY into tech_change's run() — see checks/techChange.ts's doc comment on
 *  the deliberate website-change-then-tech-change sequencing. Optional/unused by the other two
 *  checks; kept on the shared `run` signature (rather than a tech_change-only overload) so every
 *  SignalDef.run has the same shape and the registry stays uniform. */
export interface SignalRunContext {
  /** Set by refresh.ts from website-change's own result for the SAME company, SAME tick. Undefined
   *  means "website-change didn't run this tick" (not due, or no website_url) — tech_change then
   *  falls back to an independent (self-sufficient) homepage check of its own rather than silently
   *  no-op'ing forever, see techChange.ts. */
  homepageChanged?: boolean;
  /** The homepage's RAW html, when website-change's crawl happened to fetch it this tick (http or
   *  playwright rungs only — jina never returns raw html, see crawler/waterfall.ts's finalize()).
   *  Reused so tech-change never re-crawls the same URL in the same tick; undefined means
   *  tech-change must fall back to its own crawl (or skip if that also yields no html). */
  homepageHtml?: string;
}

export interface SignalDef {
  key: SignalKey;
  /** How often this signal is worth re-checking per company, in the ABSENCE of any cheaper signal
   *  (e.g. tech_change's own cadence here is advisory only — see techChange.ts; its real gate is
   *  "did website-change find a homepage diff this tick"). Cadence gating itself lives in
   *  refresh.ts, keyed off `lastCheckedField`'s most recent observed_at. */
  cadence: SignalCadence;
  /** Rough per-RUN cost estimate (cents) the budget gate checks BEFORE calling run() — see
   *  signals/budget.ts. */
  cost_cents_est: number;
  /** The score_delta signals_add is called with when this signal fires. A single fixed number per
   *  signal (the plan's own suggested simplification) EXCEPT review_velocity, whose run() scales
   *  this down for its "medium" tier — see reviewVelocity.ts's own doc comment; this registry value
   *  is always the HIGH-tier (≥20%-in-90-days) figure, the one case the plan pins down precisely. */
  score_delta: number;
  /** The facts.field_name whose most recent observed_at refresh.ts reads as this signal's
   *  "last checked" timestamp for cadence gating. */
  lastCheckedField: string;
  run: (company: CompanySignalInput, deps: SignalRunDeps, ctx?: SignalRunContext) => Promise<SignalRunResult>;
}

async function readFileReal(p: string): Promise<string> {
  const { promises: fs } = await import("node:fs");
  return fs.readFile(p, "utf8");
}

export const defaultSignalRunDeps: SignalRunDeps = {
  now: () => new Date(),
  factsList: factsListReal,
  writeLastCheckedFact: writeLastCheckedFactReal,
  fireSignal: fireSignalReal,
  crawlPage: crawlPageReal,
  readFile: readFileReal,
  cachedCall: cachedCallReal,
  getPlaceDetails: getPlaceDetailsReal,
  webSearch: webSearchReal,
  findBusiness: findBusinessReal,
  lookupHillsboroughPermits: lookupHillsboroughPermitsReal,
  lookupPinellasPermits: lookupPinellasPermitsReal,
  runTier: runTierReal,
  allowLive: false,
};
