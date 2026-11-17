// Tests for PR 15's sequence CRUD + enrollment wrappers in osBridge.ts. Mocks the OS MCP wire
// boundary itself — OsMcpClient.prototype.callTool — rather than osBridge's own (unexported,
// module-private) `call()` helper, since there's no other seam: `prospectClient` is a module-level
// instance and `call()`/`prospectCallTool()` are plain function declarations, not object methods,
// so they can't be monkey-patched from outside this module the way `t.mock.method` needs. callTool
// IS a real prototype method shared by every OsMcpClient instance including the module-private
// `prospectClient`, and `t.mock.method` auto-restores it after each test — exactly the seam these
// tests need without requiring --experimental-test-module-mocks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { OsMcpClient } from "@autom8ionlab/agent-core";
import {
  sequencesCreate, sequencesGet, sequencesList, sequencesUpdate, sequenceStepsSet,
  sequenceEnrollmentsList, sequenceUnenroll,
} from "./osBridge";

function wireResult(payload: unknown) {
  return [{ type: "text", text: JSON.stringify(payload) }];
}

function mockCallTool(t: import("node:test").TestContext, impl: (name: string, args: Record<string, unknown>) => unknown) {
  let captured: { name: string; args: Record<string, unknown> } | undefined;
  t.mock.method(OsMcpClient.prototype, "callTool", async (name: string, args: Record<string, unknown> = {}) => {
    captured = { name, args };
    return impl(name, args);
  });
  return () => captured;
}

test("sequencesCreate: calls sequences_create with the given fields and returns {sequence, steps}", async (t) => {
  const getCall = mockCallTool(t, () => wireResult({ sequence: { id: "seq_1", name: "Welcome", status: "draft" }, steps: [] }));
  const r = await sequencesCreate({ name: "Welcome", description: "intro sequence" });
  assert.equal(getCall()?.name, "sequences_create");
  assert.deepEqual(getCall()?.args, { name: "Welcome", description: "intro sequence" });
  assert.equal(r.sequence.id, "seq_1");
  assert.equal(r.sequence.status, "draft");
  assert.deepEqual(r.steps, []);
});

test("sequencesGet: a found sequence returns {sequence, steps, enrollment_counts}", async (t) => {
  mockCallTool(t, () => wireResult({
    sequence: { id: "seq_1", name: "Welcome", status: "draft" },
    steps: [{ position: 1, channel: "email", template: { body: "Hi" } }],
    enrollment_counts: { active: 3, stopped: 1 },
  }));
  const r = await sequencesGet("seq_1");
  assert.equal(r.sequence?.id, "seq_1");
  assert.equal(r.steps.length, 1);
  assert.deepEqual(r.enrollment_counts, { active: 3, stopped: 1 });
});

test("sequencesGet: a missing id returns sequence:null (the OS's one() result), never throws", async (t) => {
  mockCallTool(t, () => wireResult({ sequence: null, steps: [], enrollment_counts: {} }));
  const r = await sequencesGet("does_not_exist");
  assert.equal(r.sequence, null);
  assert.deepEqual(r.steps, []);
});

test("sequencesList: returns the bare array, filtered by status when given", async (t) => {
  const getCall = mockCallTool(t, () => wireResult([{ id: "seq_1", name: "Welcome", status: "active" }]));
  const r = await sequencesList({ status: "active" });
  assert.equal(getCall()?.args.status, "active");
  assert.equal(r.length, 1);
  assert.equal(r[0].id, "seq_1");
});

test("sequencesUpdate: wraps the OS's bare patched row into {sequence}", async (t) => {
  const getCall = mockCallTool(t, () => wireResult({ id: "seq_1", name: "Welcome", status: "active" }));
  const r = await sequencesUpdate("seq_1", { status: "active" });
  assert.equal(getCall()?.name, "sequences_update");
  assert.deepEqual(getCall()?.args, { id: "seq_1", status: "active" });
  assert.equal(r.sequence?.status, "active");
});

test("sequenceStepsSet: sends sequence_id + steps and returns {steps}", async (t) => {
  const getCall = mockCallTool(t, () => wireResult({ steps: [{ position: 1, channel: "email", template: { body: "Hi" } }, { position: 2, channel: "task", template: { body: "Call them" } }] }));
  const steps = [
    { position: 1, channel: "email" as const, template: { body: "Hi" } },
    { position: 2, channel: "task" as const, template: { body: "Call them" } },
  ];
  const r = await sequenceStepsSet("seq_1", steps);
  assert.equal(getCall()?.name, "sequence_steps_set");
  assert.deepEqual(getCall()?.args.sequence_id, "seq_1");
  assert.equal(r.steps.length, 2);
});

test("sequenceEnrollmentsList: wraps the OS's bare array into {enrollments}", async (t) => {
  const getCall = mockCallTool(t, () => wireResult([{ id: "enr_1", sequence_id: "seq_1", status: "active" }]));
  const r = await sequenceEnrollmentsList({ sequence_id: "seq_1" });
  assert.equal(getCall()?.name, "sequence_enrollments_list");
  assert.equal(r.enrollments.length, 1);
  assert.equal(r.enrollments[0].id, "enr_1");
});

test("sequenceEnrollmentsList: forwards sequence_id/status/limit/offset filters unchanged", async (t) => {
  const getCall = mockCallTool(t, () => wireResult([]));
  const r = await sequenceEnrollmentsList({ sequence_id: "seq_1", status: "active", limit: 50, offset: 10 });
  assert.deepEqual(getCall()?.args, { sequence_id: "seq_1", status: "active", limit: 50, offset: 10 });
  assert.deepEqual(r.enrollments, []);
});

test("sequencesList: a non-array OS response degrades to [], never throws", async (t) => {
  mockCallTool(t, () => wireResult(null));
  const r = await sequencesList();
  assert.deepEqual(r, []);
});

test("sequenceUnenroll: narrows the single enrollment_id into the OS's enrollment_ids array", async (t) => {
  const getCall = mockCallTool(t, () => wireResult({ stopped: 1 }));
  const r = await sequenceUnenroll({ enrollment_id: "enr_1", reason: "manual" });
  assert.equal(getCall()?.name, "sequence_unenroll");
  assert.deepEqual(getCall()?.args, { enrollment_ids: ["enr_1"], reason: "manual" });
  assert.equal(r.ok, true);
  assert.equal(r.stopped, 1);
});
