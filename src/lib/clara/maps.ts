// Clara — Google Maps: driving directions, geocoding, and Maps links.
//
// Same GCP project + key as places.ts/weather.ts (google-key.ts), but the Routes and Geocoding
// APIs are separate surfaces that must be individually enabled on that key in Google Cloud
// Console — Places/Weather/Time Zone being enabled does not imply these are. directionsConfigured()
// and geocodeConfigured() both check the key is present; a missing-API 403 at request time still
// surfaces as a clear error rather than a crash, but "configured" here only means "we have a key
// to try with," not "the API is definitely enabled" — there's no cheap way to check that without
// making a real request.
//
// mapsLinkFor() is the one function here that calls no API at all — it's pure URL construction,
// works with zero setup, and is what "open this in Google Maps" means for a chat/SMS agent: a
// real clickable link in the reply, not an app launch Clara has no way to trigger on the owner's phone.

import { googleApiKey, googleApiKeyConfigured } from "./google-key";

export function directionsConfigured(): boolean {
  return googleApiKeyConfigured();
}

export function geocodeConfigured(): boolean {
  return googleApiKeyConfigured();
}

export interface LatLng { lat: number; lng: number }

/** A real, clickable Google Maps URL — no API call, works with zero setup. */
export function mapsLinkFor(opts: { query?: string; destination?: string; origin?: string; at?: LatLng }): string {
  if (opts.destination) {
    const params = new URLSearchParams({ api: "1", destination: opts.destination });
    if (opts.origin) params.set("origin", opts.origin);
    return `https://www.google.com/maps/dir/?${params.toString()}`;
  }
  const query = opts.query ?? (opts.at ? `${opts.at.lat},${opts.at.lng}` : "");
  return `https://www.google.com/maps/search/?${new URLSearchParams({ api: "1", query }).toString()}`;
}

interface RoutesApiResponse {
  routes?: { duration?: string; distanceMeters?: number }[];
}

/**
 * Drive time + distance between two places (free-text addresses/place names — the Routes API
 * resolves them itself, no separate geocoding step needed). Origin defaults to home when omitted.
 */
export async function getDirections(
  destination: string,
  opts?: { origin?: string; home?: LatLng },
): Promise<{ ok: boolean; durationText?: string; distanceMiles?: number; mapsUrl?: string; error?: string }> {
  const key = googleApiKey();
  if (!key) return { ok: false, error: "Google Maps not configured (set CLARA_GOOGLE_MAPS_API_KEY)" };

  const origin = opts?.origin ?? (opts?.home ? { location: { latLng: { latitude: opts.home.lat, longitude: opts.home.lng } } } : null);
  if (!origin) return { ok: false, error: "no origin given and no home location configured" };

  const body = {
    origin: typeof origin === "string" ? { address: origin } : origin,
    destination: { address: destination },
    travelMode: "DRIVE",
  };

  const r = await fetch("https://routes.googleapis.com/directions/v2:computeRoutes", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": key,
      "X-Goog-FieldMask": "routes.duration,routes.distanceMeters",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
  if (!r) return { ok: false, error: "Routes API request failed (network/timeout)" };
  if (!r.ok) return { ok: false, error: `Routes API ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)} — needs the Routes API enabled in Google Cloud Console` };

  const j = await r.json().catch(() => ({})) as RoutesApiResponse;
  const route = j.routes?.[0];
  if (!route) return { ok: false, error: "no route found" };

  const seconds = Number((route.duration ?? "").replace(/s$/, ""));
  const durationText = Number.isFinite(seconds) ? formatDuration(seconds) : undefined;
  const distanceMiles = route.distanceMeters != null ? Math.round((route.distanceMeters / 1609.34) * 10) / 10 : undefined;

  return {
    ok: true,
    durationText,
    distanceMiles,
    mapsUrl: mapsLinkFor({ destination, origin: typeof origin === "string" ? origin : undefined }),
  };
}

function formatDuration(totalSeconds: number): string {
  const mins = Math.round(totalSeconds / 60);
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

interface GeocodeApiResponse {
  status?: string;
  results?: { formatted_address?: string; geometry?: { location?: { lat?: number; lng?: number } } }[];
}

/** Address → coordinates, via the real Geocoding API (distinct from weather.ts's geocodePlace(),
 *  which uses a legacy Places workaround because Geocoding isn't enabled on the key today). */
export async function geocodeAddress(address: string): Promise<{ ok: boolean; lat?: number; lng?: number; formattedAddress?: string; mapsUrl?: string; error?: string }> {
  const key = googleApiKey();
  if (!key) return { ok: false, error: "Google Maps not configured (set CLARA_GOOGLE_MAPS_API_KEY)" };
  if (!address.trim()) return { ok: false, error: "no address given" };

  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${encodeURIComponent(key)}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(10_000) }).catch(() => null);
  if (!r?.ok) return { ok: false, error: r ? `Geocoding API HTTP ${r.status}` : "Geocoding API request failed (network/timeout)" };

  const j = await r.json().catch(() => ({})) as GeocodeApiResponse;
  if (j.status !== "OK") {
    const deniedHint = j.status === "REQUEST_DENIED" ? " — needs the Geocoding API enabled in Google Cloud Console" : "";
    return { ok: false, error: `Geocoding API status ${j.status ?? "unknown"}${deniedHint}` };
  }

  const hit = j.results?.[0];
  const loc = hit?.geometry?.location;
  if (!hit || loc?.lat == null || loc?.lng == null) return { ok: false, error: "no match" };

  return {
    ok: true,
    lat: loc.lat,
    lng: loc.lng,
    formattedAddress: hit.formatted_address,
    mapsUrl: mapsLinkFor({ at: { lat: loc.lat, lng: loc.lng } }),
  };
}
