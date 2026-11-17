import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSunbizPageText, buildSunbizSearchUrl, lookupSunbiz, type SunbizDeps } from "./flSunbiz";
import { ttlMs } from "../cache";
import type { CrawlPageResult } from "../crawler/waterfall";

test("buildSunbizSearchUrl: builds a search.sunbiz.org SearchResults URL carrying the business name", () => {
  const url = buildSunbizSearchUrl("Ace Roofing LLC");
  assert.ok(url.startsWith("https://search.sunbiz.org/Inquiry/CorporationSearch/SearchResults?"));
  assert.ok(url.includes("Ace"));
});

// A fixture shaped like the researched real Sunbiz detail-page label layout (module header comment).
const FIXTURE_PAGE_TEXT = `
Detail by Entity Name
Florida Limited Liability Company
ACE ROOFING LLC
Filing Information
Document Number L12000012345
FEI/EIN Number 12-3456789
Date Filed 01/15/2012
Status
Active
Last Event
NONE
Principal Address
123 Main St
Tampa, FL 33602
Registered Agent Name & Address
Smith, John
123 Main St
Tampa, FL 33602
`;

test("parseSunbizPageText: parses document number, status and registered agent off a detail page", () => {
  const [record] = parseSunbizPageText(FIXTURE_PAGE_TEXT, "Ace Roofing LLC");
  assert.ok(record);
  assert.equal(record.documentNumber, "L12000012345");
  assert.equal(record.status, "Active");
  assert.equal(record.statusActive, true);
  assert.ok(record.registeredAgentName?.includes("Smith"));
  assert.equal(record.filingDate, "01/15/2012");
});

test("parseSunbizPageText: an inactive entity's status is reported, statusActive false", () => {
  const inactiveText = FIXTURE_PAGE_TEXT.replace("Active", "Inactive");
  const [record] = parseSunbizPageText(inactiveText, "Ace Roofing LLC");
  assert.equal(record.status, "Inactive");
  assert.equal(record.statusActive, false);
});

test("parseSunbizPageText: text with no 'Document Number' at all yields no records", () => {
  const records = parseSunbizPageText("No records were found based on your entered criteria.", "Nobody LLC");
  assert.deepEqual(records, []);
});

test("parseSunbizPageText: multiple result blocks each parse independently", () => {
  const two = FIXTURE_PAGE_TEXT + "\n" + FIXTURE_PAGE_TEXT.replace("L12000012345", "L99000099999");
  const records = parseSunbizPageText(two, "Ace Roofing LLC");
  assert.equal(records.length, 2);
  assert.ok(records.some((r) => r.documentNumber === "L12000012345"));
  assert.ok(records.some((r) => r.documentNumber === "L99000099999"));
});

test("cache.ts's sunbiz TTL is 90 days — flSunbiz.ts relies on this, not a hardcoded constant", () => {
  assert.equal(ttlMs("sunbiz"), 90 * 24 * 3600_000);
});

function fakeDeps(overrides: Partial<SunbizDeps> = {}): SunbizDeps {
  return {
    crawlPage: async (_url, _ctx) => ({ ok: true, url: _url, costUsd: 0, evidence: { sha: "x", companyId: "c1", url: _url, sourceType: "other", txtPath: "/fake/sunbiz.txt" } } as CrawlPageResult),
    cachedCall: (async (args: { fn: () => Promise<unknown> }) => {
      const value = await args.fn();
      return { value, cached: false, costUsd: 0 };
    }) as SunbizDeps["cachedCall"],
    readFile: async () => FIXTURE_PAGE_TEXT,
    ...overrides,
  };
}

test("lookupSunbiz: a successful crawl + parse returns records", async () => {
  const deps = fakeDeps();
  const records = await lookupSunbiz("Ace Roofing LLC", "company-1", { allowLive: true }, deps);
  assert.equal(records.length, 1);
  assert.equal(records[0].documentNumber, "L12000012345");
});

test("lookupSunbiz: a failed crawl degrades to []", async () => {
  const deps = fakeDeps({
    crawlPage: async (url) => ({ ok: false, url, costUsd: 0, reason: "all-rungs-failed", error: "nope" }) as CrawlPageResult,
  });
  const records = await lookupSunbiz("Nobody LLC", "company-1", { allowLive: true }, deps);
  assert.deepEqual(records, []);
});

test("lookupSunbiz: an empty business name returns [] without crawling", async () => {
  let called = false;
  const deps = fakeDeps({ crawlPage: async (url) => { called = true; return { ok: true, url, costUsd: 0 } as CrawlPageResult; } });
  const records = await lookupSunbiz("   ", "company-1", { allowLive: true }, deps);
  assert.deepEqual(records, []);
  assert.equal(called, false);
});
