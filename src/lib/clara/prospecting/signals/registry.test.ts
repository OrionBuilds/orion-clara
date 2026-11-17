import { test } from "node:test";
import assert from "node:assert/strict";
import { SIGNAL_REGISTRY, signalDef } from "./registry";
import { WEBSITE_CHANGE_SCORE_DELTA } from "./checks/websiteChange";
import { TECH_CHANGE_SCORE_DELTA } from "./checks/techChange";
import { REVIEW_VELOCITY_SCORE_DELTA_HIGH, PLACES_DETAILS_COST_USD } from "./checks/reviewVelocity";
import { HIRING_SALES_OPS_SCORE_DELTA } from "./checks/hiring";
import { AD_ACTIVITY_SCORE_DELTA } from "./checks/adActivity";
import { NEW_LOCATION_SCORE_DELTA, PLACES_TEXT_SEARCH_COST_USD } from "./checks/newLocation";
import { LEADERSHIP_CHANGE_SCORE_DELTA } from "./checks/leadershipChange";
import { PERMIT_GROWTH_SCORE_DELTA } from "./checks/permitGrowth";

test("registers exactly the 3 PR 17 signals + the 5 PR 18 signals (8 total)", () => {
  assert.deepEqual(
    SIGNAL_REGISTRY.map((s) => s.key).sort(),
    ["ad_activity", "hiring", "leadership_change", "new_location", "permit_growth", "review_velocity", "tech_change", "website_change"],
  );
});

test("every registered signal has a sane, present cost_cents_est and score_delta", () => {
  for (const s of SIGNAL_REGISTRY) {
    assert.equal(typeof s.cost_cents_est, "number", `${s.key}.cost_cents_est`);
    assert.ok(s.cost_cents_est >= 0, `${s.key}.cost_cents_est should be >= 0`);
    assert.equal(typeof s.score_delta, "number", `${s.key}.score_delta`);
    assert.ok(s.score_delta > 0, `${s.key}.score_delta should be positive`);
    assert.ok(["hourly", "daily", "weekly"].includes(s.cadence), `${s.key}.cadence`);
    assert.ok(s.lastCheckedField.length > 0, `${s.key}.lastCheckedField`);
    assert.equal(typeof s.run, "function", `${s.key}.run`);
  }
});

test("website_change: $0 under today's (free) crawl rates, registry mirrors the check module's own score_delta constant", () => {
  const s = signalDef("website_change");
  assert.equal(s?.cost_cents_est, 0);
  assert.equal(s?.score_delta, WEBSITE_CHANGE_SCORE_DELTA);
});

test("tech_change: $0 (reuses website_change's crawl, no independent provider call), registry mirrors the check module's score_delta", () => {
  const s = signalDef("tech_change");
  assert.equal(s?.cost_cents_est, 0);
  assert.equal(s?.score_delta, TECH_CHANGE_SCORE_DELTA);
});

test("review_velocity: cost_cents_est mirrors rates.json's places_details (0.005 USD = 0.5 cents), score_delta is the HIGH (>=20%) tier", () => {
  const s = signalDef("review_velocity");
  assert.equal(s?.cost_cents_est, PLACES_DETAILS_COST_USD * 100);
  assert.equal(s?.cost_cents_est, 0.5);
  assert.equal(s?.score_delta, REVIEW_VELOCITY_SCORE_DELTA_HIGH);
});

test("signalDef returns undefined for an unknown key", () => {
  assert.equal(signalDef("not_a_real_signal"), undefined);
});

// ── PR 18's 5 new entries ──────────────────────────────────────────────────────────────────────

test("hiring: registry mirrors the check module's own HIGH (sales/ops) score_delta constant", () => {
  const s = signalDef("hiring");
  assert.equal(s?.score_delta, HIRING_SALES_OPS_SCORE_DELTA);
  assert.equal(s?.score_delta, 8);
  assert.equal(s?.cadence, "weekly");
  assert.ok((s?.cost_cents_est ?? 0) > 0, "hiring has real Brave-query spend");
});

test("ad_activity: registry mirrors the check module's score_delta", () => {
  const s = signalDef("ad_activity");
  assert.equal(s?.score_delta, AD_ACTIVITY_SCORE_DELTA);
  assert.equal(s?.score_delta, 6);
  assert.equal(s?.cadence, "weekly");
});

test("new_location: registry mirrors the check module's score_delta and the Places Text Search cost", () => {
  const s = signalDef("new_location");
  assert.equal(s?.score_delta, NEW_LOCATION_SCORE_DELTA);
  assert.equal(s?.score_delta, 10);
  assert.equal(s?.cost_cents_est, Math.round(PLACES_TEXT_SEARCH_COST_USD * 100 * 100) / 100);
  assert.equal(s?.cost_cents_est, 3.5);
});

test("leadership_change: registry mirrors the check module's score_delta, $0 (free crawl + tier-1)", () => {
  const s = signalDef("leadership_change");
  assert.equal(s?.score_delta, LEADERSHIP_CHANGE_SCORE_DELTA);
  assert.equal(s?.score_delta, 7);
  assert.equal(s?.cost_cents_est, 0);
});

test("permit_growth: registry mirrors the check module's score_delta, $0 (free public ArcGIS queries)", () => {
  const s = signalDef("permit_growth");
  assert.equal(s?.score_delta, PERMIT_GROWTH_SCORE_DELTA);
  assert.equal(s?.score_delta, 6);
  assert.equal(s?.cost_cents_est, 0);
});

test("every registered signal (all 8) has a positive score_delta and a non-negative cost_cents_est", () => {
  assert.equal(SIGNAL_REGISTRY.length, 8);
  for (const s of SIGNAL_REGISTRY) {
    assert.ok(s.score_delta > 0, `${s.key}.score_delta should be positive`);
    assert.ok(s.cost_cents_est >= 0, `${s.key}.cost_cents_est should be >= 0`);
  }
});
