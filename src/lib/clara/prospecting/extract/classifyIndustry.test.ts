import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyIndustry, buildClassifyPrompt, PROBABILITY_THRESHOLD, type ClassifyIndustryDeps } from "./classifyIndustry";
import type { DiscoveredCandidate } from "../types";

const candidate: DiscoveredCandidate = {
  name: "Acme Roofing",
  source: "places",
  website_url: "https://acme.com",
  category_hint: "Roofing contractor",
};

function depsFor(text: string | undefined, ok = true, error?: string): ClassifyIndustryDeps {
  return { runTier: async () => ({ ok, engine: "lmstudio", model: "test-model", text, error }) };
}

test("valid JSON parses cleanly into a typed result", async () => {
  const r = await classifyIndustry(
    candidate,
    ["roofing"],
    undefined,
    depsFor(JSON.stringify({ is_roofing: true, probability: 0.92, residential_commercial: "residential" })),
  );
  assert.equal(r.probability, 0.92);
  assert.equal(r.residentialCommercial, "residential");
  assert.equal(r.inIndustry, true);
  assert.equal(r.parseError, undefined);
});

test("malformed JSON falls back to probability 0.5 / unknown instead of throwing", async () => {
  const r = await classifyIndustry(candidate, ["roofing"], undefined, depsFor("not json at all"));
  assert.equal(r.probability, 0.5);
  assert.equal(r.residentialCommercial, "unknown");
  assert.equal(r.inIndustry, false);
  assert.ok(r.parseError);
});

test("probability exactly at the 0.7 boundary passes (inclusive)", async () => {
  const r = await classifyIndustry(
    candidate,
    ["roofing"],
    undefined,
    depsFor(JSON.stringify({ probability: PROBABILITY_THRESHOLD, residential_commercial: "commercial" })),
  );
  assert.equal(r.probability, 0.7);
  assert.equal(r.inIndustry, true);
});

test("probability just under the boundary fails", async () => {
  const r = await classifyIndustry(candidate, ["roofing"], undefined, depsFor(JSON.stringify({ probability: 0.699 })));
  assert.equal(r.inIndustry, false);
});

test("missing residential_commercial defaults to unknown", async () => {
  const r = await classifyIndustry(candidate, ["roofing"], undefined, depsFor(JSON.stringify({ probability: 0.8 })));
  assert.equal(r.residentialCommercial, "unknown");
});

test("garbage residential_commercial value defaults to unknown", async () => {
  const r = await classifyIndustry(
    candidate,
    ["roofing"],
    undefined,
    depsFor(JSON.stringify({ probability: 0.8, residential_commercial: "spaceship" })),
  );
  assert.equal(r.residentialCommercial, "unknown");
});

test("a probability outside 0..1 is clamped", async () => {
  const r = await classifyIndustry(candidate, ["roofing"], undefined, depsFor(JSON.stringify({ probability: 4.2 })));
  assert.equal(r.probability, 1);
});

test("a failed tier-1 call falls back sanely", async () => {
  const r = await classifyIndustry(candidate, ["roofing"], undefined, depsFor(undefined, false, "lmstudio down"));
  assert.equal(r.probability, 0.5);
  assert.equal(r.inIndustry, false);
  assert.equal(r.parseError, "lmstudio down");
});

test("buildClassifyPrompt includes the crawled-text snippet when given, and the candidate's details", () => {
  const prompt = buildClassifyPrompt(candidate, ["roofing"], "We install roofs for homes and businesses.");
  assert.ok(prompt.includes("We install roofs for homes and businesses."));
  assert.ok(prompt.includes("Acme Roofing"));
  assert.ok(prompt.includes("roofing"));
});

test("buildClassifyPrompt says 'not crawled yet' when no crawled text is given", () => {
  const prompt = buildClassifyPrompt(candidate, ["roofing"]);
  assert.ok(prompt.includes("not crawled yet"));
});
