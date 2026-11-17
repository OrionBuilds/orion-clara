import { test } from "node:test";
import assert from "node:assert/strict";
import { hashContent, diffChanged } from "./diff";

test("hashContent is stable for the same input", () => {
  const a = hashContent("Acme Roofing — serving Tampa since 1995.");
  const b = hashContent("Acme Roofing — serving Tampa since 1995.");
  assert.equal(a, b);
  assert.equal(a.length, 64); // sha256 hex digest
});

test("hashContent differs for different input", () => {
  const a = hashContent("Acme Roofing — serving Tampa since 1995.");
  const b = hashContent("Acme Roofing — serving Tampa since 1996.");
  assert.notEqual(a, b);
});

test("hashContent is sensitive to whitespace/case (no implicit normalization)", () => {
  const a = hashContent("Acme Roofing");
  const b = hashContent("acme roofing");
  assert.notEqual(a, b);
});

test("diffChanged: no previous hash (first-ever scan) is NEVER a change, regardless of the new hash", () => {
  const next = hashContent("anything");
  assert.equal(diffChanged(undefined, next), false);
});

test("diffChanged: same hash twice is not a change", () => {
  const h = hashContent("same content");
  assert.equal(diffChanged(h, h), false);
});

test("diffChanged: different hashes is a change", () => {
  const a = hashContent("content v1");
  const b = hashContent("content v2");
  assert.equal(diffChanged(a, b), true);
});

test("diffChanged: an empty string IS a legitimate previous hash (distinct from undefined)", () => {
  const prev = hashContent(""); // a company's page that was genuinely empty last scan
  const next = hashContent("now has real content");
  assert.equal(diffChanged(prev, next), true);
});
