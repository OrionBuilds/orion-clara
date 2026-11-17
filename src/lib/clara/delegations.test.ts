// Tests for the delegation reducer: each transition is announced exactly once, a receipt-less
// hand-off goes stale after six hours, terminal rows are left alone and pruned after 14 days.

import { test } from "node:test";
import assert from "node:assert/strict";
import { newDelegation, applyTransition, pruneRows, STALE_AFTER_MS, PRUNE_AFTER_MS, STALE_PRUNE_AFTER_MS, type Delegation } from "./delegations";

const T0 = "2026-09-14T10:00:00.000Z";
const at = (ms: number) => new Date(Date.parse(T0) + ms).toISOString();
const row = (over: Partial<Delegation> = {}): Delegation => ({
  ...newDelegation({ source: { kind: "email", ref: "m1" }, summary: "fix the form" }, "friday", { taskIds: ["t1"] }, T0),
  ...over,
});

test("pending changes nothing and announces nothing", () => {
  const { row: r, notify } = applyTransition(row(), "pending", at(1000));
  assert.equal(r.status, "open"); assert.equal(notify, null); assert.equal(r.lastPolledAt, at(1000));
});

test("done is announced once, then never again", () => {
  const first = applyTransition(row(), "done", at(1000));
  assert.equal(first.notify, "done"); assert.equal(first.row.status, "done");
  const second = applyTransition(first.row, "done", at(2000));
  assert.equal(second.notify, null); assert.deepEqual(second.row.notified, ["done"]);
});

test("parked then done announces both, in order", () => {
  const p = applyTransition(row(), "parked", at(1000));
  assert.equal(p.notify, "parked");
  const d = applyTransition(p.row, "done", at(2000));
  assert.equal(d.notify, "done"); assert.deepEqual(d.row.notified, ["parked", "done"]);
});

test("a hand-off with no receipt goes stale after six hours, not before", () => {
  const r = row({ benchTaskIds: [], runId: undefined });
  assert.equal(applyTransition(r, "pending", at(STALE_AFTER_MS - 1)).notify, null);
  const s = applyTransition(r, "pending", at(STALE_AFTER_MS + 1));
  assert.equal(s.notify, "stale"); assert.equal(s.row.status, "stale");
});

test("a hand-off WITH a receipt never goes stale on pending", () => {
  assert.equal(applyTransition(row(), "pending", at(2 * STALE_AFTER_MS)).notify, null);
});

test("failed rows are terminal; a later poll cannot resurrect them", () => {
  const f = applyTransition(row(), "failed", at(1000));
  assert.equal(f.notify, "failed");
  assert.equal(applyTransition(f.row, "done", at(2000)).notify, null);
});

test("prune drops terminal rows older than 14 days and keeps open ones", () => {
  const old = applyTransition(row(), "done", at(0)).row;
  const fresh = applyTransition(row(), "done", at(PRUNE_AFTER_MS)).row;
  const open = row();
  const kept = pruneRows([old, fresh, open], Date.parse(at(PRUNE_AFTER_MS + 1000)));
  assert.deepEqual(kept.map((r) => r.id), [fresh.id, open.id]);
});

test("stale hand-offs are pruned after 48 hours; done/failed keep 14 days; open rows are never pruned", () => {
  const now = Date.parse(at(STALE_PRUNE_AFTER_MS + 60_000));
  const stale = { ...row({ id: "stale" }), status: "stale" as const, lastPolledAt: T0 };
  const staleFresh = { ...row({ id: "stale-fresh" }), status: "stale" as const, lastPolledAt: at(STALE_PRUNE_AFTER_MS) };
  const done = { ...row({ id: "done" }), status: "done" as const, lastPolledAt: T0 };
  const open = { ...row({ id: "open" }), status: "open" as const, lastPolledAt: T0 };
  assert.deepEqual(pruneRows([stale, staleFresh, done, open], now).map((r) => r.id), ["stale-fresh", "done", "open"]);
  assert.equal(STALE_PRUNE_AFTER_MS, 48 * 60 * 60_000);
});
