import { test } from "node:test";
import assert from "node:assert/strict";
import { runWebsiteChangeCheck, WEBSITE_CHANGE_SCORE_DELTA } from "./websiteChange";
import { hashContent } from "../diff";
import type { CompanyFactRow } from "../../osBridge";
import type { CompanySignalInput, SignalRunDeps } from "../types";
import type { CrawlPageResult } from "../../crawler/waterfall";

const NOW = new Date("2026-10-01T12:00:00Z");

interface Call { fieldName: string; value: string; sourceUrl?: string }
interface SignalCall { signalType: string; headline: string; scoreDelta: number; strength?: string }

function page(url: string, key: "home" | "services" | "financing", text: string, ok = true): CrawlPageResult {
  return ok
    ? { ok: true, url, method: "http", costUsd: 0, evidence: { sha: hashContent(text), companyId: "co_1", url, sourceType: key === "home" ? "homepage" : "other", htmlPath: `/x/${key}.html`, txtPath: `/x/${key}.txt`, sourceId: `src_${key}` } }
    : { ok: false, url, costUsd: 0, reason: "all-rungs-failed", error: "every crawl rung failed" };
}

function depsFor(opts: {
  existing?: CompanyFactRow[];
  texts: Record<string, string>; // txtPath -> text
  pages: Record<string, CrawlPageResult>; // url -> result
}): { deps: SignalRunDeps; writes: Call[]; signals: SignalCall[] } {
  const writes: Call[] = [];
  const signals: SignalCall[] = [];
  const deps: SignalRunDeps = {
    now: () => NOW,
    factsList: async () => opts.existing ?? [],
    writeLastCheckedFact: async (input) => {
      writes.push({ fieldName: input.fieldName, value: input.value, sourceUrl: input.sourceUrl });
    },
    fireSignal: async (input) => {
      signals.push({ signalType: input.signalType, headline: input.headline, scoreDelta: input.scoreDelta, strength: input.strength });
      return { signal: {} };
    },
    crawlPage: async (url) => opts.pages[url] ?? { ok: false, url, costUsd: 0, reason: "all-rungs-failed", error: "no fixture" },
    readFile: async (p) => {
      if (!(p in opts.texts)) throw new Error(`no fixture text for ${p}`);
      return opts.texts[p];
    },
    cachedCall: (async () => ({ cached: false, costUsd: 0 })) as SignalRunDeps["cachedCall"],
    getPlaceDetails: async () => ({ ok: true }),
    webSearch: async () => ({ ok: false, results: [], error: "not used in this test" }),
    findBusiness: async () => ({ ok: false, candidates: [], error: "not used in this test" }),
    lookupHillsboroughPermits: async () => [],
    lookupPinellasPermits: async () => [],
    runTier: async () => ({ ok: false, engine: "lmstudio", error: "not used in this test" }),
    allowLive: false,
  };
  return { deps, writes, signals };
}

const company: CompanySignalInput = { id: "co_1", website_url: "https://acme.com" };

test("no website_url — skips cleanly, never crawls", async () => {
  const { deps } = depsFor({ texts: {}, pages: {} });
  const r = await runWebsiteChangeCheck({ id: "co_1" }, deps);
  assert.equal(r.ran, false);
  assert.equal(r.skippedReason, "no website_url");
  assert.equal(r.signalFired, false);
});

test("first-ever scan (no prior hashes): baseline only, no signal fires", async () => {
  const texts = { "/x/home.txt": "Home page text", "/x/services.txt": "Services page text", "/x/financing.txt": "Financing page text" };
  const pages = {
    "https://acme.com/": page("https://acme.com/", "home", texts["/x/home.txt"]),
    "https://acme.com/services": page("https://acme.com/services", "services", texts["/x/services.txt"]),
    "https://acme.com/financing": page("https://acme.com/financing", "financing", texts["/x/financing.txt"]),
  };
  const { deps, writes, signals } = depsFor({ existing: [], texts, pages });
  const r = await runWebsiteChangeCheck(company, deps);
  assert.equal(r.ran, true);
  assert.equal(r.changed, false);
  assert.equal(r.signalFired, false);
  assert.equal(r.homepageChanged, false);
  assert.equal(signals.length, 0);
  // Still writes all 3 last-checked facts, establishing the baseline for next time.
  assert.equal(writes.length, 3);
  assert.deepEqual(writes.map((w) => w.fieldName).sort(), ["financing_hash", "services_hash", "website_hash"]);
});

