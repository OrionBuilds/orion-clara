// estimator.ts — §31 cost table + ETA. `estimateJob` is pure given rates+priors (unit-tested
// directly); `estimateJobLive` loads the real rates.json/priors.json for callers.

import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Estimate, JobSpec } from "./types";
import { DEFAULT_PRIORS, loadPriors, applyPriors, type Priors } from "./priors";
import { hexGrid } from "./discovery/grid";
import { tier2Engine } from "./llm";

export interface Rates {
  places_search: number;
  brave_query: number;
  exa_query: number;
  jina_read: number;
  http_fetch: number;
  dns_lookup: number;
  hunter_verify: number;
  hunter_find: number;
  leadmagic_email: number;
  leadmagic_mobile: number;
  llm_t1_call: number;
  /** Tier 1's Haiku fallback (LM Studio down). Optional so older rates.json copies still load. */
  llm_t1_call_haiku?: number;
  llm_t2_call_lmstudio: number;
  llm_t2_call_haiku: number;
  llm_t3_call: number;
  seconds_per_local_call: number;
  seconds_per_cloud_call: number;
  calls_per_company_t1: number;
  calls_per_company_t2: number;
  t3_share_of_qualified: number;
  queries_per_cell: number;
  places_pages_per_cell: number;
  unique_companies_per_cell: number;
  email_paid_share: number;
}

const RATES_PATH = fileURLToPath(new URL("./rates.json", import.meta.url));
let cachedRates: Rates | null = null;

/** Reads rates.json fresh the first time, then caches — it's a source file the owner can edit without a
 *  rebuild (see the file's own `_comment`), so a long-lived process re-reads only once per boot. */
export async function loadRates(): Promise<Rates> {
  if (cachedRates) return cachedRates;
  const raw = JSON.parse(await fs.readFile(RATES_PATH, "utf8")) as Rates;
  cachedRates = raw;
  return raw;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * §31: cells → expected funnel (via priors) → per-stage cost. Pure — callers inject `rates` and
 * `priors` so this is testable without touching disk or an env var.
 */
export function estimateJob(spec: JobSpec, rates: Rates, priors: Priors = DEFAULT_PRIORS, tier2: "lmstudio" | "haiku" = "lmstudio"): Estimate {
  const cells = hexGrid(spec.location.lat ?? 0, spec.location.lng ?? 0, spec.location.radius_miles).length;
  const discovered = Math.min(spec.max_records, Math.round(cells * rates.unique_companies_per_cell));
  const funnel = applyPriors(discovered, priors);

  const wantsOwner = spec.enrichments.includes("owner");
  const wantsEmail = spec.enrichments.includes("email");
  const wantsMobile = spec.enrichments.includes("mobile") && spec.gates.allow_mobile;

  // discoverCell runs EVERY query in EVERY cell, one call each (placesForCell / braveForCell), so
  // discovery is cells x queries x rate. The old cells x 2 pages x rate assumed ~2 calls a cell and
  // came out 4-5x low for real 8-11 query plans (2026-10-08: $2.64 estimated vs ~$10-13 spent a job).
  const callsPerCell = discoveryCallsPerCell(spec);
  const placesCells = spec.sources.includes("places") ? cells : 0;
  const braveCells = spec.sources.includes("brave") ? cells : 0;
  const discoveryCost = placesCells * callsPerCell * rates.places_search
    + braveCells * callsPerCell * rates.brave_query;

  // Web research: one crawl pass per company that clears basic ICP. http_fetch is $0 today
  // (direct HTTP first), kept so a future paid crawl rung shows up here without code changes.
  const webResearchCost = funnel.pass_icp * rates.http_fetch;

  const t1Calls = funnel.in_industry * rates.calls_per_company_t1;
  const t2Calls = funnel.pass_icp * rates.calls_per_company_t2;
  const t2Rate = tier2 === "haiku" ? rates.llm_t2_call_haiku : rates.llm_t2_call_lmstudio;
  const t3Calls = Math.round(funnel.ai_qualified * rates.t3_share_of_qualified);
  // "haiku" means LM Studio isn't carrying the load, so tier 1 falls back to Haiku as well (llm.ts).
  const t1Rate = tier2 === "haiku" ? (rates.llm_t1_call_haiku ?? rates.llm_t2_call_haiku / 2) : rates.llm_t1_call;
  const aiCost = t1Calls * t1Rate + t2Calls * t2Rate + t3Calls * rates.llm_t3_call;

  const emailCost = wantsOwner && wantsEmail
    ? funnel.dm_found * rates.email_paid_share * rates.leadmagic_email + funnel.email_found * rates.hunter_verify
    : 0;
  const mobileCost = wantsMobile ? funnel.mobile_requested * rates.leadmagic_mobile : 0;

  const total = discoveryCost + webResearchCost + aiCost + emailCost + mobileCost;

  const localCalls = Math.round(tier2 === "lmstudio" ? t1Calls + t2Calls : 0);
  const cloudCalls = Math.round(t3Calls + (tier2 === "haiku" ? t1Calls + t2Calls : 0));
  const etaHours = (localCalls * rates.seconds_per_local_call + cloudCalls * rates.seconds_per_cloud_call) / 3600;

  return {
    discovery: round2(discoveryCost),
    web_research: round2(webResearchCost),
    ai: round2(aiCost),
    email_lookup: round2(emailCost),
    mobile_lookup: round2(mobileCost),
    total: round2(total),
    eta_hours: Math.round(etaHours * 10) / 10,
    assumptions: { cells, expected: funnel, tier2_engine: tier2, local_calls: localCalls },
  };
}

/** Provider calls one discovery cell makes per source: one per query (or per industry term when
 *  the plan has no queries) — the same fallback placesForCell/braveForCell use. */
export function discoveryCallsPerCell(spec: Pick<JobSpec, "queries" | "industry">): number {
  return Math.max(1, (spec.queries?.length ? spec.queries : spec.industry).length);
}

/** Is LM Studio answering right now? A dead LM Studio means every tier-1/2 call is billed to Haiku,
 *  and an estimate that prices them at $0 is wrong by exactly that much. */
async function lmStudioUp(): Promise<boolean> {
  try {
    const { lmStudioBaseUrl } = await import("../lmstudio");
    const r = await fetch(`${await lmStudioBaseUrl()}/models`, { signal: AbortSignal.timeout(2_000) });
    return r.ok;
  } catch {
    return false;
  }
}

export async function estimateJobLive(spec: JobSpec): Promise<Estimate> {
  const [rates, priors, localUp] = await Promise.all([loadRates(), loadPriors(), lmStudioUp()]);
  return estimateJob(spec, rates, priors, localUp ? tier2Engine() : "haiku");
}
