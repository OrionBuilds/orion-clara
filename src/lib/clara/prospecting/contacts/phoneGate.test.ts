import { test } from "node:test";
import assert from "node:assert/strict";
import { phoneGate, PHONE_GATE_MIN_FIT, PHONE_GATE_HIGH_FIT, DEFAULT_MOBILE_SHARE_MAX } from "./phoneGate";

function base(overrides: Partial<Parameters<typeof phoneGate>[0]> = {}): Parameters<typeof phoneGate>[0] {
  return {
    fitScore: 85,
    decisionMakerFound: true,
    emailStatus: "verified",
    allowMobile: true,
    mobileRequested: 0,
    qualifiedCount: 10,
    ...overrides,
  };
}

test("allows: fit 85 (>= 80), DM found, verified email, allow_mobile, under quota", () => {
  assert.equal(phoneGate(base()).allow, true);
});

test("allows: fit 90+ clears the gate even with no verified email", () => {
  const d = phoneGate(base({ fitScore: PHONE_GATE_HIGH_FIT, emailStatus: "unknown" }));
  assert.equal(d.allow, true);
});

test("allows: likely_valid email is sendable enough at fit 80-89", () => {
  assert.equal(phoneGate(base({ fitScore: 80, emailStatus: "likely_valid" })).allow, true);
});

test("refuses: fit below 80 regardless of everything else", () => {
  const d = phoneGate(base({ fitScore: 79 }));
  assert.equal(d.allow, false);
  assert.match(d.reason ?? "", /below the 80 floor/);
});

test("refuses: fit 80-89 without a verified/likely_valid email", () => {
  const d = phoneGate(base({ fitScore: 85, emailStatus: "catch_all" }));
  assert.equal(d.allow, false);
  assert.match(d.reason ?? "", /below 90/);
});

test("refuses: no decision maker found, however high the fit score", () => {
  const d = phoneGate(base({ fitScore: 95, decisionMakerFound: false }));
  assert.equal(d.allow, false);
  assert.match(d.reason ?? "", /no decision maker/);
});

test("refuses: job.allow_mobile is false", () => {
  const d = phoneGate(base({ allowMobile: false }));
  assert.equal(d.allow, false);
  assert.match(d.reason ?? "", /allow_mobile/);
});

test("refuses: mobile requests already at/over the 30% share of qualified companies", () => {
  const d = phoneGate(base({ mobileRequested: 3, qualifiedCount: 10 })); // 30% exactly
  assert.equal(d.allow, false);
  assert.match(d.reason ?? "", /cap 30%/);
});

test("allows: just under the 30% share", () => {
  const d = phoneGate(base({ mobileRequested: 2, qualifiedCount: 10 })); // 20%
  assert.equal(d.allow, true);
});

test("a custom mobileShareMax overrides the default", () => {
  const d = phoneGate(base({ mobileRequested: 1, qualifiedCount: 10, mobileShareMax: 0.05 })); // 10% > 5% cap
  assert.equal(d.allow, false);
  assert.notEqual(DEFAULT_MOBILE_SHARE_MAX, 0.05);
});

test("a zero qualifiedCount never divides by zero — treated as not yet over quota", () => {
  const d = phoneGate(base({ qualifiedCount: 0, mobileRequested: 0 }));
  assert.equal(d.allow, true);
});
