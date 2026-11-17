// The "immediate text" path for a tiered VIP (workLineCalls.ts, 2026-10-01): a VIP blocked by the owner's
// calendar, or on the message-only tier, texts him right at call-start — not only at end-of-call —
// so he can break out of his meeting if he wants to.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  planWorkLineCall, importantCallText, vipBlockedDid, messageOnlyDid, sendVipImmediateHeadsUp,
} from "./workLineCalls";
import type { InboundCallState } from "./call-sessions";

function state(p: Partial<InboundCallState>): InboundCallState {
  return {
    callSid: "CA1", fromE164: "+18135551234", turns: [], learned: {}, status: "ended",
    startedAt: "", updatedAt: "", line: "work", profile: { kind: "vip", name: "Taylor Client", tier: "transfer" }, ...p,
  };
}

test("a transfer-tier VIP blocked by the owner's calendar is always important, even with nothing learned", () => {
  const plan = planWorkLineCall(state({ vipBusyReason: "appointment" }), "qualified");
  assert.equal(plan.vipOutcome, "vip_blocked_calendar");
  assert.equal(plan.vipReasonKind, "appointment");
  assert.equal(plan.important, true);
  assert.equal(plan.missedTransfer, false); // never tried — gated before any ring was attempted
});

test("a message-only VIP is always important too, regardless of tier being set but never busy", () => {
  const plan = planWorkLineCall(state({ profile: { kind: "vip", name: "Casey Contractor", tier: "message_only" } }), "qualified");
  assert.equal(plan.vipOutcome, "message_only");
  assert.equal(plan.important, true);
});

test("vipBlockedDid names who and why, never the event title", () => {
  assert.equal(vipBlockedDid("Taylor Client", "appointment"), "I took a message for Taylor Client — I didn't ring you because you were at an appointment.");
  assert.equal(vipBlockedDid("Taylor Client", "ooo"), "I took a message for Taylor Client — I didn't ring you because you were out of the office.");
});

test("messageOnlyDid makes the policy explicit for the log", () => {
  assert.match(messageOnlyDid("Casey Contractor"), /message-only/);
});

test("importantCallText leads with the VIP-specific reason, not the generic 'called your work phone' line", () => {
  const s = state({ vipBusyReason: "meeting", learned: { need: "wants a change order approved" } });
  const plan = planWorkLineCall(s, "qualified");
  const text = importantCallText(plan, s);
  assert.match(text, /^I took a message for Taylor Client — I didn't ring you because you were in a meeting\./);
  assert.match(text, /They need: wants a change order approved\./);

  const s2 = state({ profile: { kind: "vip", name: "Casey Contractor", tier: "message_only" }, learned: { need: "site walkthrough question" } });
  const plan2 = planWorkLineCall(s2, "qualified");
  assert.match(importantCallText(plan2, s2), /^I took a message for Casey Contractor — he's on your message-only list/);
});

test("sendVipImmediateHeadsUp fires on the vip-heads-up matter and reports success", async () => {
  const calls: Array<{ contact: string; matter: string; text: string }> = [];
  const ok = await sendVipImmediateHeadsUp(
    { contact: "+18135551234", text: "Taylor called and you're at an appointment — I didn't ring you. — Clara" },
    { send: async (item) => { calls.push(item); return "send"; } },
  );
  assert.equal(ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].matter, "vip-heads-up");
  assert.equal(calls[0].contact, "+18135551234");
});

test("sendVipImmediateHeadsUp reports false on duplicate/quiet-hours/failed, and never throws", async () => {
  for (const outcome of ["duplicate", "quiet-hours", "no-number", "failed"]) {
    const ok = await sendVipImmediateHeadsUp({ contact: "+1", text: "x" }, { send: async () => outcome });
    assert.equal(ok, false, outcome);
  }
  const ok = await sendVipImmediateHeadsUp({ contact: "+1", text: "x" }, { send: async () => { throw new Error("boom"); } });
  assert.equal(ok, false);
});
