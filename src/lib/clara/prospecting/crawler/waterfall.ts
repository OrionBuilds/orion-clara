// crawler/waterfall.ts — orchestrates http -> jina -> playwright for one page, stopping at the
// first success, then hands the winning content to evidence.ts and reports back which method won,
// what it cost, and the evidence ref — so stages.ts's crawl handler can report an accurate
// `cost_usd` and build the next stage's fan-out off real evidence.
//
// Also where the aggregator-domain check and the per-URL robots check live: a page blocked by
// either is blocked for every fetch method, so both are checked once, before rung 1, rather than
// inside each rung. The aggregator list itself is NOT duplicated here — it already exists, tested,
// at entity/normalize.ts's AGGREGATOR_DOMAINS/isAggregatorDomain; this module just re-exports it so
// a later PR (e.g. 18's ad-activity/hiring search) can reach it from the crawler namespace too.

import { httpFetch as httpFetchReal, type HttpFetchResult } from "./httpFetch";
import { jinaFetch as jinaFetchReal, type JinaFetchResult } from "./jinaViaFriday";
import { playwrightFetch as playwrightFetchReal, type PlaywrightFetchResult } from "./playwright";
import { isAllowedByRobots as isAllowedByRobotsReal } from "./robots";
import { htmlToText as htmlToTextReal, type HtmlToTextResult } from "./htmlToText";
import { writeEvidence as writeEvidenceReal, type EvidenceRef, type FetchMethod } from "./evidence";
import { isAggregatorDomain, normalizeDomain, AGGREGATOR_DOMAINS } from "../entity/normalize";
import { readProviderCalls as readProviderCallsReal } from "../ledger";

export { isAggregatorDomain, AGGREGATOR_DOMAINS } from "../entity/normalize";

/** Playwright is attempted for at most this share of a job's total crawl attempts (rung-3 is real
 *  CPU/wall-clock, not a per-call spend — see playwright.ts). */
export const PLAYWRIGHT_SHARE_CAP = 0.15;

export type CrawlSkipReason = "robots-blocked" | "aggregator-domain" | "all-rungs-failed" | "playwright-cap";

export interface CrawlPageResult {
  ok: boolean;
  url: string;
  method?: FetchMethod;
  costUsd: number;
  cached?: boolean;
  evidence?: EvidenceRef;
  reason?: CrawlSkipReason;
  error?: string;
}

export interface CrawlSiteResult {
  pages: CrawlPageResult[];
  costUsd: number;
}

export interface CrawlContext {
  jobId?: string;
  companyId?: string;
  researchJobId?: string;
}

export interface WaterfallDeps {
  httpFetch: typeof httpFetchReal;
  jinaFetch: typeof jinaFetchReal;
  playwrightFetch: typeof playwrightFetchReal;
  isAllowedByRobots: typeof isAllowedByRobotsReal;
  htmlToText: (html: string) => HtmlToTextResult;
  writeEvidence: typeof writeEvidenceReal;
  /** Playwright attempts vs. total crawl attempts recorded for this job so far — used only for the
   *  15% cap. Injected (rather than read from the ledger inline) so tests don't need a real
   *  provider-calls file on disk. */
  countPlaywrightShare: (jobId: string | undefined) => Promise<{ playwright: number; total: number }>;
}

async function countPlaywrightShareReal(jobId: string | undefined): Promise<{ playwright: number; total: number }> {
  if (!jobId) return { playwright: 0, total: 0 };
  const mine = (await readProviderCallsReal()).filter(
    (r) => r.jobId === jobId && (r.provider === "http" || r.provider === "jina" || r.provider === "playwright"),
  );
  return { playwright: mine.filter((r) => r.provider === "playwright").length, total: mine.length };
}

export const defaultWaterfallDeps: WaterfallDeps = {
  httpFetch: httpFetchReal,
  jinaFetch: jinaFetchReal,
  playwrightFetch: playwrightFetchReal,
  isAllowedByRobots: isAllowedByRobotsReal,
  htmlToText: (html: string) => htmlToTextReal(html),
  writeEvidence: writeEvidenceReal,
  countPlaywrightShare: countPlaywrightShareReal,
};

