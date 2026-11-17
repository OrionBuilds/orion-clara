import { test } from "node:test";
import assert from "node:assert/strict";
import { applyPriors, updatePriors, DEFAULT_PRIORS } from "./priors";

test("applyPriors: zero discovered is zero everywhere, never negative", () => {
  const f = applyPriors(0);
  for (const v of Object.values(f)) assert.ok(v >= 0);
  assert.equal(f.discovered, 0);
  assert.equal(f.mobile_found, 0);
});

test("applyPriors: monotonically non-increasing down the funnel", () => {
  const f = applyPriors(10_000);
  assert.ok(f.discovered >= f.in_industry);
  assert.ok(f.in_industry >= f.active_website);
  assert.ok(f.active_website >= f.pass_icp);
  assert.ok(f.pass_icp >= f.ai_qualified);
  assert.ok(f.ai_qualified >= f.dm_found || f.dm_found === 0);
});

test("updatePriors: nudges toward the observed ratio by alpha=0.3 and bumps samples", () => {
  const actual = { discovered: 1000, in_industry: 1000 }; // observed ratio 1.0, prior default 0.58
  const next = updatePriors(DEFAULT_PRIORS, actual);
  assert.equal(next.samples, DEFAULT_PRIORS.samples + 1);
  const expected = Number((DEFAULT_PRIORS.in_industry * 0.7 + 1.0 * 0.3).toFixed(4));
  assert.equal(next.in_industry, expected);
  // untouched ratios (no data in `actual`) are left exactly alone
  assert.equal(next.active_website, DEFAULT_PRIORS.active_website);
});

test("updatePriors: a zero denominator leaves that ratio untouched", () => {
  const next = updatePriors(DEFAULT_PRIORS, { discovered: 0, in_industry: 0 });
  assert.equal(next.in_industry, DEFAULT_PRIORS.in_industry);
});
