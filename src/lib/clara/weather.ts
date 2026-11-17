// Clara — weather via Google's Weather API (key-based, same key as Places/Time Zone).
//
// Used two ways: a `## Weather` section in the morning brief, and the weather-affecting-your-day
// alert. That alert deliberately only fires when weather is BOTH bad AND the owner actually has to
// leave the house (see weatherAffectsDay + the caller's in-person-event gate) — without travel
// times, "it's going to rain" on a day of back-to-back video calls is noise, not assistance.
//
// Degrades to { ok: false } rather than throwing: the Weather API isn't available in every region,
// and a scan that runs every few hours must never take the scheduler down with it.

import { loadConfig } from "./config";
import { googleApiKey } from "./google-key";

const BASE = "https://weather.googleapis.com/v1";

export interface DayForecast {
  date: string;            // YYYY-MM-DD
  highF: number;
  lowF: number;
  precipProbPct: number;
  conditionCode: string;   // e.g. "RAIN", "SNOW", "CLEAR"
  description: string;
}

// Gated on coordinates as well as the key — homeLat/homeLng are optional config and the API
// can't be called without a location, so a missing coord is "not configured", not an error.
export async function weatherConfigured(): Promise<boolean> {
  if (!googleApiKey()) return false;
  const cfg = await loadConfig();
  return cfg.homeLat != null && cfg.homeLng != null;
}

async function homeCoords(at?: { lat: number; lng: number }): Promise<{ lat: number; lng: number } | null> {
  if (at) return at;
  const cfg = await loadConfig();
  if (cfg.homeLat == null || cfg.homeLng == null) return null;
  return { lat: cfg.homeLat, lng: cfg.homeLng };
}

/**
 * Resolve a free-text place ("Universal Studios", "Orlando FL") to coordinates.
 *
 * Uses the Places API (findplacefromtext), NOT the Geocoding API — same key as Weather/Time Zone
 * (see google-key.ts), but this project's key is API-restricted in Cloud Console to only the
 * services it was originally provisioned for, and Geocoding isn't one of them (confirmed via
 * REQUEST_DENIED). Places already is, per the comment above, so this reuses that grant instead of
 * asking the owner to go widen the key's restrictions for one more API.
 *
 * Returns null rather than throwing on any failure (no key, no match, network error): a bad
 * location string is a normal user-input case here, not an outage.
 */