test("home page text changed -> fires website_change with the exact registered score_delta", async () => {
  const homeText = "New homepage copy.";
  const servicesText = "Services page text";
  const financingText = "Financing page text";
  const existing: CompanyFactRow[] = [
    { id: "f1", field_name: "website_hash", value: hashContent("Old homepage copy."), source_type: "website_page" },
    { id: "f2", field_name: "services_hash", value: hashContent(servicesText), source_type: "website_page" },
    { id: "f3", field_name: "financing_hash", value: hashContent(financingText), source_type: "website_page" },
  ];
  const texts = { "/x/home.txt": homeText, "/x/services.txt": servicesText, "/x/financing.txt": financingText };
  const pages = {
    "https://acme.com/": page("https://acme.com/", "home", homeText),
    "https://acme.com/services": page("https://acme.com/services", "services", servicesText),
    "https://acme.com/financing": page("https://acme.com/financing", "financing", financingText),
  };
  const { deps, signals } = depsFor({ existing, texts, pages });
  const r = await runWebsiteChangeCheck(company, deps);
  assert.equal(r.changed, true);
  assert.equal(r.homepageChanged, true);
  assert.equal(r.signalFired, true);
  assert.equal(signals.length, 1);
  assert.equal(signals[0].signalType, "website_change");
  assert.equal(signals[0].scoreDelta, WEBSITE_CHANGE_SCORE_DELTA);
  assert.match(signals[0].headline, /home/);
});

test("services page changed but homepage unchanged -> fires, but homepageChanged stays false (tech-change's sequencing gate)", async () => {
  const homeText = "Same homepage.";
  const servicesText = "New services copy.";
  const financingText = "Financing page text";
  const existing: CompanyFactRow[] = [
    { id: "f1", field_name: "website_hash", value: hashContent(homeText), source_type: "website_page" },
    { id: "f2", field_name: "services_hash", value: hashContent("Old services copy."), source_type: "website_page" },
    { id: "f3", field_name: "financing_hash", value: hashContent(financingText), source_type: "website_page" },
  ];
  const texts = { "/x/home.txt": homeText, "/x/services.txt": servicesText, "/x/financing.txt": financingText };
  const pages = {
    "https://acme.com/": page("https://acme.com/", "home", homeText),
    "https://acme.com/services": page("https://acme.com/services", "services", servicesText),
    "https://acme.com/financing": page("https://acme.com/financing", "financing", financingText),
  };
  const { deps } = depsFor({ existing, texts, pages });
  const r = await runWebsiteChangeCheck(company, deps);
  assert.equal(r.changed, true);
  assert.equal(r.homepageChanged, false);
  assert.equal(r.signalFired, true);
});

test("a page that fails to crawl is skipped gracefully — no crash, no fact written for it, others still processed", async () => {
  const homeText = "Home page text";
  const existing: CompanyFactRow[] = [{ id: "f1", field_name: "website_hash", value: hashContent(homeText), source_type: "website_page" }];
  const texts = { "/x/home.txt": homeText };
  const pages = {
    "https://acme.com/": page("https://acme.com/", "home", homeText),
    "https://acme.com/services": page("https://acme.com/services", "services", "", false),
    "https://acme.com/financing": page("https://acme.com/financing", "financing", "", false),
  };
  const { deps, writes } = depsFor({ existing, texts, pages });
  const r = await runWebsiteChangeCheck(company, deps);
  assert.equal(r.ran, true);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].fieldName, "website_hash");
  assert.ok(r.notes.some((n) => n.includes("services")));
  assert.ok(r.notes.some((n) => n.includes("financing")));
});

test("homepage html is captured for tech-change reuse when the crawl rung returned one", async () => {
  const homeText = "Home page text";
  const texts = { "/x/home.txt": homeText, "/x/home.html": "<html>raw</html>", "/x/services.txt": "s", "/x/financing.txt": "f" };
  const pages = {
    "https://acme.com/": page("https://acme.com/", "home", homeText),
    "https://acme.com/services": page("https://acme.com/services", "services", "s"),
    "https://acme.com/financing": page("https://acme.com/financing", "financing", "f"),
  };
  const { deps } = depsFor({ existing: [], texts, pages });
  const r = await runWebsiteChangeCheck(company, deps);
  assert.equal(r.homepageHtml, "<html>raw</html>");
  assert.equal(r.homepageText, homeText);
});
