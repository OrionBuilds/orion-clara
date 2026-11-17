import { test } from "node:test";
import assert from "node:assert/strict";
import {
  estimateRevenue,
  computeRevenueConfidence,
  yearsInBusinessMultiplier,
  REVENUE_PER_EMPLOYEE,
  LEADS_PER_REVIEW_PER_YEAR,
  AVG_JOB_VALUE_USD,
  PERMIT_VALUATION_MULTIPLIER,
  ADS_ACTIVE_MULTIPLIER,
  BASE_REVENUE_PER_LOCATION,
  SINGLE_ESTIMATOR_RANGE_PCT,
} from "./revenue";

test("estimateRevenue: no inputs at all returns null with a reason", () => {
  const r = estimateRevenue({});
  assert.equal(r.revenue, null);
  assert.equal(r.estimators.length, 0);
  assert.ok(r.reason);
});

test("employees estimator: employees * $200k, alone", () => {
  const r = estimateRevenue({ employees: 10 });
  assert.equal(r.estimators.length, 1);
  assert.equal(r.estimators[0].name, "employees");
  assert.equal(r.estimators[0].value, 10 * REVENUE_PER_EMPLOYEE);
  assert.equal(r.revenue, 10 * REVENUE_PER_EMPLOYEE);
});

test("employees estimator is skipped when employees is undefined/zero/negative", () => {
  assert.equal(estimateRevenue({ employees: undefined }).revenue, null);
  assert.equal(estimateRevenue({ employees: 0 }).estimators.length, 0);
  assert.equal(estimateRevenue({ employees: -3 }).estimators.length, 0);
});

test("reviews estimator: (reviewCount/yearsActive) * 25 * 12000, alone", () => {
  const r = estimateRevenue({ reviewCount: 200, yearsActive: 10 });
  assert.equal(r.estimators.length, 1);
  assert.equal(r.estimators[0].name, "reviews");
  const expected = (200 / 10) * LEADS_PER_REVIEW_PER_YEAR * AVG_JOB_VALUE_USD;
  assert.equal(r.estimators[0].value, expected);
});

test("reviews estimator is skipped without a yearsActive (no invented assumption)", () => {
  const r = estimateRevenue({ reviewCount: 200 });
  assert.equal(r.estimators.length, 0);
  assert.equal(r.revenue, null);
});

test("permits estimator: permitValueSum * 1.3, alone", () => {
  const r = estimateRevenue({ permitValueSum: 100_000 });
  assert.equal(r.estimators.length, 1);
  assert.equal(r.estimators[0].name, "permits");
  assert.equal(r.estimators[0].value, 100_000 * PERMIT_VALUATION_MULTIPLIER);
});

test("locations estimator: locationsCount * $500k * years-in-business multiplier, alone", () => {
  const r = estimateRevenue({ locationsCount: 2, yearsInBusiness: 10 });
  assert.equal(r.estimators.length, 1);
  assert.equal(r.estimators[0].name, "locations");
  const mult = yearsInBusinessMultiplier(10);
  assert.equal(r.estimators[0].value, 2 * BASE_REVENUE_PER_LOCATION * mult);
});

test("yearsInBusinessMultiplier: 0 years is the floor, grows with years, clamps at the ceiling", () => {
  assert.equal(yearsInBusinessMultiplier(0), 0.6);
  assert.ok(yearsInBusinessMultiplier(10) > yearsInBusinessMultiplier(0));
  assert.equal(yearsInBusinessMultiplier(1000), 1.25);
  assert.equal(yearsInBusinessMultiplier(undefined), 1); // neutral, not "0 years"
});

test("single-estimator range is exactly ±35% of the base value", () => {
  const r = estimateRevenue({ employees: 5 });
  const base = 5 * REVENUE_PER_EMPLOYEE;
  assert.equal(r.low, Math.round(base * (1 - SINGLE_ESTIMATOR_RANGE_PCT)));
  assert.equal(r.high, Math.round(base * (1 + SINGLE_ESTIMATOR_RANGE_PCT)));
});

test("multi-estimator range is min*0.9 .. max*1.1 across the contributing estimators", () => {
  const r = estimateRevenue({ employees: 5, permitValueSum: 50_000 });
  assert.equal(r.estimators.length, 2);
  const values = r.estimators.map((e) => e.value);
  assert.equal(r.low, Math.round(Math.min(...values) * 0.9));
  assert.equal(r.high, Math.round(Math.max(...values) * 1.1));
});

test("combination via geometric mean: revenue is the geometric mean of the contributing estimators (pre-ads)", () => {
  const r = estimateRevenue({ employees: 5, permitValueSum: 50_000 });
  const values = r.estimators.map((e) => e.value);
  const gm = Math.exp(values.map((v) => Math.log(v)).reduce((a, b) => a + b, 0) / values.length);
  assert.equal(r.revenue, Math.round(gm));
});

test("ads-active applies a flat +15% multiplier AFTER the base estimate, for revenue/low/high alike", () => {
  const without = estimateRevenue({ employees: 10 });
  const withAds = estimateRevenue({ employees: 10, adsActive: true });
  assert.equal(withAds.revenue, Math.round((without.revenue as number) * ADS_ACTIVE_MULTIPLIER));
  assert.equal(withAds.low, Math.round((without.low as number) * ADS_ACTIVE_MULTIPLIER));
  assert.equal(withAds.high, Math.round((without.high as number) * ADS_ACTIVE_MULTIPLIER));
  assert.equal(withAds.adsMultiplierApplied, true);
  assert.equal(without.adsMultiplierApplied, false);
  // confidence is unaffected by the ads multiplier — same estimator set/agreement either way
  assert.equal(withAds.confidence, without.confidence);
});

test("computeRevenueConfidence: more agreeing estimators yields higher confidence than one alone", () => {
  const one = computeRevenueConfidence([100]);
  const threeAgreeing = computeRevenueConfidence([100, 105, 98]);
  assert.ok(threeAgreeing > one);
});

test("computeRevenueConfidence: wide disagreement lowers confidence even with more estimators", () => {
  const twoAgreeing = computeRevenueConfidence([100, 102]);
  const twoDisagreeing = computeRevenueConfidence([100, 1000]);
  assert.ok(twoDisagreeing < twoAgreeing);
});

test("computeRevenueConfidence: empty input is 0", () => {
  assert.equal(computeRevenueConfidence([]), 0);
});

test("confidence is always within [0,1]", () => {
  const r1 = estimateRevenue({ employees: 1 });
  const r2 = estimateRevenue({ employees: 100, reviewCount: 500, yearsActive: 2, permitValueSum: 1, locationsCount: 1, yearsInBusiness: 1 });
  for (const r of [r1, r2]) {
    assert.ok((r.confidence as number) >= 0 && (r.confidence as number) <= 1);
  }
});
