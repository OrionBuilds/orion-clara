// crawler/httpFetch.ts — waterfall rung 1: a plain fetch(), $0 to any paid provider.
//
// Robots-txt gating lives in the waterfall, not here (a page blocked by robots is blocked for
// every fetch method, not just this one — see waterfall.ts/robots.ts). This module just does the
// raw HTTP GET, cached 14d under the shared "crawl" cache kind (cache.ts), same cachedCall/ledger
// pattern discovery/index.ts uses for Places/Brave.

import { cachedCall, cacheKey } from "../cache";
import { BOT_INFO_URL } from "../branding";

export const HTTP_USER_AGENT = `Mozilla/5.0 (compatible; ClaraProspectBot/1.0; +${BOT_INFO_URL})`;

// rates.json's http_fetch: 0 — a direct fetch costs nothing beyond CLARA's own compute.
const HTTP_FETCH_COST_USD = 0;

export interface HttpFetchResult {
  ok: boolean;
  status?: number;
  html?: string;
  error?: string;
  cached?: boolean;
  costUsd?: number;
}

export interface HttpFetchOpts {
  jobId?: string;
  /** false (shadow mode) makes a cache miss a no-op instead of a live fetch — matching every other
   *  provider call in this engine. Defaults true since a plain HTTP GET is free either way; callers
   *  that want shadow-mode-safe behavior pass this explicitly (see stages.ts's crawl handler). */
  allowLive?: boolean;
  timeoutMs?: number;
}

interface RawFetchValue {
  ok: boolean;
  status?: number;
  html?: string;
  error?: string;
}

async function rawFetch(url: string, timeoutMs: number): Promise<RawFetchValue> {
  try {
    const r = await fetch(url, {
      headers: { "user-agent": HTTP_USER_AGENT, accept: "text/html,application/xhtml+xml" },
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const contentType = r.headers.get("content-type") ?? "";
    if (!r.ok) return { ok: false, status: r.status, error: `http ${r.status}` };
    if (contentType && !contentType.includes("html") && !contentType.includes("text")) {
      return { ok: false, status: r.status, error: `unsupported content-type: ${contentType}` };
    }
    const html = await r.text();
    return { ok: true, status: r.status, html };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Fetches `url` directly. A non-2xx status, non-HTML content-type, timeout (10-15s) or network
 *  error all come back as `{ok:false, error}` rather than throwing — the waterfall treats that as
 *  "this rung failed, try the next one." */
export async function httpFetch(url: string, opts: HttpFetchOpts = {}): Promise<HttpFetchResult> {
  const r = await cachedCall<RawFetchValue>({
    provider: "http",
    kind: "crawl",
    key: cacheKey([url]),
    jobId: opts.jobId,
    costUsd: HTTP_FETCH_COST_USD,
    allowLive: opts.allowLive ?? true,
    fn: () => rawFetch(url, opts.timeoutMs ?? 12_000),
  });
  if (r.skipped) return { ok: false, error: "http fetch skipped (shadow mode, nothing cached yet)" };
  const value = r.value ?? { ok: false, error: "http fetch failed" };
  return { ...value, cached: r.cached, costUsd: r.costUsd };
}
