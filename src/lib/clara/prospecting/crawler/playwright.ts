// crawler/playwright.ts — waterfall rung 3: a local headless Chromium render, for JS-heavy sites
// http and Jina both choked on.
//
// LOCAL ONLY — no paid-provider spend (rates.json's playwright_render: 0, same "$0, it's our own
// compute" convention as llm_t1_call/llm_t2_call_lmstudio) — but real CPU/wall-clock, which is why
// the waterfall caps how often this rung is even attempted at 15% of a job's crawl attempts (see
// waterfall.ts; this module has no opinion on that cap, it just renders when asked).
//
// A single browser + context is reused across calls within this process (module-level singleton,
// lazily created on first use, one launch attempt ever — a failed launch is remembered as
// "unavailable" rather than retried every call) instead of spawning a new Chromium per page.
// closePlaywright() tears it down for tests/process shutdown. Chromium only (not firefox/webkit) to
// keep the install footprint down. If the `playwright` package or its Chromium binary genuinely
// isn't installed in this environment, every call degrades to `{ok:false, error:"playwright
// unavailable"}` rather than throwing — the waterfall treats that exactly like any other rung
// failure.

import { cachedCall, cacheKey } from "../cache";
import { BOT_INFO_URL } from "../branding";

// rates.json's playwright_render: 0 — local compute, not a paid provider call.
const PLAYWRIGHT_RENDER_COST_USD = 0;

export const PLAYWRIGHT_USER_AGENT = `Mozilla/5.0 (compatible; ClaraProspectBot/1.0; +${BOT_INFO_URL})`;

export interface PlaywrightFetchResult {
  ok: boolean;
  html?: string;
  error?: string;
  cached?: boolean;
  costUsd?: number;
}

export interface PlaywrightFetchOpts {
  jobId?: string;
  allowLive?: boolean;
  timeoutMs?: number;
}

interface RawPlaywrightValue {
  ok: boolean;
  html?: string;
  error?: string;
}

// Minimal structural types for the two playwright objects this module touches — avoids a hard
// top-level type dependency on the `playwright` package (only reachable via the dynamic import
// below), so this file still type-checks in an environment where `playwright` isn't installed.
interface MinimalPage {
  goto(url: string, opts: { waitUntil: "domcontentloaded"; timeout: number }): Promise<unknown>;
  content(): Promise<string>;
  close(): Promise<void>;
}
interface MinimalContext {
  newPage(): Promise<MinimalPage>;
  close(): Promise<void>;
}
interface MinimalBrowser {
  close(): Promise<void>;
}
interface BrowserHandle {
  browser: MinimalBrowser;
  context: MinimalContext;
}

let handlePromise: Promise<BrowserHandle | null> | null = null;

async function launchHandle(): Promise<BrowserHandle | null> {
  try {
    // Dynamic import: a missing `playwright` package must not break `tsc`/the build for everyone
    // else — only this rung degrades.
    const mod = (await import("playwright")) as unknown as {
      chromium: { launch(opts: { headless: boolean }): Promise<MinimalBrowser & { newContext(opts: { userAgent: string }): Promise<MinimalContext> }> };
    };
    const browser = await mod.chromium.launch({ headless: true });
    const context = await browser.newContext({ userAgent: PLAYWRIGHT_USER_AGENT });
    return { browser, context };
  } catch {
    return null;
  }
}

function getHandle(): Promise<BrowserHandle | null> {
  if (!handlePromise) handlePromise = launchHandle();
  return handlePromise;
}

async function rawRender(url: string, timeoutMs: number): Promise<RawPlaywrightValue> {
  const handle = await getHandle();
  if (!handle) return { ok: false, error: "playwright unavailable" };
  let page: MinimalPage | undefined;
  try {
    page = await handle.context.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    const html = await page.content();
    return { ok: true, html };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    await page?.close().catch(() => {});
  }
}

/** Renders `url` with a real local Chromium and returns its post-JS HTML. Never throws. */
export async function playwrightFetch(url: string, opts: PlaywrightFetchOpts = {}): Promise<PlaywrightFetchResult> {
  const r = await cachedCall<RawPlaywrightValue>({
    provider: "playwright",
    kind: "crawl",
    key: cacheKey([url]),
    jobId: opts.jobId,
    costUsd: PLAYWRIGHT_RENDER_COST_USD,
    allowLive: opts.allowLive ?? true,
    fn: () => rawRender(url, opts.timeoutMs ?? 15_000),
  });
  if (r.skipped) return { ok: false, error: "playwright fetch skipped (shadow mode, nothing cached yet)" };
  const value = r.value ?? { ok: false, error: "playwright render failed" };
  return { ...value, cached: r.cached, costUsd: r.costUsd };
}

/** Tears down the shared browser/context, if one was ever launched. For tests and graceful process
 *  shutdown — not required for correctness during normal operation. */
export async function closePlaywright(): Promise<void> {
  const pending = handlePromise;
  handlePromise = null;
  const handle = pending ? await pending.catch(() => null) : null;
  if (handle) {
    await handle.context.close().catch(() => {});
    await handle.browser.close().catch(() => {});
  }
}
