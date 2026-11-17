import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseDbprExtract,
  isRoofingRelevantLicense,
  isDbprCacheFresh,
  refreshDbprCache,
  lookupDbpr,
  resetDbprMemoCacheForTests,
  DBPR_CACHE_TTL_DAYS,
  type DbprDeps,
  type DbprCacheFile,
} from "./flDbpr";

// Literal fixture rows shaped like DBPR_COLUMNS's documented layout (module header comment): Board
// Number, Occupation Code, Licensee Name, Business Name, Class Code, Address1/2/3, City, State, Zip,
// County Code, License Number, Primary Status, Secondary Status, Original Licensure Date, Effective
// Date, Expiration Date, Renewal Period, Alternate Lic#.
const FIXTURE_ROWS = [
  '12345,ROOF,"Smith, John",Ace Roofing LLC,CCC,123 Main St,,,Tampa,FL,33602,57,CCC1234567,Current,,01/01/2010,01/01/2020,01/01/2024,Biennial,',
  '12346,GC,"Doe, Jane",Doe Construction Inc,CGC,456 Oak Ave,,,Clearwater,FL,33755,52,CGC7654321,Current,,02/02/2012,02/02/2020,02/02/2024,Biennial,',
  '12347,ELEC,"Volt, Eddie",Volt Electric,EC,789 Pine Rd,,,Orlando,FL,32801,48,EC9999999,Current,,03/03/2015,03/03/2021,03/03/2025,Biennial,',
  '12348,ROOF,"Null, Void",Expired Roofing Co,RC,111 Elm St,,,Tampa,FL,33603,57,RC1112223,Null and Void,,01/01/2005,01/01/2015,01/01/2019,Biennial,',
].join("\n");

test("parseDbprExtract: keeps roofing-relevant license types, drops unrelated ones", () => {
  const records = parseDbprExtract(FIXTURE_ROWS);
  // The electrical (EC) row is filtered out; the three roofing/construction rows remain.
  assert.equal(records.length, 3);
  assert.ok(records.every((r) => r.licenseType !== "EC"));
});

test("parseDbprExtract: maps fields correctly off the documented column layout", () => {
  const [first] = parseDbprExtract(FIXTURE_ROWS);
  assert.equal(first.licenseNumber, "CCC1234567");
  assert.equal(first.licenseType, "CCC");
  assert.equal(first.licenseeName, "Smith, John");
  assert.equal(first.businessName, "Ace Roofing LLC");
  assert.equal(first.status, "Current");
  assert.equal(first.statusActive, true);
  assert.equal(first.address?.city, "Tampa");
  assert.equal(first.address?.state, "FL");
  assert.equal(first.address?.postalCode, "33602");
  assert.equal(first.issueDate, "01/01/2010");
  assert.equal(first.expiryDate, "01/01/2024");
});

test("parseDbprExtract: a 'Null and Void' status normalizes to statusActive:false", () => {
  const records = parseDbprExtract(FIXTURE_ROWS);
  const expired = records.find((r) => r.licenseNumber === "RC1112223");
  assert.ok(expired);
  assert.equal(expired!.statusActive, false);
});

test("parseDbprExtract: malformed/short rows are skipped, not thrown", () => {
  const records = parseDbprExtract("not,enough,cols\n" + FIXTURE_ROWS);
  assert.equal(records.length, 3);
});

test("parseDbprExtract: handles quoted fields containing commas", () => {
  const [first] = parseDbprExtract(FIXTURE_ROWS);
  assert.equal(first.licenseeName, "Smith, John"); // the quoted field's internal comma survived
});

test("isRoofingRelevantLicense: CCC/RC and general/building/residential codes pass, electrical doesn't", () => {
  assert.equal(isRoofingRelevantLicense("CCC1234567"), true);
  assert.equal(isRoofingRelevantLicense("RC1112223"), true);
  assert.equal(isRoofingRelevantLicense("CGC7654321"), true);
  assert.equal(isRoofingRelevantLicense("EC9999999"), false);
  assert.equal(isRoofingRelevantLicense("PLUMB123"), false);
});

test("isDbprCacheFresh: within 30 days is fresh, just past is stale", () => {
  const now = Date.parse("2026-06-15T00:00:00Z");
  const fresh = new Date(now - (DBPR_CACHE_TTL_DAYS - 1) * 24 * 3600_000).toISOString();
  const stale = new Date(now - (DBPR_CACHE_TTL_DAYS + 1) * 24 * 3600_000).toISOString();
  assert.equal(isDbprCacheFresh(fresh, now), true);
  assert.equal(isDbprCacheFresh(stale, now), false);
});

test("isDbprCacheFresh: exactly at the 30-day boundary is still fresh (<=)", () => {
  const now = Date.parse("2026-06-15T00:00:00Z");
  const boundary = new Date(now - DBPR_CACHE_TTL_DAYS * 24 * 3600_000).toISOString();
  assert.equal(isDbprCacheFresh(boundary, now), true);
});

