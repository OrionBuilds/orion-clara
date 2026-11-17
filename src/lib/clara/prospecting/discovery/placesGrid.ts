// discovery/placesGrid.ts — Places discovery for one grid cell.
//
// Reuses Clara's existing places.ts (Places API New) rather than a separate agent-core client —
// the key is already provisioned (CLARA_GOOGLE_MAPS_API_KEY) and this is a low-volume, cell-at-a-
// time caller, not the paged/high-throughput client agent-core's providers/ package will add later.

import { findBusiness, placesConfigured, type BusinessCandidate } from "../../places";
import type { DiscoveredCandidate, JobSpec } from "../types";

function toCandidate(b: BusinessCandidate): DiscoveredCandidate {
  return {
    name: b.name,
    source: "places",
    website_url: b.websiteUri,
    phone: b.phoneE164,
    google_place_id: b.placeId,
    rating: b.rating,
    review_count: b.userRatingCount,
    business_status: b.businessStatus,
    address: b.formattedAddress ? { line1: b.formattedAddress } : undefined,
  };
}

export interface PlacesCellResult {
  candidates: DiscoveredCandidate[];
  calls: number;
  error?: string;
}

/** One Places textSearch per spec query, biased to the cell. Deduped by place_id within the cell —
 *  cross-cell dedup is entity resolution's job (stage 20), not discovery's. */
export async function placesForCell(cell: { lat: number; lng: number; radiusMiles: number }, spec: JobSpec): Promise<PlacesCellResult> {
  if (!placesConfigured()) return { candidates: [], calls: 0, error: "Places not configured (CLARA_GOOGLE_MAPS_API_KEY)" };
  const radiusMeters = Math.min(50_000, Math.max(1_000, Math.round(cell.radiusMiles * 1609.34)));
  const queries = spec.queries.length ? spec.queries : spec.industry;
  const seen = new Map<string, DiscoveredCandidate>();
  let calls = 0;
  let lastError: string | undefined;
  for (const q of queries) {
    calls++;
    const r = await findBusiness(q, {
      locationBias: { lat: cell.lat, lng: cell.lng, radiusMeters },
      includeWebsite: true,
      maxResults: 20,
    });
    if (!r.ok) { lastError = r.error; continue; }
    for (const c of r.candidates) {
      if (c.businessStatus === "CLOSED_PERMANENTLY") continue;
      if (!seen.has(c.placeId)) seen.set(c.placeId, toCandidate(c));
    }
  }
  return { candidates: [...seen.values()], calls, error: seen.size ? undefined : lastError };
}
