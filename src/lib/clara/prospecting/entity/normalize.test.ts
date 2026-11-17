import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeDomain, isAggregatorDomain, normalizePhoneKey, normalizeName, normalizeAddressKey, normalizeCandidate, AGGREGATOR_DOMAINS } from "./normalize";

test("normalizeDomain strips scheme/www/path/port and lowercases", () => {
  assert.equal(normalizeDomain("https://www.AcmeRoofing.com/contact"), "acmeroofing.com");
  assert.equal(normalizeDomain("acmeroofing.com:8080"), "acmeroofing.com");
  assert.equal(normalizeDomain("sub.acmeroofing.com"), "acmeroofing.com");
  assert.equal(normalizeDomain(undefined), undefined);
  assert.equal(normalizeDomain("not a url"), undefined);
});

test("isAggregatorDomain flags known listing sites", () => {
  assert.ok(isAggregatorDomain("yelp.com"));
  assert.ok(isAggregatorDomain("facebook.com"));
  assert.equal(isAggregatorDomain("acmeroofing.com"), false);
  assert.ok(AGGREGATOR_DOMAINS.size > 5);
});

test("normalizePhoneKey reduces to the last 10 digits, drops the leading 1", () => {
  assert.equal(normalizePhoneKey("+1 (813) 555-0100"), "8135550100");
  assert.equal(normalizePhoneKey("18135550100"), "8135550100");
  assert.equal(normalizePhoneKey("5550100"), undefined);
  assert.equal(normalizePhoneKey(undefined), undefined);
});

test("normalizeName strips legal suffixes and punctuation", () => {
  assert.equal(normalizeName("Acme Roofing, LLC."), "acme roofing");
  assert.equal(normalizeName("O'Brien Roofing Inc"), "obrien roofing");
  assert.equal(normalizeName(undefined), "");
});

test("normalizeAddressKey needs both a street line and a zip", () => {
  assert.equal(normalizeAddressKey({ line1: "123 Main St", postal_code: "33602" }), "123 main st|33602");
  assert.equal(normalizeAddressKey({ line1: "123 Main St" }), undefined);
  assert.equal(normalizeAddressKey(undefined), undefined);
});

test("normalizeCandidate assembles every field", () => {
  const n = normalizeCandidate({ name: "Acme Roofing LLC", source: "places", website_url: "https://www.acmeroofing.com", phone: "(813) 555-0100", google_place_id: "p1" });
  assert.equal(n.domain, "acmeroofing.com");
  assert.equal(n.phoneKey, "8135550100");
  assert.equal(n.placeId, "p1");
  assert.equal(n.normalizedName, "acme roofing");
});
