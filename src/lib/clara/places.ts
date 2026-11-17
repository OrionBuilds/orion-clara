// Clara — business resolution via Google Places API (New).
//
// Used when the owner don't name a specific business ("find a plumber near us") — resolves a
// short list of real candidates with a phone number in one signed request, no headless browser
// or scraping involved. Chosen over browser automation: official/structured, stable response
// shape safe to put behind an SMS approval, no layout/anti-bot fragility on an unattended
// single-process Windows server. A browser-automation fallback could slot in later behind the
// same findBusiness() signature without touching any call site.

import { googleApiKey, googleApiKeyConfigured } from "./google-key";

export interface BusinessCandidate {
  placeId: string;
  name: string;
  formattedAddress?: string;
  phoneE164?: string;
  rating?: number;
  userRatingCount?: number;
  businessStatus?: string; // "OPERATIONAL" | "CLOSED_TEMPORARILY" | "CLOSED_PERMANENTLY"
  openNow?: boolean;
  hoursWeekly?: string[];
  websiteUri?: string;
  googleMapsUri?: string;
}

export function placesConfigured(): boolean {
  return googleApiKeyConfigured();
}

interface PlacesApiPlace {
  id: string;
  displayName?: { text?: string };
  formattedAddress?: string;
  internationalPhoneNumber?: string;
  rating?: number;
  userRatingCount?: number;
  businessStatus?: string;
  regularOpeningHours?: { weekdayDescriptions?: string[] };
  currentOpeningHours?: { openNow?: boolean };
  websiteUri?: string;
  googleMapsUri?: string;
}

const BASE_FIELDS = "places.id,places.displayName,places.formattedAddress,places.internationalPhoneNumber,places.rating,places.userRatingCount,places.businessStatus";
// Opt-in only — the field mask below is the same request business-calls.ts always made; asking
// for hours too is strictly for the conversational lookup tool, which is the only caller that
// needs it.
const HOURS_FIELDS = "places.regularOpeningHours.weekdayDescriptions,places.currentOpeningHours.openNow,places.websiteUri,places.googleMapsUri";
// Prospect discovery needs the website: every stage after classify (crawl, score, people, email)
// starts from it, so a Places-only candidate without one dead-ends at stage 30.
const WEBSITE_FIELDS = "places.websiteUri";

function toE164(raw: string): string | undefined {
  const cleaned = raw.replace(/[^\d+]/g, "");
  return cleaned || undefined;
}

export async function findBusiness(
  query: string,
  opts?: {
    locationBias?: { lat: number; lng: number; radiusMeters?: number };
    includeHours?: boolean;
    includeWebsite?: boolean;
    /** Places caps Text Search at 20 per page and bills per request, not per result. */
    maxResults?: number;
  },
): Promise<{ ok: boolean; candidates: BusinessCandidate[]; error?: string }> {
  const key = googleApiKey();
  if (!key) return { ok: false, candidates: [], error: "Google Places not configured (set CLARA_GOOGLE_MAPS_API_KEY)" };

  const body: Record<string, unknown> = { textQuery: query, maxResultCount: Math.min(20, Math.max(1, opts?.maxResults ?? 5)) };
  if (opts?.locationBias) {
    body.locationBias = {
      circle: {
        center: { latitude: opts.locationBias.lat, longitude: opts.locationBias.lng },
        radius: opts.locationBias.radiusMeters ?? 25_000,
      },
    };
  }

  const r = await fetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": key,
      "X-Goog-FieldMask": opts?.includeHours
        ? `${BASE_FIELDS},${HOURS_FIELDS}`
        : opts?.includeWebsite ? `${BASE_FIELDS},${WEBSITE_FIELDS}` : BASE_FIELDS,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
  if (!r) return { ok: false, candidates: [], error: "Places API request failed (network/timeout)" };
  if (!r.ok) return { ok: false, candidates: [], error: `Places API ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}` };

  const j = await r.json().catch(() => ({})) as { places?: PlacesApiPlace[] };
  const candidates: BusinessCandidate[] = (j.places ?? []).map((p) => ({
    placeId: p.id,
    name: p.displayName?.text ?? "Unknown business",
    formattedAddress: p.formattedAddress,
    phoneE164: p.internationalPhoneNumber ? toE164(p.internationalPhoneNumber) : undefined,
    rating: p.rating,
    userRatingCount: p.userRatingCount,
    businessStatus: p.businessStatus,
    openNow: p.currentOpeningHours?.openNow,
    hoursWeekly: p.regularOpeningHours?.weekdayDescriptions,
    websiteUri: p.websiteUri,
    googleMapsUri: p.googleMapsUri,
  }));

  return { ok: true, candidates };
}

// Place Details (New) — a ratings/review-count snapshot BY place id, for PR 17's review-velocity
// signal (companies already carry google_place_id from discovery; no text search needed to
// re-check them). Same field-mask/fetch/error-handling shape as findBusiness above, just a GET
// against /v1/places/{placeId} with a minimal field mask (rating + userRatingCount only — this is
// a cheap periodic snapshot, not a full business lookup).
const DETAILS_FIELDS = "rating,userRatingCount";

export async function getPlaceDetails(
  placeId: string,
): Promise<{ ok: boolean; rating?: number; userRatingCount?: number; error?: string }> {
  const key = googleApiKey();
  if (!key) return { ok: false, error: "Google Places not configured (set CLARA_GOOGLE_MAPS_API_KEY)" };
  if (!placeId) return { ok: false, error: "missing placeId" };

  const r = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`, {
    method: "GET",
    headers: {
      "X-Goog-Api-Key": key,
      "X-Goog-FieldMask": DETAILS_FIELDS,
    },
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
  if (!r) return { ok: false, error: "Places API request failed (network/timeout)" };
  if (!r.ok) return { ok: false, error: `Places API ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}` };

  const j = (await r.json().catch(() => ({}))) as { rating?: number; userRatingCount?: number };
  return { ok: true, rating: j.rating, userRatingCount: j.userRatingCount };
}

// Picks the best usable candidate: operational, ranked by rating weighted by review volume so a
// single 5-star/1-review listing doesn't beat a well-established 4.5-star spot. Requires a phone
// number by default (business-calls.ts needs one to dial) — pass requirePhone:false for a
// read-only lookup (hours/address/rating), where a listing missing a phone is still a good answer.
export function pickBestCandidate(candidates: BusinessCandidate[], opts?: { requirePhone?: boolean }): BusinessCandidate | null {
  const requirePhone = opts?.requirePhone ?? true;
  const usable = candidates.filter((c) => (!requirePhone || c.phoneE164) && (c.businessStatus ?? "OPERATIONAL") === "OPERATIONAL");
  if (!usable.length) return null;
  return usable.slice().sort((a, b) => {
    const scoreA = (a.rating ?? 0) * Math.log((a.userRatingCount ?? 0) + 1);
    const scoreB = (b.rating ?? 0) * Math.log((b.userRatingCount ?? 0) + 1);
    return scoreB - scoreA;
  })[0];
}
