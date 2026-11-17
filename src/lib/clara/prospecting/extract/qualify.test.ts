import { test } from "node:test";
import assert from "node:assert/strict";
import {
  qualifyCompany,
  decideEscalation,
  computeAggregateConfidence,
  parseQualifyVerdict,
  ESCALATION_FIT_BAND,
  ESCALATION_CONFIDENCE_FLOOR,
  type QualifyDeps,
} from "./qualify";
import type { RunTierResult } from "../llm";

const BASE_INPUT = {
  companyId: "c1",
  companyName: "Ace Roofing",
  industry: ["roofing"],
  fitBreakdown: [],
  revenue: { revenue: 1_000_000, estimators: [], adsMultiplierApplied: false },
  facts: [],
};

function depsReturning(tier2: Partial<RunTierResult>, tier3?: Partial<RunTierResult>): QualifyDeps {
  return {
    runTier: async (tier) => {
      if (tier === 3) return { ok: true, engine: "anthropic", ...tier3 } as RunTierResult;
      return { ok: true, engine: "lmstudio", ...tier2 } as RunTierResult;
    },
  };
}

test("decideEscalation: fit score inside the 55-65 band escalates regardless of confidence", () => {
  assert.equal(decideEscalation(55, 1), true);
  assert.equal(decideEscalation(60, 1), true);
  assert.equal(decideEscalation(65, 1), true);
  assert.equal(decideEscalation(54, 1), false);
  assert.equal(decideEscalation(66, 1), false);
});

test("decideEscalation: confidence below the floor escalates regardless of fit score", () => {
  assert.equal(decideEscalation(10, ESCALATION_CONFIDENCE_FLOOR - 0.01), true);
  assert.equal(decideEscalation(90, 0.1), true);
  assert.equal(decideEscalation(10, ESCALATION_CONFIDENCE_FLOOR), false);
});

test("ESCALATION_FIT_BAND matches the documented 55-65 inclusive band", () => {
  assert.deepEqual(ESCALATION_FIT_BAND, [55, 65]);
});

test("computeAggregateConfidence: mean of facts that carry a confidence value", () => {
  const c = computeAggregateConfidence([{ field_name: "a", value: 1, confidence: 0.4 }, { field_name: "b", value: 2, confidence: 0.8 }]);
  assert.ok(Math.abs(c - 0.6) < 1e-9);
});

test("computeAggregateConfidence: facts without a confidence field don't count either way", () => {
  const c = computeAggregateConfidence([{ field_name: "a", value: 1, confidence: 0.5 }, { field_name: "b", value: 2 }]);
  assert.equal(c, 0.5);
});

test("computeAggregateConfidence: no facts at all defaults to 1 (never escalates on confidence alone)", () => {
  assert.equal(computeAggregateConfidence([]), 1);
});

test("parseQualifyVerdict: parses a well-formed verdict", () => {
  const v = parseQualifyVerdict('{"qualified": true, "reasons": ["good fit", "active website"]}');
  assert.deepEqual(v, { qualified: true, reasons: ["good fit", "active website"] });
});

test("parseQualifyVerdict: returns null on invalid JSON", () => {
  assert.equal(parseQualifyVerdict("not json"), null);
});

test("parseQualifyVerdict: returns null when 'qualified' isn't a boolean", () => {
  assert.equal(parseQualifyVerdict('{"qualified": "yes"}'), null);
});

test("tier-2-only path: fit score outside the band, confidence >= floor — tier 2's verdict stands, tier 3 never called", async () => {
  let tier3Called = false;
  const deps: QualifyDeps = {
    runTier: async (tier) => {
      if (tier === 3) tier3Called = true;
      return { ok: true, engine: tier === 2 ? "lmstudio" : "anthropic", text: '{"qualified": true, "reasons": ["strong fit"]}' };
    },
  };
  const r = await qualifyCompany({ ...BASE_INPUT, fitScore: 90, facts: [{ field_name: "year_founded", value: 2010, confidence: 0.9 }] }, deps);
  assert.equal(r.qualified, true);
  assert.equal(r.tier, 2);
  assert.equal(r.escalated, false);
  assert.equal(tier3Called, false);
  assert.deepEqual(r.reasons, ["strong fit"]);
});

test("tier-3-escalation path (fit-score band trigger): tier 3 runs and its verdict overrides tier 2's", async () => {
  const deps = depsReturning(
    { text: '{"qualified": false, "reasons": ["tier-2 says no"]}' },
    { text: '{"qualified": true, "reasons": ["tier-3 overrides"]}' },
  );
  const r = await qualifyCompany({ ...BASE_INPUT, fitScore: 60, facts: [{ field_name: "year_founded", value: 2010, confidence: 0.9 }] }, deps);
  assert.equal(r.escalated, true);
  assert.equal(r.tier, 3);
  assert.equal(r.qualified, true);
  assert.deepEqual(r.reasons, ["tier-3 overrides"]);
});

test("tier-3-escalation path (confidence trigger, tested separately): low aggregate confidence escalates outside the fit band too", async () => {
  const deps = depsReturning(
    { text: '{"qualified": true, "reasons": ["tier-2 says yes"]}' },
    { text: '{"qualified": false, "reasons": ["tier-3 overrides to no"]}' },
  );
  const r = await qualifyCompany({ ...BASE_INPUT, fitScore: 95, facts: [{ field_name: "year_founded", value: 2010, confidence: 0.1 }] }, deps);
  assert.equal(r.escalated, true);
  assert.equal(r.tier, 3);
  assert.equal(r.qualified, false);
  assert.deepEqual(r.reasons, ["tier-3 overrides to no"]);
});

test("a failed/unparseable tier-3 call falls back to tier-2's verdict, still marked escalated", async () => {
  const deps: QualifyDeps = {
    runTier: async (tier) => {
      if (tier === 3) return { ok: false, engine: "anthropic", error: "503" };
      return { ok: true, engine: "lmstudio", text: '{"qualified": true, "reasons": ["tier-2 stands"]}' };
    },
  };
  const r = await qualifyCompany({ ...BASE_INPUT, fitScore: 60, facts: [] }, deps);
  assert.equal(r.escalated, true);
  assert.equal(r.tier, 2);
  assert.equal(r.qualified, true);
  assert.deepEqual(r.reasons, ["tier-2 stands"]);
});

test("tier-2 JSON parse failure degrades to {qualified:false} rather than throwing", async () => {
  const deps: QualifyDeps = { runTier: async () => ({ ok: true, engine: "lmstudio", text: "not valid json" }) };
  const r = await qualifyCompany({ ...BASE_INPUT, fitScore: 95, facts: [{ field_name: "year_founded", value: 2010, confidence: 0.9 }] }, deps);
  assert.equal(r.qualified, false);
  assert.ok(r.reasons.length > 0);
  assert.equal(r.tier, 2);
  assert.equal(r.escalated, false);
});

test("a failed tier-2 call (ok:false) degrades to {qualified:false} with the error as a reason", async () => {
  const deps: QualifyDeps = { runTier: async () => ({ ok: false, engine: "lmstudio", error: "lmstudio down" }) };
  const r = await qualifyCompany({ ...BASE_INPUT, fitScore: 95, facts: [{ field_name: "x", value: 1, confidence: 0.9 }] }, deps);
  assert.equal(r.qualified, false);
  assert.ok(r.reasons.some((x) => x.includes("lmstudio down")));
});
