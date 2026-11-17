// Tests for triage bookkeeping: success-only handled, three-strike give-up, v1 migration, bounds.

import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyState, migrate, markHandled, markFailed, markNoted, isHandled, isNoted, bound, MAX_ATTEMPTS } from "./triageState";

test("v1 array migrates into handled; garbage starts fresh", () => {
  assert.deepEqual(migrate(["a", "b", 3]).handled, ["a", "b"]);
  assert.deepEqual(migrate("nope"), emptyState());
  assert.deepEqual(migrate({ v: 2, handled: ["x"] }).noted, []);
});

test("a failure is retried until MAX_ATTEMPTS, then retired loudly", () => {
  let s = emptyState();
  for (let i = 1; i < MAX_ATTEMPTS; i++) {
    const r = markFailed(s, "m1", "2026-09-14T00:00:00Z"); s = r.state;
    assert.equal(r.gaveUp, false); assert.equal(s.failed.m1.attempts, i); assert.equal(isHandled(s, "m1"), false);
  }
  const last = markFailed(s, "m1");
  assert.equal(last.gaveUp, true); assert.equal(isHandled(last.state, "m1"), true); assert.equal("m1" in last.state.failed, false);
});

test("markHandled clears a pending failure record", () => {
  const s = markHandled(markFailed(emptyState(), "m2").state, "m2");
  assert.equal(isHandled(s, "m2"), true); assert.equal("m2" in s.failed, false);
});

test("noted is separate from handled", () => {
  const s = markNoted(emptyState(), "u1");
  assert.equal(isNoted(s, "u1"), true); assert.equal(isHandled(s, "u1"), false);
});

test("bound keeps the most recent 2000 ids", () => {
  const s = bound({ v: 2, handled: Array.from({ length: 2500 }, (_, i) => `h${i}`), noted: [], failed: {} });
  assert.equal(s.handled.length, 2000); assert.equal(s.handled[0], "h500");
});