export async function geocodePlace(query: string): Promise<{ lat: number; lng: number; label: string } | null> {
  const key = googleApiKey();
  if (!key || !query.trim()) return null;
  const url = `https://maps.googleapis.com/maps/api/place/findplacefromtext/json?input=${encodeURIComponent(query)}&inputtype=textquery&fields=geometry,formatted_address&key=${encodeURIComponent(key)}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(10_000) }).catch(() => null);
  if (!r?.ok) return null;
  const j = await r.json().catch(() => ({})) as { candidates?: { geometry?: { location?: { lat: number; lng: number } }; formatted_address?: string }[] };
  const top = j.candidates?.[0];
  const loc = top?.geometry?.location;
  if (!loc) return null;
  return { lat: loc.lat, lng: loc.lng, label: top?.formatted_address ?? query };
}

interface ApiDay {
  interval?: { startTime?: string };
  displayDate?: { year: number; month: number; day: number };
  daytimeForecast?: {
    weatherCondition?: { type?: string; description?: { text?: string } };
    precipitation?: { probability?: { percent?: number } };
  };
  maxTemperature?: { degrees?: number };
  minTemperature?: { degrees?: number };
}

function ymdFrom(d: ApiDay): string {
  if (d.displayDate) {
    const { year, month, day } = d.displayDate;
    return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }
  return (d.interval?.startTime ?? "").slice(0, 10);
}

export async function forecastDays(
  days = 3,
  at?: { lat: number; lng: number },
): Promise<{ ok: boolean; days: DayForecast[]; error?: string }> {
  const key = googleApiKey();
  if (!key) return { ok: false, days: [], error: "Google API key not configured (set CLARA_GOOGLE_MAPS_API_KEY)" };
  const coords = await homeCoords(at);
  if (!coords) return { ok: false, days: [], error: "No location — set CLARA_HOME_LAT / CLARA_HOME_LNG" };

  const url = `${BASE}/forecast/days:lookup?key=${encodeURIComponent(key)}`
    + `&location.latitude=${coords.lat}&location.longitude=${coords.lng}`
    + `&days=${Math.min(Math.max(days, 1), 10)}&unitsSystem=IMPERIAL`;

  const r = await fetch(url, { signal: AbortSignal.timeout(10_000) }).catch(() => null);
  if (!r) return { ok: false, days: [], error: "Weather API request failed (network/timeout)" };
  if (!r.ok) return { ok: false, days: [], error: `Weather API ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}` };

  const j = await r.json().catch(() => ({})) as { forecastDays?: ApiDay[] };
  const out: DayForecast[] = (j.forecastDays ?? []).map((d) => ({
    date: ymdFrom(d),
    highF: Math.round(d.maxTemperature?.degrees ?? 0),
    lowF: Math.round(d.minTemperature?.degrees ?? 0),
    precipProbPct: Math.round(d.daytimeForecast?.precipitation?.probability?.percent ?? 0),
    conditionCode: d.daytimeForecast?.weatherCondition?.type ?? "UNKNOWN",
    description: d.daytimeForecast?.weatherCondition?.description?.text ?? "",
  }));
  return { ok: true, days: out };
}

export async function currentConditions(
  at?: { lat: number; lng: number },
): Promise<{ ok: boolean; tempF?: number; conditionCode?: string; description?: string; error?: string }> {
  const key = googleApiKey();
  if (!key) return { ok: false, error: "Google API key not configured" };
  const coords = await homeCoords(at);
  if (!coords) return { ok: false, error: "No location — set CLARA_HOME_LAT / CLARA_HOME_LNG" };

  const url = `${BASE}/currentConditions:lookup?key=${encodeURIComponent(key)}`
    + `&location.latitude=${coords.lat}&location.longitude=${coords.lng}&unitsSystem=IMPERIAL`;

  const r = await fetch(url, { signal: AbortSignal.timeout(10_000) }).catch(() => null);
  if (!r) return { ok: false, error: "Weather API request failed (network/timeout)" };
  if (!r.ok) return { ok: false, error: `Weather API ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}` };

  const j = await r.json().catch(() => ({})) as {
    temperature?: { degrees?: number };
    weatherCondition?: { type?: string; description?: { text?: string } };
  };
  return {
    ok: true,
    tempF: j.temperature?.degrees != null ? Math.round(j.temperature.degrees) : undefined,
    conditionCode: j.weatherCondition?.type,
    description: j.weatherCondition?.description?.text,
  };
}

// Condition codes that mean "this changes how the day goes" regardless of probability.
const SEVERE = /SNOW|BLIZZARD|ICE|SLEET|FREEZING|HAIL|THUNDERSTORM|TORNADO|HURRICANE|WIND/i;

export function weatherAffectsDay(f: DayForecast): { affects: boolean; reason?: string } {
  if (SEVERE.test(f.conditionCode)) {
    return { affects: true, reason: `${f.description || f.conditionCode.toLowerCase()} — ${f.highF}°/${f.lowF}°` };
  }
  if (f.precipProbPct >= 60) {
    return { affects: true, reason: `${f.precipProbPct}% chance of rain — ${f.highF}°/${f.lowF}°` };
  }
  if (f.highF >= 100) return { affects: true, reason: `heat — high of ${f.highF}°` };
  if (f.lowF <= 25) return { affects: true, reason: `cold — low of ${f.lowF}°` };
  return { affects: false };
}
