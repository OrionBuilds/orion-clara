// OS clara.instruction handler: owner-described schedules run through the tool loop. Pins the
// three modes (shadow / approval / live), the missing-brief failure, the approved-send replay, and
// per-run idempotency. runIntent and every side effect are injected fakes — no model, no network.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { DueRun, ResolvedRun, PollContext, IntentOutcome } from "@autom8ionlab/agent-core";
import {
  runInstructionTask, deliverInstructionTask, buildInstructionPrompt, proposedCalls,
  SHADOW_DIRECTIVE, APPROVAL_DIRECTIVE, type InstructionDeps, type InstructionStore,
} from "./instructionTask";
import type { IntentContext } from "./intent";

const MARK = "PROPOSED-TEST-MARK";

function memStore(): InstructionStore & { data: Record<string, unknown> } {
  const data: Record<string, unknown> = {};
  return {
    data,
    async get<T>(k: string) { return data[k] as T | undefined; },
    async set(k: string, v: unknown) { data[k] = JSON.parse(JSON.stringify(v)); },
  };
}

function dueRun(over: Partial<DueRun> = {}, config: Record<string, unknown> = {}): DueRun {
  return {
    run_id: "run-1", schedule_id: "sch-1", task_key: "clara.instruction", subject_id: null,
    title: "Monday pipeline note", scheduled_for: "2026-10-26T13:00:00Z", mode: "active",
    risk_tier: "owner_review", output_kind: "owner_briefing", approval_required: false,
    lease_expires_at: "2026-10-26T13:10:00Z", attempt: 1,
    config: {
      instructions: "Summarize open deals that moved last week.",
      summary: "Weekly pipeline summary to the owner",
      scope: "CRM pipeline only", success_criteria: "Every moved deal listed",
      output_destination: "your OS inbox", external_effects: false,
      ...config,
    },
    ...over,
  };
}

const pollCtx = (mode: PollContext["mode"] = "active"): PollContext =>
  ({ osClient: { callTool: async () => { throw new Error("osClient must not be called in tests"); } }, orgId: "org", agentUserId: "u", mode } as unknown as PollContext);

function harness(outcome: Partial<IntentOutcome> = {}) {
  const intentCalls: Array<{ text: string; ctx: IntentContext }> = [];
  const owner: Array<{ title: string; text: string }> = [];
  const replayed: Array<{ name: string; args: Record<string, unknown> }> = [];
  const store = memStore();
  let replayFailOn: string | null = null;
  const deps: Partial<InstructionDeps> = {
    proposedMark: MARK,
    store,
    runIntent: async (text, ctx) => {
      intentCalls.push({ text, ctx });
      return { reply: "Three deals moved: A, B, C.", calls: [], failed: false, clarifying: false, ...outcome };
    },
    runApprovedToolCall: async (name, args) => {
      if (name === replayFailOn) return { ok: false, line: `${name}: FAILED — boom` };
      replayed.push({ name, args });
      return { ok: true, line: `${name}: ok` };
    },
    deliverToOwner: async (input) => { owner.push({ title: input.title, text: input.text }); return { ok: true }; },
  };
  return { deps, intentCalls, owner, replayed, store, failReplayOn: (n: string | null) => { replayFailOn = n; } };
}

test("missing instructions fails the run clearly and never reaches the tool loop", async () => {
  const h = harness();
  await assert.rejects(runInstructionTask(dueRun({}, { instructions: "  " }), pollCtx(), h.deps), /no "instructions"/);
  await assert.rejects(runInstructionTask(dueRun({ config: {} }), pollCtx(), h.deps), /no "instructions"/);
  assert.equal(h.intentCalls.length, 0);
});

