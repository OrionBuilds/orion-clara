// Regression tests for the Oct 1 "every discover task expired" failure: the claim envelope, the
// report payload shape, and the (0,0) search center.

import { test } from "node:test";
import assert from "node:assert/strict";
import { claimedTasksFrom, reportArgs } from "./osBridge";
import { resolveCenter, hasRealCenter } from "./discovery/center";
import type { JobSpec } from "./types";

test("claimedTasksFrom reads the {tasks} envelope the claim tool actually returns", () => {
  const t = { id: "t1", job_id: "j1", task_type: "discover", stage: 10, attempt: 0, input: {}, idempotency_key: "k" };
  assert.equal(claimedTasksFrom({ tasks: [t], server_time: "x", swept: { released: 0 } }).length, 1);
  assert.equal(claimedTasksFrom([t]).length, 1);
  assert.deepEqual(claimedTasksFrom({ tasks: [] }), []);
  assert.deepEqual(claimedTasksFrom(null), []);
});

test("reportArgs matches the report tool schema (task_id, not id; no fan_out/bump/not_before)", () => {
  const a = reportArgs("t1", { status: "failed", error: "boom", not_before: "2026-01-01", bump: ["discovered"], fan_out: [] } as never);
  assert.deepEqual(a, { task_id: "t1", status: "failed", error: "boom" });
  assert.deepEqual(reportArgs("t2", { status: "completed", output: { n: 3 }, cost_usd: 0.21 }), { task_id: "t2", status: "completed", output: { n: 3 }, cost_usd: 0.21 });
});

const spec = (loc: Partial<JobSpec["location"]>): JobSpec => ({ location: { label: "Hillsborough County", state: "FL", radius_miles: 25, ...loc } } as unknown as JobSpec);

test("hasRealCenter rejects missing and (0,0) centers", () => {
  assert.equal(hasRealCenter(spec({}).location), false);
  assert.equal(hasRealCenter(spec({ lat: 0, lng: 0 }).location), false);
  assert.equal(hasRealCenter(spec({ lat: 27.9, lng: -82.3 }).location), true);
});

test("resolveCenter geocodes the label, and refuses rather than searching (0,0)", async () => {
  const ok = await resolveCenter(spec({}), async (q) => { assert.match(q, /Hillsborough County, FL/); return { lat: 27.9, lng: -82.3 }; });
  assert.equal(ok.ok, true);
  if (ok.ok) { assert.equal(ok.spec.location.lat, 27.9); assert.equal(ok.spec.location.lng, -82.3); }
  const miss = await resolveCenter(spec({}), async () => null);
  assert.equal(miss.ok, false);
  const kept = await resolveCenter(spec({ lat: 28.5, lng: -81.4 }), async () => { throw new Error("should not geocode"); });
  assert.equal(kept.ok && kept.spec.location.lat, 28.5);
});
