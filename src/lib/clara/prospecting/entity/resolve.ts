// §11 — entity resolution: classify a discovered candidate against a pool of existing companies.
//
// Pure — does no I/O. The caller (stages.ts) fetches the comparison pool (a handful of companies
// that plausibly match on domain/phone/name) and passes it in; tier-3 adjudication for ambiguous
// "possible duplicate" scores lives in stages.ts too (it needs the orchestrator's budget/mode
// context, which this module deliberately doesn't know about).

import type { DiscoveredCandidate } from "../types";
import { normalizeCandidate, type NormalizedCandidate } from "./normalize";
import { matchScore, type ExistingEntity } from "./fingerprint";

export const MERGE_THRESHOLD = 100;
export const POSSIBLE_THRESHOLD = 40;

export type ResolveAction = "merge" | "possible" | "new";

export interface ResolveBest {
  entity: ExistingEntity;
  score: number;
  matchedOn: string[];
}

export interface ResolveResult {
  action: ResolveAction;
  candidate: NormalizedCandidate;
  best?: ResolveBest;
}

/** §11: the single highest-scoring existing entity decides the action — MERGE ≥100, POSSIBLE
 *  40-99, otherwise NEW. An empty pool is always NEW (nothing to merge or dupe-flag against). */
export function resolveCandidate(discovered: DiscoveredCandidate, existing: ExistingEntity[]): ResolveResult {
  const candidate = normalizeCandidate(discovered);
  let best: ResolveBest | undefined;
  for (const e of existing) {
    const { score, matchedOn } = matchScore(candidate, e);
    if (!best || score > best.score) best = { entity: e, score, matchedOn };
  }
  if (!best || best.score < POSSIBLE_THRESHOLD) return { action: "new", candidate, best };
  if (best.score >= MERGE_THRESHOLD) return { action: "merge", candidate, best };
  return { action: "possible", candidate, best };
}

export type { ExistingEntity };
