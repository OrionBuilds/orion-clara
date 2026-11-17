// crawler/jinaViaFriday.ts — waterfall rung 2: FRIDAY's Agent-Reach Jina page read.
//
// Rides FRIDAY's shared Agent-Reach daily allowance, not a Clara-owned key or per-call Clara spend
// (rates.json's jina_read: 0) — same arrangement discovery/exaViaFriday.ts already uses for Exa.
//
// IMPORTANT: Jina returns pre-extracted TEXT, not raw HTML — `.text` below is already stripped of
// markup by the reader on FRIDAY's side. Callers (the waterfall, and anything downstream of it)
// must NOT run htmlToText on it; treat it as the final text directly. This is why the waterfall's
// unified per-page result carries both `rawHtml?` (from httpFetch/playwright) and `text?` (from
// this module), so a caller always knows which shape it got instead of guessing.

import { postProspectLookup } from "@autom8ionlab/agent-core";
import { loadConfig } from "../../config";
import { cachedCall, cacheKey } from "../cache";

// rates.json's jina_read: 0 — metered on FRIDAY's side, not billed to Clara's own ledger.
const JINA_READ_COST_USD = 0;

export interface JinaFetchResult {
  ok: boolean;
  /** Pre-extracted text (Jina's reader output) — NOT html. See module doc comment. */
  text?: string;
  error?: string;
  cached?: boolean;
  costUsd?: number;
}

export interface JinaFetchOpts {
  jobId?: string;
  allowLive?: boolean;
  fridayBaseUrl?: string;
  timeoutMs?: number;
}

interface RawJinaValue {
  ok: boolean;
  text?: string;
  error?: string;
}

async function rawJinaFetch(url: string, fridayBaseUrl: string | undefined, timeoutMs: number | undefined): Promise<RawJinaValue> {
  const base = fridayBaseUrl ?? (await loadConfig()).fridayBaseUrl;
  const res = await postProspectLookup(
    base,
    { from: "clara", kind: "prospect.web_read", input: { mode: "read", url } },
    timeoutMs ? { timeoutMs } : undefined,
  );
  if (res.ok && res.kind === "prospect.web_read") {
    if (typeof res.text === "string" && res.text.trim()) return { ok: true, text: res.text };
    return { ok: false, error: "jina returned no text" };
  }
  return { ok: false, error: res.ok ? `unexpected prospect lookup kind: ${res.kind}` : res.error };
}

/** Reads `url` through FRIDAY's prospect.web_read delegation (Jina). Never throws — any failure
 *  (FRIDAY unreachable, reach-guard refused/locked, malformed response) comes back as
 *  `{ok:false, error}` so the waterfall just moves on to the next rung. */
export async function jinaFetch(url: string, opts: JinaFetchOpts = {}): Promise<JinaFetchResult> {
  const r = await cachedCall<RawJinaValue>({
    provider: "jina",
    kind: "crawl",
    key: cacheKey([url]),
    jobId: opts.jobId,
    costUsd: JINA_READ_COST_USD,
    allowLive: opts.allowLive ?? true,
    fn: () => rawJinaFetch(url, opts.fridayBaseUrl, opts.timeoutMs),
  });
  if (r.skipped) return { ok: false, error: "jina fetch skipped (shadow mode, nothing cached yet)" };
  const value = r.value ?? { ok: false, error: "jina fetch failed" };
  return { ...value, cached: r.cached, costUsd: r.costUsd };
}
