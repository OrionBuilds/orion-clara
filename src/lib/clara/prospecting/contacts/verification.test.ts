import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mapVerificationStatus, decayVerification, isInvalidTerminal, isSendable, sendCap, upgradeOnReply,
} from "./verification";

test("mapVerificationStatus: Hunter deliverable -> verified when NOT finder-only", () => {
  assert.equal(mapVerificationStatus({ provider: "hunter", verdict: "deliverable", isFinderOnly: false }), "verified");
});
test("mapVerificationStatus: Hunter accept_all (catch_all) -> catch_all regardless of finder-only", () => {
  assert.equal(mapVerificationStatus({ provider: "hunter", verdict: "catch_all", isFinderOnly: false }), "catch_all");
  assert.equal(mapVerificationStatus({ provider: "hunter", verdict: "catch_all", isFinderOnly: true }), "catch_all");
});
test("mapVerificationStatus: undeliverable -> invalid regardless of finder-only", () => {
  assert.equal(mapVerificationStatus({ provider: "hunter", verdict: "undeliverable", isFinderOnly: false }), "invalid");
  assert.equal(mapVerificationStatus({ provider: "leadmagic", verdict: "undeliverable", isFinderOnly: true }), "invalid");
});
test("mapVerificationStatus: risky -> risky regardless of finder-only", () => {
  assert.equal(mapVerificationStatus({ provider: "hunter", verdict: "risky", isFinderOnly: false }), "risky");
  assert.equal(mapVerificationStatus({ provider: "hunter", verdict: "risky", isFinderOnly: true }), "risky");
});
test("mapVerificationStatus: LeadMagic valid (deliverable) -> verified when verified independently", () => {
  assert.equal(mapVerificationStatus({ provider: "leadmagic", verdict: "deliverable", isFinderOnly: false }), "verified");
});
test("mapVerificationStatus: finder-only without verify -> likely_valid (the plan's explicit rule)", () => {
  assert.equal(mapVerificationStatus({ provider: "hunter", verdict: "deliverable", isFinderOnly: true }), "likely_valid");
  assert.equal(mapVerificationStatus({ provider: "leadmagic", verdict: "deliverable", isFinderOnly: true }), "likely_valid");
  assert.equal(mapVerificationStatus({ provider: "site", verdict: "unknown", isFinderOnly: true }), "likely_valid");
});

test("decayVerification: verified decays to likely_valid at exactly 90 days", () => {
  const verifiedAt = new Date("2026-01-01T00:00:00Z");
  const at89 = new Date(verifiedAt.getTime() + 89 * 86_400_000);
  const at90 = new Date(verifiedAt.getTime() + 90 * 86_400_000);
  assert.equal(decayVerification("verified", verifiedAt, at89), "verified");
  assert.equal(decayVerification("verified", verifiedAt, at90), "likely_valid");
});
test("decayVerification: only 'verified' decays — every other status is unaffected by age", () => {
  const old = new Date("2020-01-01T00:00:00Z");
  const now = new Date("2026-01-01T00:00:00Z");
  for (const status of ["likely_valid", "catch_all", "risky", "invalid", "unknown"] as const) {
    assert.equal(decayVerification(status, old, now), status);
  }
});

test("isInvalidTerminal: true within the 90-day window, false after", () => {
  const invalidatedAt = new Date("2026-01-01T00:00:00Z");
  assert.equal(isInvalidTerminal(invalidatedAt, new Date(invalidatedAt.getTime() + 89 * 86_400_000)), true);
  assert.equal(isInvalidTerminal(invalidatedAt, new Date(invalidatedAt.getTime() + 90 * 86_400_000)), false);
});

test("isSendable / sendCap: verified and likely_valid send normally; catch_all sends at a lower cap; risky/invalid/unknown never send", () => {
  assert.equal(isSendable("verified"), true);
  assert.equal(sendCap("verified"), "normal");
  assert.equal(isSendable("likely_valid"), true);
  assert.equal(sendCap("likely_valid"), "normal");
  assert.equal(isSendable("catch_all"), true);
  assert.equal(sendCap("catch_all"), "lower");
  for (const status of ["risky", "invalid", "unknown"] as const) {
    assert.equal(isSendable(status), false);
    assert.equal(sendCap(status), "none");
  }
});

test("upgradeOnReply: a reply upgrades catch_all to verified; every other status is unchanged", () => {
  assert.equal(upgradeOnReply("catch_all"), "verified");
  for (const status of ["verified", "likely_valid", "risky", "invalid", "unknown"] as const) {
    assert.equal(upgradeOnReply(status), status);
  }
});
