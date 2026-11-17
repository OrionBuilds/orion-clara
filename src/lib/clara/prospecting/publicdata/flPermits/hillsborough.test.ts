import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHillsboroughResponse, buildHillsboroughQueryUrl, lookupPermits, type HillsboroughPermitsDeps } from "./hillsborough";

// Shaped like the real, confirmed field list (module header comment): PERMIT__, STATUS_1, TYPE,
// CITY_1, ADDRESS, Value, DESCRIPTION, TYPE2, ISSUED_DATE (epoch ms).
const FIXTURE_RESPONSE = {
  features: [
    {
      attributes: {
        OBJECTID: 1,
        PERMIT__: "CO-2024-001234",
        STATUS_1: "Issued",
        TYPE: "Commercial",
        TYPE2: "Commercial/New Construction",
        ADDRESS: "123 Main St",
        CITY_1: "Tampa",
        Value: 85_000,
        DESCRIPTION: "NC17/COM/NEW/ACE ROOFING LLC REROOF",
        ISSUED_DATE: Date.parse("2024-03-01T00:00:00Z"),
      },
    },
    {
      attributes: {
        OBJECTID: 2,
        PERMIT__: "CO-2024-005678",
        STATUS_1: "Finaled",
        TYPE: "Residential",
        ADDRESS: "456 Oak Ave",
        CITY_1: "Brandon",
        Value: 12_500,
        DESCRIPTION: "RES/REROOF",
        ISSUED_DATE: Date.parse("2024-01-15T00:00:00Z"),
      },
    },
  ],
};

test("buildHillsboroughQueryUrl: builds a DESCRIPTION-matching ArcGIS where clause", () => {
  const url = buildHillsboroughQueryUrl("Ace Roofing");
  assert.ok(url.startsWith("https://services.arcgis.com/"));
  assert.ok(url.includes("DESCRIPTION"));
  assert.ok(url.includes("f=json"));
});

test("buildHillsboroughQueryUrl: escapes single quotes in the search term", () => {
  const url = buildHillsboroughQueryUrl("O'Brien Roofing");
  assert.ok(url.includes("O%27%27Brien") || decodeURIComponent(url).includes("O''Brien"));
});

test("parseHillsboroughResponse: maps real confirmed fields into PermitRecord[]", () => {
  const records = parseHillsboroughResponse(FIXTURE_RESPONSE);
  assert.equal(records.length, 2);
  const [first] = records;
  assert.equal(first.permitNumber, "CO-2024-001234");
  assert.equal(first.jurisdiction, "hillsborough");
  assert.equal(first.valuation, 85_000);
  assert.equal(first.status, "Issued");
  assert.equal(first.address, "123 Main St, Tampa");
  assert.equal(first.issueDate, "2024-03-01");
  // confirmed limitation: this layer has no contractor field
  assert.equal(first.contractorName, undefined);
  assert.equal(first.contractorLicenseNumber, undefined);
});

test("parseHillsboroughResponse: empty features array yields []", () => {
  assert.deepEqual(parseHillsboroughResponse({ features: [] }), []);
});

test("parseHillsboroughResponse: an ArcGIS .error envelope yields [] rather than throwing", () => {
  assert.deepEqual(parseHillsboroughResponse({ error: { code: 400, message: "bad query" } }), []);
});

test("parseHillsboroughResponse: malformed/non-object input degrades gracefully", () => {
  assert.deepEqual(parseHillsboroughResponse(null), []);
  assert.deepEqual(parseHillsboroughResponse(undefined), []);
  assert.deepEqual(parseHillsboroughResponse("not json"), []);
  assert.deepEqual(parseHillsboroughResponse({ features: "not an array" }), []);
});

test("parseHillsboroughResponse: a feature missing PERMIT__ is skipped, not fatal", () => {
  const records = parseHillsboroughResponse({ features: [{ attributes: { DESCRIPTION: "no permit number" } }] });
  assert.deepEqual(records, []);
});

function fakeDeps(fetchJson: HillsboroughPermitsDeps["fetchJson"]): HillsboroughPermitsDeps {
  return { fetchJson };
}

test("lookupPermits: fetches and parses on a successful call", async () => {
  const deps = fakeDeps(async () => FIXTURE_RESPONSE);
  const records = await lookupPermits("Ace Roofing", deps);
  assert.equal(records.length, 2);
});

test("lookupPermits: a fetch throw degrades to [] rather than propagating", async () => {
  const deps = fakeDeps(async () => {
    throw new Error("network error");
  });
  const records = await lookupPermits("Ace Roofing", deps);
  assert.deepEqual(records, []);
});

test("lookupPermits: an empty search term returns [] without fetching", async () => {
  let called = false;
  const deps = fakeDeps(async () => {
    called = true;
    return FIXTURE_RESPONSE;
  });
  const records = await lookupPermits("   ", deps);
  assert.deepEqual(records, []);
  assert.equal(called, false);
});
