import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePinellasResponse, buildPinellasQueryUrl, lookupPermits, type PinellasPermitsDeps } from "./pinellas";

// Best-guess field shape (module header comment) — PERMIT_NUMBER/CONTRACTOR_NAME/
// CONTRACTOR_LICENSE/JOB_VALUE/ISSUE_DATE/STATUS/SITE_ADDRESS.
const FIXTURE_RESPONSE = {
  features: [
    {
      attributes: {
        PERMIT_NUMBER: "PIN-2024-00111",
        CONTRACTOR_NAME: "Ace Roofing LLC",
        CONTRACTOR_LICENSE: "CCC1234567",
        DESCRIPTION: "Reroof - shingle",
        PERMIT_TYPE: "Building",
        JOB_VALUE: 18_000,
        ISSUE_DATE: Date.parse("2024-05-01T00:00:00Z"),
        STATUS: "Issued",
        SITE_ADDRESS: "789 Gulf Blvd, Clearwater",
      },
    },
  ],
};

test("buildPinellasQueryUrl: builds a CONTRACTOR_NAME/CONTRACTOR_LICENSE where clause", () => {
  const url = buildPinellasQueryUrl("Ace Roofing");
  assert.ok(url.includes("CONTRACTOR_NAME"));
  assert.ok(url.includes("CONTRACTOR_LICENSE"));
  assert.ok(url.includes("f=json"));
});

test("parsePinellasResponse: maps the best-guess field shape into PermitRecord[]", () => {
  const records = parsePinellasResponse(FIXTURE_RESPONSE);
  assert.equal(records.length, 1);
  const [r] = records;
  assert.equal(r.permitNumber, "PIN-2024-00111");
  assert.equal(r.jurisdiction, "pinellas");
  assert.equal(r.contractorName, "Ace Roofing LLC");
  assert.equal(r.contractorLicenseNumber, "CCC1234567");
  assert.equal(r.valuation, 18_000);
  assert.equal(r.status, "Issued");
  assert.equal(r.issueDate, "2024-05-01");
  assert.equal(r.address, "789 Gulf Blvd, Clearwater");
});

test("parsePinellasResponse: empty features array yields []", () => {
  assert.deepEqual(parsePinellasResponse({ features: [] }), []);
});

test("parsePinellasResponse: an ArcGIS .error envelope yields [] rather than throwing", () => {
  assert.deepEqual(parsePinellasResponse({ error: { code: 404 } }), []);
});

test("parsePinellasResponse: malformed/non-object/HTML-error-page input degrades gracefully", () => {
  assert.deepEqual(parsePinellasResponse(null), []);
  assert.deepEqual(parsePinellasResponse("<html>404</html>"), []);
  assert.deepEqual(parsePinellasResponse({ features: null }), []);
});

test("parsePinellasResponse: a feature with no recognizable permit-number field is skipped", () => {
  const records = parsePinellasResponse({ features: [{ attributes: { CONTRACTOR_NAME: "X" } }] });
  assert.deepEqual(records, []);
});

function fakeDeps(fetchJson: PinellasPermitsDeps["fetchJson"]): PinellasPermitsDeps {
  return { fetchJson };
}

test("lookupPermits: fetches and parses on a successful call", async () => {
  const deps = fakeDeps(async () => FIXTURE_RESPONSE);
  const records = await lookupPermits("Ace Roofing", deps);
  assert.equal(records.length, 1);
});

test("lookupPermits: this (unconfirmed-endpoint) adapter degrades to [] on any fetch failure — the expected production outcome until a real endpoint is confirmed", async () => {
  const deps = fakeDeps(async () => {
    throw new Error("404 not found");
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
  const records = await lookupPermits("", deps);
  assert.deepEqual(records, []);
  assert.equal(called, false);
});
