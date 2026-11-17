// discovery/exaViaFriday.ts — Exa-via-FRIDAY discovery, a deliberate stub.
//
// Per Part 5's provider decisions (2026-09-30), Exa search is reached through FRIDAY's Agent-Reach
// delegation (`prospect.web_read`), never a Clara-owned key — Agent-Reach stays pinned to FRIDAY's
// `research-qa` agent. FRIDAY PR #38 (the `prospect.linkedin_lookup` / `prospect.web_read` task
// handlers) is in flight as of this writing, so the wire contract below is PROVISIONAL: shaped like
// the eventual handler, but untested against it. A non-2xx / timeout / shape mismatch is treated as
// "exa discovery unavailable this tick" — never a hard failure, since Places + Brave alone are
// enough to make progress. Rechecked once FRIDAY #38 merges.
//
// Cost: $0 in rates.json — this rides FRIDAY's shared Agent-Reach daily allowance, not a per-call
// Clara spend, so it is allowed even in `shadow` mode (see discovery/index.ts).

import { loadConfig } from "../../config";
import { interagentAuthHeaders } from "@autom8ionlab/agent-core";
import type { DiscoveredCandidate, JobSpec } from "../types";

export interface ExaCellResult {
  candidates: DiscoveredCandidate[];
  calls: number;
  error?: string;
}

export async function exaForCell(cell: { lat: number; lng: number; radiusMiles: number }, spec: JobSpec): Promise<ExaCellResult> {
  try {
    const cfg = await loadConfig();
    const base = cfg.fridayBaseUrl.replace(/\/$/, "");
    const place = spec.location.city ?? spec.location.label;
    const query = `${spec.queries[0] ?? spec.industry[0] ?? "business"} near ${place}`;
    const r = await fetch(`${base}/api/tasks/prospect.web_read`, {
      method: "POST",
      headers: { "content-type": "application/json", ...interagentAuthHeaders() },
      body: JSON.stringify({ query, lat: cell.lat, lng: cell.lng, radiusMiles: cell.radiusMiles }),
      signal: AbortSignal.timeout(20_000),
    }).catch(() => null);
    if (!r || !r.ok) return { candidates: [], calls: 0, error: "exa-via-friday not available yet" };
    const j = (await r.json().catch(() => null)) as { results?: { name?: unknown; url?: unknown }[] } | null;
    const candidates: DiscoveredCandidate[] = (j?.results ?? [])
      .filter((x): x is { name: string; url: string } => typeof x?.name === "string" && typeof x?.url === "string")
      .map((x) => ({ name: x.name, source: "exa", website_url: x.url, source_url: x.url }));
    return { candidates, calls: 1 };
  } catch (e) {
    return { candidates: [], calls: 0, error: e instanceof Error ? e.message : String(e) };
  }
}
