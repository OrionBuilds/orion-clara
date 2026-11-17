import { test } from "node:test";
import assert from "node:assert/strict";
import {
  warmupCapForDay, pickSenderDomain, domainBreakerShouldPause, globalBreakerShouldPause,
  DOMAIN_HARD_BOUNCE_THRESHOLD, DOMAIN_COMPLAINT_THRESHOLD, GLOBAL_BREAKER_WINDOW, GLOBAL_BREAKER_RATE,
  type SenderDomainState,
} from "./senderRotation";

function domain(overrides: Partial<SenderDomainState> = {}): SenderDomainState {
  return { id: "d1", domain: "mail.acme.com", active: true, sentToday: 0, ...overrides };
}

// ── warmupCapForDay ──────────────────────────────────────────────────────────────────────────

test("warmupCapForDay: no warmup fields at all -> unlimited (Infinity)", () => {
  assert.equal(warmupCapForDay(domain()), Infinity);
});
test("warmupCapForDay: currentDailyLimit with no ramp fields -> that flat limit", () => {
  assert.equal(warmupCapForDay(domain({ currentDailyLimit: 200 })), 200);
});
test("warmupCapForDay: day 0 of a ramp is exactly start_daily_volume", () => {
  const d = domain({ currentDailyLimit: 10000, startDailyVolume: 25, targetDailyVolume: 10000, rampDurationDays: 21, warmupStartedAt: new Date().toISOString() });
  assert.equal(warmupCapForDay(d, new Date()), 25);
});
test("warmupCapForDay: midway through the ramp is the linear interpolation, never exceeding current_daily_limit", () => {
  const start = new Date("2026-01-01T00:00:00Z");
  const d = domain({ currentDailyLimit: 10000, startDailyVolume: 25, targetDailyVolume: 10025, rampDurationDays: 10, warmupStartedAt: start.toISOString() });
  const atDay5 = new Date(start.getTime() + 5 * 86_400_000);
  assert.equal(warmupCapForDay(d, atDay5), 5025); // 25 + 5*(10025-25)/10 = 25 + 5000
});
test("warmupCapForDay: past the ramp window is clamped at current_daily_limit, not an unbounded projection", () => {
  const start = new Date("2026-01-01T00:00:00Z");
  const d = domain({ currentDailyLimit: 500, startDailyVolume: 25, targetDailyVolume: 10000, rampDurationDays: 10, warmupStartedAt: start.toISOString() });
  const atDay100 = new Date(start.getTime() + 100 * 86_400_000);
  assert.equal(warmupCapForDay(d, atDay100), 500);
});

// ── pickSenderDomain ─────────────────────────────────────────────────────────────────────────

test("pickSenderDomain: picks the least-used-today eligible domain", () => {
  const domains = [domain({ id: "a", sentToday: 10 }), domain({ id: "b", sentToday: 3 }), domain({ id: "c", sentToday: 7 })];
  assert.equal(pickSenderDomain(domains)?.id, "b");
});
test("pickSenderDomain: excludes inactive domains and ones over their cap", () => {
  const domains = [
    domain({ id: "inactive", active: false, sentToday: 0 }),
    domain({ id: "over_cap", currentDailyLimit: 5, sentToday: 5 }),
    domain({ id: "ok", currentDailyLimit: 5, sentToday: 4 }),
  ];
  assert.equal(pickSenderDomain(domains)?.id, "ok");
});
test("pickSenderDomain: a sticky domain is preferred when still eligible, even if not least-used", () => {
  const domains = [domain({ id: "sticky", sentToday: 10 }), domain({ id: "other", sentToday: 1 })];
  assert.equal(pickSenderDomain(domains, { stickyDomainId: "sticky" })?.id, "sticky");
});
test("pickSenderDomain: an exhausted sticky domain falls through to least-used-today", () => {
  const domains = [domain({ id: "sticky", currentDailyLimit: 5, sentToday: 5 }), domain({ id: "other", sentToday: 1 })];
  assert.equal(pickSenderDomain(domains, { stickyDomainId: "sticky" })?.id, "other");
});
test("pickSenderDomain: no eligible domain returns undefined, never throws", () => {
  const domains = [domain({ active: false })];
  assert.equal(pickSenderDomain(domains), undefined);
  assert.equal(pickSenderDomain([]), undefined);
});

// ── Breakers ─────────────────────────────────────────────────────────────────────────────────

test(`domainBreakerShouldPause: pauses at exactly ${DOMAIN_HARD_BOUNCE_THRESHOLD} hard bounces, not before`, () => {
  assert.equal(domainBreakerShouldPause({ hardBouncesToday: DOMAIN_HARD_BOUNCE_THRESHOLD - 1, complaintsToday: 0 }).pause, false);
  assert.equal(domainBreakerShouldPause({ hardBouncesToday: DOMAIN_HARD_BOUNCE_THRESHOLD, complaintsToday: 0 }).pause, true);
});
test(`domainBreakerShouldPause: a single complaint (>= ${DOMAIN_COMPLAINT_THRESHOLD}) pauses immediately`, () => {
  const d = domainBreakerShouldPause({ hardBouncesToday: 0, complaintsToday: 1 });
  assert.equal(d.pause, true);
  assert.match(d.reason ?? "", /complaint/);
});
test("domainBreakerShouldPause: under both thresholds does not pause", () => {
  assert.equal(domainBreakerShouldPause({ hardBouncesToday: 2, complaintsToday: 0 }).pause, false);
});

test(`globalBreakerShouldPause: never pauses under the ${GLOBAL_BREAKER_WINDOW}-send sample floor, however bad the rate`, () => {
  assert.equal(globalBreakerShouldPause(50, 40).pause, false);
});
test(`globalBreakerShouldPause: pauses once the rate exceeds ${GLOBAL_BREAKER_RATE * 100}% over ${GLOBAL_BREAKER_WINDOW}+ sends`, () => {
  assert.equal(globalBreakerShouldPause(100, 3).pause, false); // exactly 3% — not OVER
  assert.equal(globalBreakerShouldPause(100, 4).pause, true);
});
