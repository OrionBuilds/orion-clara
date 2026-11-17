import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveCandidate } from "./resolve";
import { nameSimilarity } from "./fingerprint";
import type { ExistingEntity } from "./resolve";
import type { DiscoveredCandidate } from "../types";

function existing(overrides: Partial<ExistingEntity> = {}): ExistingEntity {
  return { id: "co_1", name: "Acme Roofing", normalizedName: "acme roofing", ...overrides };
}
function candidate(overrides: Partial<DiscoveredCandidate> = {}): DiscoveredCandidate {
  return { name: "Acme Roofing", source: "places", ...overrides };
}

test("resolveCandidate: no pool at all is always NEW", () => {
  const r = resolveCandidate(candidate(), []);
  assert.equal(r.action, "new");
  assert.equal(r.best, undefined);
});

test("resolveCandidate: a shared domain alone clears MERGE", () => {
  const r = resolveCandidate(
    candidate({ website_url: "https://acmeroofing.com" }),
    [existing({ domain: "acmeroofing.com" })],
  );
  assert.equal(r.action, "merge");
  assert.ok(r.best!.score >= 100);
  assert.ok(r.best!.matchedOn.includes("domain"));
});

test("resolveCandidate: a shared domain on an AGGREGATOR never counts", () => {
  const r = resolveCandidate(
    candidate({ name: "Totally Different Co", website_url: "https://www.yelp.com" }),
    [existing({ domain: "yelp.com", name: "Someone Else", normalizedName: "someone else" })],
  );
  assert.equal(r.action, "new");
});

test("resolveCandidate: a shared phone alone clears MERGE", () => {
  const r = resolveCandidate(
    candidate({ phone: "(813) 555-0100" }),
    [existing({ phoneKey: "8135550100", name: "Different Name", normalizedName: "different name" })],
  );
  assert.equal(r.action, "merge");
  assert.ok(r.best!.matchedOn.includes("phone"));
});

test("resolveCandidate: address alone (80) is POSSIBLE, not MERGE", () => {
  const r = resolveCandidate(
    candidate({ address: { line1: "123 Main St", postal_code: "33602" }, name: "Totally Different Co" }),
    [existing({ addressKey: "123 main st|33602", name: "Someone Else", normalizedName: "someone else" })],
  );
  assert.equal(r.action, "possible");
  assert.equal(r.best!.score, 80);
});

test("resolveCandidate: address + similar name stack to clear MERGE (80+40)", () => {
  const r = resolveCandidate(
    candidate({ address: { line1: "123 Main St", postal_code: "33602" } }),
    [existing({ addressKey: "123 main st|33602" })],
  );
  assert.equal(r.action, "merge");
  assert.equal(r.best!.score, 120);
  assert.ok(r.best!.matchedOn.includes("address"));
  assert.ok(r.best!.matchedOn.includes("name"));
});

test("resolveCandidate: a near-identical name alone (≥0.85 similarity) is POSSIBLE", () => {
  const r = resolveCandidate(candidate({ name: "Acme Roofing Co" }), [existing({ normalizedName: "acme roofing" })]);
  assert.equal(r.action, "possible");
});

test("resolveCandidate: the single best match among several wins", () => {
  const r = resolveCandidate(
    candidate({ website_url: "https://acmeroofing.com" }),
    [existing({ id: "weak", normalizedName: "zzz" }), existing({ id: "strong", domain: "acmeroofing.com" })],
  );
  assert.equal(r.best!.entity.id, "strong");
});

test("nameSimilarity: identical strings are 1, totally different are low", () => {
  assert.equal(nameSimilarity("acme roofing", "acme roofing"), 1);
  assert.ok(nameSimilarity("acme roofing", "zzz plumbing") < 0.5);
});
