import { test } from "node:test";
import assert from "node:assert/strict";
import { runTechChangeCheck, signatureSetHash, TECH_CHANGE_SCORE_DELTA, TECH_SCAN_FIELD } from "./techChange";
import type { CompanyFactRow } from "../../osBridge";
import type { CompanySignalInput, SignalRunDeps } from "../types";
import type { CrawlPageResult } from "../../crawler/waterfall";

const NOW = new Date("2026-10-01T12:00:00Z");
const company: CompanySignalInput = { id: "co_1", website_url: "https://acme.com" };

// A fixture with a recognizable signature (HubSpot's embed script) so matchSignatures finds
// something real, not just an empty set.
const HTML_WITH_HUBSPOT = `<html><head><script src="https://js.hs-scripts.com/123456.js"></script></head><body>Hi</body></html>`;
const HTML_PLAIN = `<html><head></head><body>Nothing special here.</body></html>`;

interface SignalCall { signalType: string; headline: string; scoreDelta: number }

function depsFor(opts: { existing?: CompanyFactRow[]; crawlResult?: CrawlPageResult; htmlFiles?: Record<string, string> }): { deps: SignalRunDeps; signals: SignalCall[]; writes: { fieldName: string; value: string }[] } {
  const signals: SignalCall[] = [];
  const writes: { fieldName: string; value: string }[] = [];
  const deps: SignalRunDeps = {
    now: () => NOW,
    factsList: async () => opts.existing ?? [],
    writeLastCheckedFact: async (input) => {
      writes.push({ fieldName: input.fieldName, value: input.value });
    },
    fireSignal: async (input) => {
      signals.push({ signalType: input.signalType, headline: input.headline, scoreDelta: input.scoreDelta });
      return { signal: {} };
    },
    crawlPage: async (url) =>
      opts.crawlResult ?? { ok: true, url, method: "http", costUsd: 0, evidence: { sha: "s", companyId: "co_1", url, sourceType: "homepage", htmlPath: "/x/home.html", txtPath: "/x/home.txt", sourceId: "s1" } },
    readFile: async (p) => {
      if (opts.htmlFiles && p in opts.htmlFiles) return opts.htmlFiles[p];
      throw new Error(`no fixture for ${p}`);
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
  return { deps, signals, writes };
}

test("signatureSetHash: pure, sorted, dedupe-stable", () => {
  const a = signatureSetHash(HTML_WITH_HUBSPOT);
  assert.ok(a.names.includes("HubSpot"));
  const b = signatureSetHash(HTML_WITH_HUBSPOT);
  assert.equal(a.hash, b.hash);
});

test("signatureSetHash: different signature sets hash differently", () => {
  const a = signatureSetHash(HTML_WITH_HUBSPOT);
  const b = signatureSetHash(HTML_PLAIN);
  assert.notEqual(a.hash, b.hash);
});

test("no website_url — skips, never crawls", async () => {
  const { deps } = depsFor({});
  const r = await runTechChangeCheck({ id: "co_1" }, deps);
  assert.equal(r.ran, false);
  assert.equal(r.skippedReason, "no website_url");
});

test("sequencing gate: ctx.homepageChanged === false skips WITHOUT running (no crawl, no facts read)", async () => {
  let crawled = false;
  const deps: SignalRunDeps = {
    now: () => NOW,
    factsList: async () => { throw new Error("should not be called when the sequencing gate skips"); },
    writeLastCheckedFact: async () => { throw new Error("should not write"); },
    fireSignal: async () => { throw new Error("should not fire"); },
    crawlPage: async (url) => { crawled = true; return { ok: true, url, costUsd: 0 }; },
    readFile: async () => "",
    cachedCall: (async () => ({ cached: false, costUsd: 0 })) as SignalRunDeps["cachedCall"],
    getPlaceDetails: async () => ({ ok: true }),
    webSearch: async () => ({ ok: false, results: [], error: "not used in this test" }),
    findBusiness: async () => ({ ok: false, candidates: [], error: "not used in this test" }),
    lookupHillsboroughPermits: async () => [],
    lookupPinellasPermits: async () => [],
    runTier: async () => ({ ok: false, engine: "lmstudio", error: "not used in this test" }),
    allowLive: false,
  };
  const r = await runTechChangeCheck(company, deps, { homepageChanged: false });
  assert.equal(r.ran, false);
  assert.equal(r.skippedReason, "homepage_unchanged");
  assert.equal(crawled, false);
});

test("ctx.homepageChanged === true with homepageHtml provided: reuses it, no re-crawl", async () => {
  let crawled = false;
  const base = depsFor({ existing: [], htmlFiles: {} });
  const deps: SignalRunDeps = { ...base.deps, crawlPage: async (url) => { crawled = true; return { ok: true, url, costUsd: 0 }; } };
  const r = await runTechChangeCheck(company, deps, { homepageChanged: true, homepageHtml: HTML_WITH_HUBSPOT });
  assert.equal(crawled, false);
  assert.equal(r.ran, true);
});

test("first-ever tech scan (no prior hash): baseline only, no signal", async () => {
  const { deps, signals, writes } = depsFor({ existing: [] });
  const r = await runTechChangeCheck(company, deps, { homepageChanged: true, homepageHtml: HTML_WITH_HUBSPOT });
  assert.equal(r.changed, false);
  assert.equal(r.signalFired, false);
  assert.equal(signals.length, 0);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].fieldName, TECH_SCAN_FIELD);
});

