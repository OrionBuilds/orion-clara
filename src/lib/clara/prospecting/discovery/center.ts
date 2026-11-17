// discovery/center.ts — resolve a job's search center before the hex grid is built.
//
// The planner fills location.label/city/state but never lat/lng, and every grid builder used
// `lat ?? 0, lng ?? 0`. The Oct 1 Hillsborough job therefore searched 19 cells around (0,0), in the
// Gulf of Guinea. A job with no resolvable center now refuses to seed instead of searching the ocean.

import type { JobSpec } from "../types";

export type Geocoder = (query: string) => Promise<{ lat: number; lng: number } | null>;

async function defaultGeocoder(query: string): Promise<{ lat: number; lng: number } | null> {
  const { geocodePlace } = await import("../../weather");
  const p = await geocodePlace(query).catch(() => null);
  if (p) return { lat: p.lat, lng: p.lng };
  const { geocodeAddress } = await import("../../maps");
  const g = await geocodeAddress(query).catch(() => null);
  return g?.ok && typeof g.lat === "number" && typeof g.lng === "number" ? { lat: g.lat, lng: g.lng } : null;
}

export function hasRealCenter(loc: JobSpec["location"]): boolean {
  return typeof loc.lat === "number" && typeof loc.lng === "number" && Number.isFinite(loc.lat) && Number.isFinite(loc.lng) && !(loc.lat === 0 && loc.lng === 0);
}

/** The spec with a real lat/lng, or an error naming the location that couldn't be found. */
export async function resolveCenter(spec: JobSpec, geocode: Geocoder = defaultGeocoder): Promise<{ ok: true; spec: JobSpec } | { ok: false; error: string }> {
  if (hasRealCenter(spec.location)) return { ok: true, spec };
  const label = [spec.location.label, spec.location.state].filter(Boolean).join(", ");
  const hit = await geocode(label);
  if (!hit || (hit.lat === 0 && hit.lng === 0)) return { ok: false, error: `couldn't find "${spec.location.label}" on the map — refusing to search` };
  return { ok: true, spec: { ...spec, location: { ...spec.location, lat: hit.lat, lng: hit.lng } } };
}
