import { test } from "node:test";
import assert from "node:assert/strict";
import { runWaterfall, type Rung, type RungContext } from "./waterfall";

function ctx(overrides: Partial<RungContext> = {}): RungContext {
  return { companyId: "co_1", companyName: "Acme Roofing", fitScore: 80, allowLive: true, ...overrides };
}

function missRung(id: string, reason = "no match"): Rung {
  return { id, enabled: () => true, gate: () => true, costUnits: 0, call: async () => ({ hit: false, costUsd: 0, reason }) };
}
function hitRung(id: string, value = "found@acme.com"): Rung {
  return {
    id, enabled: () => true, gate: () => true, costUnits: 1,
    call: async () => ({ hit: true, kind: "email", value, provider: id, confidence: 0.5, verificationStatus: "unknown", costUsd: 0.05 }),
  };
}

test("runWaterfall: first hit wins, later rungs never called", async () => {
  let thirdCalled = false;
  const rungs: Rung[] = [
    missRung("a"),
    hitRung("b"),
    { id: "c", enabled: () => true, gate: () => true, costUnits: 0, call: async () => { thirdCalled = true; return { hit: false, costUsd: 0, reason: "unreachable" }; } },
  ];
  const r = await runWaterfall(rungs, ctx());
  assert.equal(r.result?.provider, "b");
  assert.equal(thirdCalled, false);
  assert.deepEqual(r.log.map((l) => [l.id, l.outcome]), [["a", "miss"], ["b", "hit"]]);
});

test("runWaterfall: an unconfigured (disabled) rung is skipped with reason not_configured, no call", async () => {
  let called = false;
  const rungs: Rung[] = [
    { id: "paid", enabled: () => false, gate: () => true, costUnits: 1, call: async () => { called = true; return { hit: false, costUsd: 0, reason: "n/a" }; } },
    hitRung("free"),
  ];
  const r = await runWaterfall(rungs, ctx());
  assert.equal(called, false);
  assert.equal(r.log[0].outcome, "skipped");
  assert.equal(r.log[0].reason, "not_configured");
  assert.equal(r.result?.provider, "free");
});

test("runWaterfall: a gated-out rung is skipped with reason gated, no call", async () => {
  let called = false;
  const rungs: Rung[] = [
    { id: "needs-person", enabled: () => true, gate: (c) => Boolean(c.person), costUnits: 1, call: async () => { called = true; return { hit: false, costUsd: 0, reason: "n/a" }; } },
  ];
  const r = await runWaterfall(rungs, ctx({ person: undefined }));
  assert.equal(called, false);
  assert.equal(r.log[0].outcome, "skipped");
  assert.equal(r.log[0].reason, "gated");
  assert.equal(r.result, null);
});

test("runWaterfall: every rung missing returns null with a full miss log and accumulated cost", async () => {
  const rungs: Rung[] = [
    { id: "a", enabled: () => true, gate: () => true, costUnits: 1, call: async () => ({ hit: false, costUsd: 0.02, reason: "miss a" }) },
    { id: "b", enabled: () => true, gate: () => true, costUnits: 1, call: async () => ({ hit: false, costUsd: 0.03, reason: "miss b" }) },
  ];
  const r = await runWaterfall(rungs, ctx());
  assert.equal(r.result, null);
  assert.equal(r.log.length, 2);
  assert.equal(r.totalCostUsd, 0.05);
});

test("runWaterfall: a rung that throws is recorded as a $0 miss, not an aborted waterfall", async () => {
  const rungs: Rung[] = [
    { id: "boom", enabled: () => true, gate: () => true, costUnits: 1, call: async () => { throw new Error("provider exploded"); } },
    hitRung("recovers"),
  ];
  const r = await runWaterfall(rungs, ctx());
  assert.equal(r.log[0].outcome, "miss");
  assert.equal(r.log[0].reason, "provider exploded");
  assert.equal(r.log[0].costUsd, 0);
  assert.equal(r.result?.provider, "recovers");
});

test("runWaterfall: an empty rung list is a clean null result", async () => {
  const r = await runWaterfall([], ctx());
  assert.equal(r.result, null);
  assert.deepEqual(r.log, []);
  assert.equal(r.totalCostUsd, 0);
});
