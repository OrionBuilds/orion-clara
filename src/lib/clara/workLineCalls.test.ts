// End of a work-line call (workLineCalls.ts): what counts as important, what can be booked, and the
// plain-English text the owner gets.

import { test } from "node:test";
import assert from "node:assert/strict";
import { planWorkLineCall, importantCallText, missedTransferDid } from "./workLineCalls";
import type { InboundCallState } from "./call-sessions";

function state(p: Partial<InboundCallState>): InboundCallState {
  return {
    callSid: "CA1", fromE164: "+18135550100", turns: [], learned: {}, status: "ended",
    startedAt: "", updatedAt: "", line: "work", profile: { kind: "client", name: "Jackson", company: "Acme Co" }, ...p,
  };
}

test("a transfer the owner didn't take is always important", () => {
  const s = state({ learned: { need: "quick question about fonts" }, transferTried: true, transferAccepted: false });
  const plan = planWorkLineCall(s, "qualified");
  assert.equal(plan.missedTransfer, true);
  assert.equal(plan.important, true);
  assert.equal(importantCallText(plan, s), "I tried to put Jackson (Acme Co) through to you but couldn't reach you. They need: quick question about fonts. Call back on +18135550100.");
});

test("an urgent client call is important; a routine one waits for the brief", () => {
  const urgent = planWorkLineCall(state({ learned: { need: "checkout is broken", timeline: "today" } }), "qualified");
  assert.equal(urgent.important, true);
  const routine = planWorkLineCall(state({ learned: { need: "wants to chat about next quarter" } }), "qualified");
  assert.equal(routine.important, false);
  assert.equal(routine.callback, true);
});

test("a call the owner took is never texted about again", () => {
  const plan = planWorkLineCall(state({ learned: { need: "site is down today" }, transferTried: true, transferAccepted: true }), "transferred");
  assert.equal(plan.important, false);
  assert.equal(plan.callback, false);
});

test("only a slot Clara offered can be booked", () => {
  const offered = ["2026-09-28T14:00:00.000Z"];
  assert.equal(planWorkLineCall(state({ offeredSlots: offered, learned: { bookSlot: offered[0] } }), "qualified").bookSlot, offered[0]);
  assert.equal(planWorkLineCall(state({ offeredSlots: offered, learned: { bookSlot: "2026-09-28T03:00:00.000Z" } }), "qualified").bookSlot, undefined);
});

test("a hang-up with nothing learned is a callback, not an important text", () => {
  const plan = planWorkLineCall(state({ profile: { kind: "unknown" } }), "qualified");
  assert.equal(plan.important, false);
  assert.equal(plan.callback, true);
  assert.equal(plan.who, "+18135550100");
});

test("the caller hears one neutral line; the owner is told what his phone actually did", () => {
  const base = { learned: { need: "site is down today" }, transferTried: true, transferAccepted: false };
  const declined = planWorkLineCall(state({ ...base, transferOutcome: "declined" }), "qualified");
  const noReply = planWorkLineCall(state({ ...base, transferOutcome: "no-reply" }), "qualified");
  const noAnswer = planWorkLineCall(state({ ...base, transferOutcome: "no-answer" }), "qualified");
  const voicemail = planWorkLineCall(state({ ...base, transferOutcome: "voicemail" }), "qualified");
  for (const p of [declined, noReply, noAnswer, voicemail]) { assert.equal(p.missedTransfer, true); assert.equal(p.important, true); }
  assert.match(importantCallText(declined, state(base)), /^You passed on Jackson \(Acme Co\)'s call/);
  assert.match(importantCallText(noReply, state(base)), /didn't hear back in time/);
  assert.match(importantCallText(noAnswer, state(base)), /your phone didn't answer/);
  assert.match(importantCallText(voicemail, state(base)), /Your voicemail picked up/);
  // The record for the brief and her memory says the same.
  assert.match(missedTransferDid("declined"), /you passed/);
  assert.match(missedTransferDid("voicemail"), /voicemail/);
  assert.notEqual(missedTransferDid("no-reply"), missedTransferDid("no-answer"));
  // Hung up while holding: the owner was texted live, so the end-of-call text stays quiet (the brief still lists them).
  const left = planWorkLineCall(state({ ...base, transferOutcome: "caller-left" }), "qualified");
  assert.equal(left.missedTransfer, true);
  assert.equal(left.important, false);
  assert.equal(left.callback, true);
  // A connected transfer is never a "missed" one, whatever the outcome field says.
  assert.equal(planWorkLineCall(state({ ...base, transferAccepted: true, transferOutcome: "connected" }), "transferred").missedTransfer, false);
});