test("shadow (agent gate or schedule not active): read-only, SHADOW directive, nothing delivered", async () => {
  for (const [ctxMode, runMode] of [["shadow", "active"], ["active", "shadow"]] as const) {
    const h = harness({
      calls: [
        { name: "pipeline_status", args: {}, resultLine: "3 moved", ok: true },
        { name: "send_email", args: { to: "x@y.com" }, resultLine: `send_email: blocked by policy — ${MARK}`, ok: false },
      ],
    });
    const res = await runInstructionTask(dueRun({ mode: runMode, run_id: `r-${ctxMode}` }), pollCtx(ctxMode), h.deps);
    assert.equal(h.intentCalls.length, 1);
    assert.deepEqual(h.intentCalls[0].ctx.scheduled, { readOnly: true });
    assert.equal(h.intentCalls[0].ctx.principal, "owner");
    assert.equal(h.intentCalls[0].ctx.source, "chat");
    assert.ok(h.intentCalls[0].text.includes(SHADOW_DIRECTIVE));
    assert.ok(h.intentCalls[0].text.startsWith('Scheduled task "Monday pipeline note" (run 2026-10-26T13:00:00Z): Summarize open deals'));
    assert.equal(h.owner.length, 0, "shadow never delivers");
    assert.equal(res.requestApproval, undefined);
    assert.match(res.summary ?? "", /^\[shadow\] Three deals moved/);
    const r = res.result as { calls: Array<{ name: string; proposed?: boolean }>; failed: number; mode: string };
    assert.equal(r.mode, "shadow");
    assert.equal(r.failed, 0, "a proposed (blocked) call is the plan, not a failure");
    assert.deepEqual(r.calls.map((c) => [c.name, !!c.proposed]), [["pipeline_status", false], ["send_email", true]]);
  }
});

test("approval_required: read-only draft parked as requestApproval with the exact proposed calls", async () => {
  const args = { to: "client@acme.example", subject: "Weekly", body: "Hi Eric — here is your weekly update." };
  const h = harness({
    reply: "Drafted the weekly update to Eric.",
    calls: [
      { name: "crm_lookup", args: { q: "Eric" }, resultLine: "found", ok: true },
      { name: "send_email", args, resultLine: `send_email: blocked by policy — ${MARK}`, ok: false },
    ],
  });
  const res = await runInstructionTask(dueRun({ approval_required: true }), pollCtx("active"), h.deps);
  assert.deepEqual(h.intentCalls[0].ctx.scheduled, { readOnly: true });
  assert.ok(h.intentCalls[0].text.includes(APPROVAL_DIRECTIVE));
  assert.ok(!h.intentCalls[0].text.includes(SHADOW_DIRECTIVE));
  assert.equal(h.owner.length, 0, "nothing is sent before approval");
  assert.ok(res.requestApproval);
  assert.equal(res.requestApproval!.action_type, "clara.instruction");
  assert.deepEqual(res.requestApproval!.draft_content.proposed_actions, [{ name: "send_email", args }]);
  const draft = (res.result as { draft: { proposed: unknown[] } }).draft;
  assert.deepEqual(draft.proposed, [{ name: "send_email", args }]);
  assert.match(res.summary ?? "", /^\[awaiting approval\]/);
});

test("external_effects alone forces the approval path", async () => {
  const h = harness();
  const res = await runInstructionTask(dueRun({}, { external_effects: true }), pollCtx("active"), h.deps);
  assert.deepEqual(h.intentCalls[0].ctx.scheduled, { readOnly: true });
  assert.ok(res.requestApproval);
  assert.equal(h.owner.length, 0);
});

test("live, no approval: tools run (not read-only), reply delivered to the owner once", async () => {
  const h = harness({ calls: [{ name: "pipeline_status", args: {}, resultLine: "ok", ok: true }, { name: "deal_lookup", args: {}, resultLine: "deal_lookup: FAILED", ok: false }] });
  const res = await runInstructionTask(dueRun(), pollCtx("active"), h.deps);
  assert.deepEqual(h.intentCalls[0].ctx.scheduled, { readOnly: false });
  assert.equal(h.owner.length, 1);
  assert.equal(h.owner[0].text, "Three deals moved: A, B, C.");
  assert.equal(res.summary, "Three deals moved: A, B, C.");
  assert.equal((res.result as { failed: number }).failed, 1);
  assert.equal(res.requestApproval, undefined);
});