async function finalize(
  method: FetchMethod,
  rung: { costUsd?: number; cached?: boolean },
  content: { html?: string; text?: string },
  url: string,
  ctx: CrawlContext,
  deps: WaterfallDeps,
): Promise<CrawlPageResult> {
  // Jina's `.text` is already-extracted text — never re-run htmlToText on it (see
  // jinaViaFriday.ts's doc comment). http/playwright hand back raw HTML that still needs flattening.
  const text = content.text ?? deps.htmlToText(content.html ?? "").text;
  const costUsd = rung.costUsd ?? 0;

  if (!ctx.companyId) {
    return { ok: true, url, method, costUsd, cached: rung.cached };
  }

  const evidence = await deps.writeEvidence({
    companyId: ctx.companyId,
    url,
    text,
    html: content.html,
    fetchMethod: method,
    researchJobId: ctx.researchJobId,
  });
  return { ok: true, url, method, costUsd, cached: rung.cached, evidence };
}

/**
 * Fetches one URL through the http -> jina -> playwright cascade, stopping at the first success.
 * Checked once, before any rung: the URL's domain isn't a known listing aggregator, and the URL
 * isn't blocked by its origin's robots.txt — both are "blocked for every method," not just one, so
 * neither check happens per-rung.
 */
export async function crawlPage(url: string, ctx: CrawlContext, deps: WaterfallDeps = defaultWaterfallDeps): Promise<CrawlPageResult> {
  const domain = normalizeDomain(url);
  if (isAggregatorDomain(domain)) {
    return { ok: false, url, costUsd: 0, reason: "aggregator-domain", error: `${domain} is a known listing/aggregator domain, not a real company site` };
  }

  const allowed = await deps.isAllowedByRobots(url).catch(() => true);
  if (!allowed) {
    return { ok: false, url, costUsd: 0, reason: "robots-blocked", error: "disallowed by robots.txt" };
  }

  const http: HttpFetchResult = await deps.httpFetch(url, { jobId: ctx.jobId });
  if (http.ok && http.html) return finalize("http", http, { html: http.html }, url, ctx, deps);

  const jina: JinaFetchResult = await deps.jinaFetch(url, { jobId: ctx.jobId });
  if (jina.ok && jina.text) return finalize("jina", jina, { text: jina.text }, url, ctx, deps);

  // Historical share, not projected-after-this-call: a brand-new job (total=0) must be able to use
  // playwright on its very first page if http/jina both fail there — the cap only kicks in once the
  // job has actually built up enough playwright usage to be over budget.
  const counts = await deps.countPlaywrightShare(ctx.jobId);
  const currentShare = counts.total > 0 ? counts.playwright / counts.total : 0;
  if (currentShare >= PLAYWRIGHT_SHARE_CAP) {
    return {
      ok: false, url, costUsd: 0, reason: "playwright-cap",
      error: `playwright would exceed ${Math.round(PLAYWRIGHT_SHARE_CAP * 100)}% of this job's crawl attempts`,
    };
  }

  const pw: PlaywrightFetchResult = await deps.playwrightFetch(url, { jobId: ctx.jobId });
  if (pw.ok && pw.html) return finalize("playwright", pw, { html: pw.html }, url, ctx, deps);

  return {
    ok: false, url, costUsd: 0, reason: "all-rungs-failed",
    error: pw.error ?? jina.error ?? http.error ?? "every crawl rung failed",
  };
}

/** Crawls every picked page for a site, in order, through `crawlPage`. The 15% playwright cap is
 *  shared across the whole site (and the whole job) since `countPlaywrightShare` reads the job's
 *  running ledger, not a per-call counter local to this function. */
export async function crawlSite(pages: string[], ctx: CrawlContext, deps: WaterfallDeps = defaultWaterfallDeps): Promise<CrawlSiteResult> {
  const results: CrawlPageResult[] = [];
  let costUsd = 0;
  for (const url of pages) {
    const r = await crawlPage(url, ctx, deps);
    results.push(r);
    costUsd += r.costUsd;
  }
  return { pages: results, costUsd: Math.round(costUsd * 1e6) / 1e6 };
}
