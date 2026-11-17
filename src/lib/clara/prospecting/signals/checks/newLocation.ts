// signals/checks/newLocation.ts — PR 18: has this company opened a new branch location?
//
// Places Text Search (`findBusiness`, Places API New) for `"{name}" {state}` returns up to 5
// candidates — NOT just the single best one (`pickBestCandidate` in places.ts), since a company
// with 3 real branches legitimately shows up as 3 distinct candidates and this check needs to see
// all of them, not collapse to one. Each candidate is then filtered to "plausibly the SAME company,
// a different location" via a simple name-similarity check (see isLikelySameCompany below) — Places
// Text Search for a common business name can also return genuinely unrelated businesses, which must
// not be counted as a new branch.
//
// DIFFING: a dedicated SET diff (diffNewPlaceIds below), not diff.ts's hashContent/diffChanged —
// those are built for "did this single blob change at all," but this check specifically needs to
// know WHICH place_ids are new, not just "has the set changed," so a small purpose-built array-diff
// lives here instead of forcing that shape through the hash helpers.
//
// FIELD-NAMING, to avoid the OS's own auto-signal collision (see writers.ts's doc comment): the OS
// already auto-emits a score-less `new_location` signal off its OWN `location_count` fact field
// (factChangeSignal in orion/mcp-server/src/tools/prospects.ts) — a number going up. This check
// never writes to "location_count"; its own last-checked/diff-baseline state goes under
// "known_place_ids" (a sorted JSON array of every place_id ever seen for this company), so
// writeLastCheckedFact's facts_add call can never accidentally trigger that score-less OS-side path.
// The real, SCORED `new_location` signal here only ever comes from this file's own fireSignal call.

import { normalizeName } from "../../entity/normalize";
import { cacheKey } from "../../cache";
import type { CompanySignalInput, SignalRunDeps, SignalRunResult } from "../types";

export const KNOWN_PLACE_IDS_FIELD = "known_place_ids";
export const NEW_LOCATION_SCORE_DELTA = 10;
/** Mirrors rates.json's `places_search` (0.035 USD) — a Text Search call, pricier than
 *  review_velocity's Place Details lookup (`places_details`, 0.005). */
export const PLACES_TEXT_SEARCH_COST_USD = 0.035;

/** Pure: a loose but documented "plausibly the same company, a different location" check — reuses
 *  entity/normalize.ts's normalizeName (§11's own name fingerprint) rather than inventing a second
 *  normalization. Two names count as the same company when their normalized forms are identical,
 *  one contains the other (e.g. "acme roofing" vs. "acme roofing of tampa"), or they share the same
 *  first (typically the distinctive brand) token. Exported for direct unit testing. */
export function isLikelySameCompany(companyName: string, candidateName: string): boolean {
  const a = normalizeName(companyName);
  const b = normalizeName(candidateName);
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.includes(b) || b.includes(a)) return true;
  const aFirst = a.split(" ")[0];
  const bFirst = b.split(" ")[0];
  return aFirst.length > 2 && aFirst === bFirst;
}

export interface PlaceIdDiff {
  /** Every id from `nextIds` that wasn't already in `prevIds`. */
  newIds: string[];
  /** The union of both, sorted — what gets written back as the next baseline. */
  allIds: string[];
}

/** Pure set diff (see module doc for why this isn't diff.ts's hash-based diffChanged). Exported for
 *  direct unit testing. */
export function diffNewPlaceIds(prevIds: readonly string[], nextIds: readonly string[]): PlaceIdDiff {
  const prevSet = new Set(prevIds);
  const newIds = nextIds.filter((id) => id && !prevSet.has(id));
  const allIds = [...new Set([...prevIds, ...nextIds])].filter(Boolean).sort();
  return { newIds, allIds };
}

function parseKnownPlaceIds(value: unknown): string[] {
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export async function runNewLocationCheck(company: CompanySignalInput, deps: SignalRunDeps): Promise<SignalRunResult> {
  if (!company.name) {
    return { ran: false, changed: false, signalFired: false, costCentsSpent: 0, notes: ["no company name"], skippedReason: "no_company_name" };
  }

  const state = company.state ?? "FL";
  const query = `"${company.name}" ${state}`;
  const key = cacheKey(["places_text_search", company.id, "new_location"]);

  const result = await deps.cachedCall({
    provider: "places", kind: "places", key, companyId: company.id,
    costUsd: PLACES_TEXT_SEARCH_COST_USD, allowLive: deps.allowLive,
    fn: () => deps.findBusiness(query),
  });
  const costCentsSpent = result.costUsd * 100;

  if (result.skipped) {
    return { ran: false, changed: false, signalFired: false, costCentsSpent, notes: ["shadow mode — Places Text Search call skipped"], skippedReason: "shadow_mode" };
  }
  if (!result.value || result.value.ok === false) {
    return { ran: false, changed: false, signalFired: false, costCentsSpent, notes: [`Places Text Search unavailable: ${result.value?.error ?? "no data"}`], skippedReason: "places_unavailable" };
  }

  const matching = result.value.candidates.filter((c) => c.placeId && isLikelySameCompany(company.name as string, c.name));
  const foundIds = matching.map((c) => c.placeId);

  const existing = await deps.factsList({ subject_type: "company", subject_id: company.id, field_name: KNOWN_PLACE_IDS_FIELD });
  const isBaseline = existing.length === 0;
  const prevIds = parseKnownPlaceIds(existing[0]?.value);

  const { newIds, allIds } = diffNewPlaceIds(prevIds, foundIds);
  const observedAt = deps.now().toISOString();

  await deps.writeLastCheckedFact({
    companyId: company.id,
    fieldName: KNOWN_PLACE_IDS_FIELD,
    value: JSON.stringify(allIds),
    sourceType: "places",
    observedAt,
  });

  if (isBaseline) {
    return { ran: true, changed: false, signalFired: false, costCentsSpent, notes: [`baseline scan — ${allIds.length} known location(s) on file, no signal`] };
  }
  if (!newIds.length) {
    return { ran: true, changed: false, signalFired: false, costCentsSpent, notes: ["no new locations found"] };
  }

  const newNames = matching.filter((c) => newIds.includes(c.placeId)).map((c) => c.name);
  await deps.fireSignal({
    companyId: company.id,
    signalType: "new_location",
    headline: `New location${newIds.length > 1 ? "s" : ""} detected (${newIds.length})`,
    detail: `Places Text Search now also finds: ${newNames.join(", ")}.`,
    interpretation: "Expansion; more operational complexity.",
    strength: "high",
    scoreDelta: NEW_LOCATION_SCORE_DELTA,
    observedAt,
  });

  return { ran: true, changed: true, signalFired: true, costCentsSpent, notes: [`${newIds.length} new location(s) detected`] };
}