test("the intent router failing fails the run", async () => {
  const h = harness({ failed: true, reply: "My planning model just failed on me" });
  await assert.rejects(runInstructionTask(dueRun(), pollCtx("active"), h.deps), /planning model just failed/);
  assert.equal(h.owner.length, 0);
});

test("idempotent per run id: a re-presented run returns the stored result without re-running or re-sending", async () => {
  const h = harness();
  const a = await runInstructionTask(dueRun(), pollCtx("active"), h.deps);
  const b = await runInstructionTask(dueRun(), pollCtx("active"), h.deps);
  assert.equal(h.intentCalls.length, 1);
  assert.equal(h.owner.length, 1);
  assert.deepEqual(b, a);
  await runInstructionTask(dueRun({ run_id: "run-2" }), pollCtx("active"), h.deps);
  assert.equal(h.intentCalls.length, 2, "a different run id is a different run");
});

test("summary is capped at the OS's 500 chars", async () => {
  const h = harness({ reply: "x".repeat(2000) });
  const res = await runInstructionTask(dueRun(), pollCtx("shadow"), h.deps);
  assert.ok((res.summary ?? "").length <= 500);
});

test("deliver replays exactly the approved calls once, resumes after a failure, and holds when not active", async () => {
  const args = { to: "client@acme.example", body: "Hi" };
  const resolved: ResolvedRun = {
    run_id: "run-9", task_key: "clara.instruction", status: "approved", deliverable_file_id: null,
    result: { draft: { reply: "Drafted it.", title: "Weekly update", destination: "email to the client", proposed: [{ name: "send_email", args }, { name: "add_contact_note", args: { note: "sent" } }] } },
  };
  const h = harness();
  await assert.rejects(deliverInstructionTask(resolved, pollCtx("shadow"), h.deps), /holding approved run/);
  assert.equal(h.replayed.length, 0);

  h.failReplayOn("add_contact_note");
  await assert.rejects(deliverInstructionTask(resolved, pollCtx("active"), h.deps), /approved add_contact_note failed/);
  assert.deepEqual(h.replayed, [{ name: "send_email", args }]);

  h.failReplayOn(null);
  const out = await deliverInstructionTask(resolved, pollCtx("active"), h.deps);
  assert.deepEqual(h.replayed.map((c) => c.name), ["send_email", "add_contact_note"], "send_email is not re-sent on retry");
  assert.equal(h.owner.length, 1);
  assert.equal(out.delivery?.executed, 2);

  await deliverInstructionTask(resolved, pollCtx("active"), h.deps);
  assert.equal(h.replayed.length, 2);
  assert.equal(h.owner.length, 1);
});

test("deliver with no proposed calls sends the approved reply to the owner", async () => {
  const h = harness();
  const resolved: ResolvedRun = {
    run_id: "run-10", task_key: "clara.instruction", status: "approved", deliverable_file_id: null,
    result: { draft: { reply: "Here is the note.", title: "Note", destination: null, proposed: [] } },
  };
  await deliverInstructionTask(resolved, pollCtx("active"), h.deps);
  assert.deepEqual(h.owner, [{ title: "Note", text: "Here is the note." }]);
});

test("pure helpers: prompt fallbacks and proposed-call extraction", () => {
  const p = buildInstructionPrompt(dueRun({}, { scope: null, success_criteria: null, output_destination: null }), { shadow: false, approval: false });
  assert.match(p, /Scope: as described in the task\./);
  assert.match(p, /Deliver to: the owner's OS inbox\./);
  assert.ok(!p.includes("SHADOW RUN") && !p.includes("APPROVAL REQUIRED"));
  assert.deepEqual(
    proposedCalls({ calls: [
      { name: "a", args: {}, resultLine: "ok", ok: true },
      { name: "b", args: { x: 1 }, resultLine: `b: blocked — ${MARK}`, ok: false },
      { name: "c", args: {}, resultLine: "c: blocked by policy — personal mail", ok: false },
    ] }, MARK),
    [{ name: "b", args: { x: 1 } }],
  );
});
