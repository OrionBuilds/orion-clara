import { test } from "node:test";
import assert from "node:assert/strict";
import { EMAIL_RUNGS, MOBILE_RUNGS } from "./index";

test("EMAIL_RUNGS is in the plan's exact order: site_mailto, hunter_pattern, leadmagic, hunter_finder, apollo_match", () => {
  assert.deepEqual(EMAIL_RUNGS.map((r) => r.id), ["site_mailto", "hunter_pattern", "leadmagic", "hunter_finder", "apollo_match"]);
});

test("MOBILE_RUNGS is in the plan's exact order: places_phone, dbpr_phone, site_tel, leadmagic_mobile", () => {
  assert.deepEqual(MOBILE_RUNGS.map((r) => r.id), ["places_phone", "dbpr_phone", "site_tel", "leadmagic_mobile"]);
});

test("every rung has the plan's {id, enabled, gate, costUnits, call} shape", () => {
  for (const r of [...EMAIL_RUNGS, ...MOBILE_RUNGS]) {
    assert.equal(typeof r.id, "string");
    assert.equal(typeof r.enabled, "function");
    assert.equal(typeof r.gate, "function");
    assert.equal(typeof r.costUnits, "number");
    assert.equal(typeof r.call, "function");
  }
});
