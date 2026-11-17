// Clara — Google Time Zone API (key-based, same key as Places/Weather).
//
// Clara runs everything on server local time (one owner, one machine). This exists for the
// cases where that assumption breaks: resolving what time it actually is somewhere the owner is
// travelling to, or interpreting a business's hours in its own zone rather than the owner's.

import { googleApiKey } from "./google-key";

export async function timeZoneAt(
  lat: number,
  lng: number,
  atUnixSec: number = Math.floor(Date.now() / 1000),
): Promise<{ ok: boolean; timeZoneId?: string; timeZoneName?: string; rawOffsetSec?: number; dstOffsetSec?: number; error?: string }> {
  const key = googleApiKey();
  if (!key) return { ok: false, error: "Google API key not configured (set CLARA_GOOGLE_MAPS_API_KEY)" };

  const url = `https://maps.googleapis.com/maps/api/timezone/json`
    + `?location=${lat},${lng}&timestamp=${atUnixSec}&key=${encodeURIComponent(key)}`;

  const r = await fetch(url, { signal: AbortSignal.timeout(10_000) }).catch(() => null);
  if (!r) return { ok: false, error: "Time Zone API request failed (network/timeout)" };
  if (!r.ok) return { ok: false, error: `Time Zone API ${r.status}` };

  const j = await r.json().catch(() => ({})) as {
    status?: string; timeZoneId?: string; timeZoneName?: string;
    rawOffset?: number; dstOffset?: number; errorMessage?: string;
  };
  // This API signals failure in the body with HTTP 200, not via status code.
  if (j.status !== "OK") return { ok: false, error: j.errorMessage ?? j.status ?? "unknown Time Zone API error" };

  return {
    ok: true,
    timeZoneId: j.timeZoneId,
    timeZoneName: j.timeZoneName,
    rawOffsetSec: j.rawOffset,
    dstOffsetSec: j.dstOffset,
  };
}