function fakeDeps(overrides: Partial<DbprDeps> = {}): DbprDeps {
  const files = new Map<string, string>();
  return {
    readFile: async (p) => {
      const v = files.get(p);
      if (v === undefined) throw new Error("ENOENT");
      return v;
    },
    writeFile: async (p, data) => {
      files.set(p, data);
    },
    mkdir: async () => {},
    fetchText: async () => FIXTURE_ROWS,
    now: () => Date.parse("2026-06-15T00:00:00Z"),
    dataDir: "/fake/datadir",
    ...overrides,
  };
}

test("refreshDbprCache: no existing cache triggers a fetch+write and reports the parsed count", async () => {
  const deps = fakeDeps();
  const r = await refreshDbprCache(deps);
  assert.equal(r.refreshed, true);
  assert.equal(r.count, 3);
});

test("refreshDbprCache: a fresh existing cache skips refetching", async () => {
  const now = Date.parse("2026-06-15T00:00:00Z");
  const existing: DbprCacheFile = { fetchedAt: new Date(now - 1000).toISOString(), count: 1, records: [] };
  let fetchCalls = 0;
  const deps = fakeDeps({
    readFile: async () => JSON.stringify(existing),
    fetchText: async () => {
      fetchCalls++;
      return FIXTURE_ROWS;
    },
    now: () => now,
  });
  const r = await refreshDbprCache(deps);
  assert.equal(r.refreshed, false);
  assert.equal(r.count, 1);
  assert.equal(fetchCalls, 0);
});

test("refreshDbprCache: a stale existing cache triggers a refetch", async () => {
  const now = Date.parse("2026-06-15T00:00:00Z");
  const existing: DbprCacheFile = { fetchedAt: new Date(now - (DBPR_CACHE_TTL_DAYS + 5) * 24 * 3600_000).toISOString(), count: 1, records: [] };
  let fetchCalls = 0;
  const deps = fakeDeps({
    readFile: async () => JSON.stringify(existing),
    fetchText: async () => {
      fetchCalls++;
      return FIXTURE_ROWS;
    },
    now: () => now,
  });
  const r = await refreshDbprCache(deps);
  assert.equal(r.refreshed, true);
  assert.equal(r.count, 3);
  assert.equal(fetchCalls, 1);
});

test("refreshDbprCache: opts.force refetches even when the cache is fresh", async () => {
  const now = Date.parse("2026-06-15T00:00:00Z");
  const existing: DbprCacheFile = { fetchedAt: new Date(now - 1000).toISOString(), count: 1, records: [] };
  let fetchCalls = 0;
  const deps = fakeDeps({
    readFile: async () => JSON.stringify(existing),
    fetchText: async () => {
      fetchCalls++;
      return FIXTURE_ROWS;
    },
    now: () => now,
  });
  const r = await refreshDbprCache(deps, { force: true });
  assert.equal(r.refreshed, true);
  assert.equal(fetchCalls, 1);
});

test("refreshDbprCache: a fetch failure degrades gracefully instead of throwing", async () => {
  const deps = fakeDeps({
    fetchText: async () => {
      throw new Error("network egress restricted");
    },
  });
  const r = await refreshDbprCache(deps);
  assert.equal(r.refreshed, false);
  assert.equal(r.count, 0);
  assert.ok(r.error?.includes("network egress restricted"));
});

test("lookupDbpr: matches by normalized business name or licensee name, filters by state", async () => {
  resetDbprMemoCacheForTests();
  const cache: DbprCacheFile = { fetchedAt: new Date().toISOString(), count: 3, records: parseDbprExtract(FIXTURE_ROWS) };
  const deps = fakeDeps({ readFile: async () => JSON.stringify(cache) });

  const byBusinessName = await lookupDbpr("Ace Roofing LLC", "FL", deps);
  assert.equal(byBusinessName.length, 1);
  assert.equal(byBusinessName[0].licenseNumber, "CCC1234567");

  resetDbprMemoCacheForTests();
  const byLicenseeName = await lookupDbpr("Doe Construction Inc", "FL", deps);
  assert.equal(byLicenseeName.length, 1);

  resetDbprMemoCacheForTests();
  const wrongState = await lookupDbpr("Ace Roofing LLC", "GA", deps);
  assert.equal(wrongState.length, 0);
});

test("lookupDbpr: no cache file on disk returns [] rather than throwing", async () => {
  resetDbprMemoCacheForTests();
  const deps = fakeDeps({
    readFile: async () => {
      throw new Error("ENOENT");
    },
  });
  const r = await lookupDbpr("Anything LLC", "FL", deps);
  assert.deepEqual(r, []);
});
