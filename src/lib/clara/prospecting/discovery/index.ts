// discovery/index.ts — §10 one discovery task: merge Places + Brave (+ Exa-via-FRIDAY) for one
// grid cell, deduped by place_id/domain/name.
//
// Places and Brave are real per-call spend (rates.json) and so are cache-gated and refuse to run
// live outside `active` mode (shadow/off get cached results only). Exa-via-FRIDAY rides FRIDAY's
// shared Agent-Reach allowance — $0 in the cost model — so it is allowed in every mode.

import type { DiscoveredCandidate, JobSpec } from "../types";
import { placesForCell } from "./placesGrid";
import { braveForCell } from "./braveSearch";
import { exaForCell } from "./exaViaFriday";
import { normalizeDomain } from "../entity/normalize";
import { cachedCall, cacheKey } from "../cache";
import { discoveryCallsPerCell, loadRates } from "../estimator";

export interface DiscoverCellOpts {
  /** true only in `active` mode — gates whether a cache MISS is allowed to spend. */
  allowLive: boolean;
  jobId: string;
}

export interface DiscoverCellResult {
  candidates: DiscoveredCandidate[];
  costUsd: number;
  notes: string[];
}

// What one cell actually costs: placesForCell/braveForCell make one call per query, so the ledger
// books calls x rate. (Until 2026-10-08 this was a flat $0.21/$0.015 a cell — ~3 queries — which
// under-booked real 8-11 query plans by 35-50% and hid the overspend from the budget guard.)
async function cellCosts(spec: JobSpec): Promise<{ places: number; brave: number }> {
  const rates = await loadRates();
  const calls = discoveryCallsPerCell(spec);
  return { places: calls * rates.places_search, brave: calls * rates.brave_query };
}

export async function discoverCell(
  cell: { lat: number; lng: number; radiusMiles: number },
  spec: JobSpec,
  opts: DiscoverCellOpts,
): Promise<DiscoverCellResult> {
  const notes: string[] = [];
  const merged = new Map<string, DiscoveredCandidate>();
  let costUsd = 0;

  const addAll = (list: DiscoveredCandidate[]) => {
    for (const c of list) {
      const key = c.google_place_id ?? normalizeDomain(c.website_url) ?? c.name.toLowerCase();
      if (!merged.has(key)) merged.set(key, c);
    }
  };

  const cost = await cellCosts(spec);
  const cellKey = cacheKey([cell.lat.toFixed(3), cell.lng.toFixed(3), cell.radiusMiles, spec.queries.join(",")]);
  // Bump when placesForCell's result shape changes, so cached cells from the old request aren't
  // reused. v2: websiteUri + 20-result pages (v1 had no websites and 5 results per query).
  const placesKey = `v2:${cellKey}`;

  if (spec.sources.includes("places")) {
    const r = await cachedCall({
      provider: "places", kind: "places", key: placesKey, jobId: opts.jobId,
      costUsd: cost.places, allowLive: opts.allowLive,
      fn: () => placesForCell(cell, spec),
    });
    if (r.value) {
      addAll(r.value.candidates);
      if (r.value.error && !r.value.candidates.length) notes.push(`places: ${r.value.error}`);
    }
    if (r.skipped) notes.push("places skipped — not in active mode and nothing cached yet");
    costUsd += r.costUsd;
  }

  if (spec.sources.includes("brave")) {
    const r = await cachedCall({
      provider: "brave", kind: "brave", key: cellKey, jobId: opts.jobId,
      costUsd: cost.brave, allowLive: opts.allowLive,
      fn: () => braveForCell(cell, spec),
    });
    if (r.value) {
      addAll(r.value.candidates);
      if (r.value.error && !r.value.candidates.length) notes.push(`brave: ${r.value.error}`);
    }
    if (r.skipped) notes.push("brave skipped — not in active mode and nothing cached yet");
    costUsd += r.costUsd;
  }

  if (spec.sources.includes("exa")) {
    const r = await exaForCell(cell, spec).catch((e) => ({ candidates: [] as DiscoveredCandidate[], calls: 0, error: e instanceof Error ? e.message : String(e) }));
    if (r.error) notes.push(`exa: ${r.error}`);
    addAll(r.candidates);
  }

  return { candidates: [...merged.values()], costUsd: Math.round(costUsd * 100) / 100, notes };
}
