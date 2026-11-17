// discovery/braveSearch.ts — Brave web-search discovery for one grid cell.
//
// Catches companies Places misses (no Google Business Profile, or ranked poorly for the search
// term) via a general web search scoped to the cell's city/region. Deduped by hostname.

import { webSearch, braveSearchConfigured } from "../../brave-search";
import type { DiscoveredCandidate, JobSpec } from "../types";

function hostnameOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return undefined;
  }
}

export interface BraveCellResult {
  candidates: DiscoveredCandidate[];
  calls: number;
  error?: string;
}

export async function braveForCell(cell: { lat: number; lng: number; radiusMiles: number }, spec: JobSpec): Promise<BraveCellResult> {
  if (!braveSearchConfigured()) return { candidates: [], calls: 0, error: "Brave Search not configured (CLARA_BRAVE_SEARCH_API_KEY)" };
  const place = spec.location.city
    ? `${spec.location.city}${spec.location.state ? `, ${spec.location.state}` : ""}`
    : spec.location.label;
  const queries = spec.queries.length ? spec.queries : spec.industry;
  const seen = new Map<string, DiscoveredCandidate>();
  let calls = 0;
  let lastError: string | undefined;
  for (const q of queries) {
    calls++;
    const r = await webSearch(`${q} ${place}`, { count: 10 });
    if (!r.ok) { lastError = r.error; continue; }
    for (const res of r.results) {
      const host = hostnameOf(res.url);
      if (!host) continue;
      if (!seen.has(host)) {
        seen.set(host, {
          name: res.title.replace(/\s*[-|].*$/, "").trim() || host,
          source: "brave",
          website_url: `https://${host}`,
          source_url: res.url,
          category_hint: res.snippet,
        });
      }
    }
  }
  return { candidates: [...seen.values()], calls, error: seen.size ? undefined : lastError };
}