test("signature set changed from last scan -> fires with the exact registered score_delta", async () => {
  const prevHash = signatureSetHash(HTML_PLAIN).hash;
  const existing: CompanyFactRow[] = [{ id: "f1", field_name: TECH_SCAN_FIELD, value: prevHash, source_type: "derived" }];
  const { deps, signals } = depsFor({ existing });
  const r = await runTechChangeCheck(company, deps, { homepageChanged: true, homepageHtml: HTML_WITH_HUBSPOT });
  assert.equal(r.changed, true);
  assert.equal(r.signalFired, true);
  assert.equal(signals.length, 1);
  assert.equal(signals[0].scoreDelta, TECH_CHANGE_SCORE_DELTA);
  assert.match(signals[0].headline, /HubSpot/);
});

test("signature set unchanged from last scan -> no signal", async () => {
  const prevHash = signatureSetHash(HTML_WITH_HUBSPOT).hash;
  const existing: CompanyFactRow[] = [{ id: "f1", field_name: TECH_SCAN_FIELD, value: prevHash, source_type: "derived" }];
  const { deps, signals } = depsFor({ existing });
  const r = await runTechChangeCheck(company, deps, { homepageChanged: true, homepageHtml: HTML_WITH_HUBSPOT });
  assert.equal(r.changed, false);
  assert.equal(signals.length, 0);
});

test("no ctx at all (standalone call): falls back to its own crawl", async () => {
  const crawlResult: CrawlPageResult = { ok: true, url: "https://acme.com/", method: "http", costUsd: 0, evidence: { sha: "s", companyId: "co_1", url: "https://acme.com/", sourceType: "homepage", htmlPath: "/x/home.html", txtPath: "/x/home.txt" } };
  const { deps } = depsFor({ existing: [], crawlResult, htmlFiles: { "/x/home.html": HTML_WITH_HUBSPOT } });
  const r = await runTechChangeCheck(company, deps);
  assert.equal(r.ran, true);
});

test("no ctx, crawl succeeds but with no raw html (jina-only) -> graceful skip, not a crash", async () => {
  const crawlResult: CrawlPageResult = { ok: true, url: "https://acme.com/", method: "jina", costUsd: 0, evidence: { sha: "s", companyId: "co_1", url: "https://acme.com/", sourceType: "homepage", txtPath: "/x/home.txt" } };
  const { deps } = depsFor({ existing: [], crawlResult });
  const r = await runTechChangeCheck(company, deps);
  assert.equal(r.ran, false);
  assert.equal(r.skippedReason, "no_html");
});
