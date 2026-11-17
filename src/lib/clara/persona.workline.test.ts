// The work-line identity (persona.ts, 2026-09-29): the owner's assistant on his forwarded phone — its own
// text, not the front desk's, and the prompt built from it never says "main line".

import { test } from "node:test";
import assert from "node:assert/strict";
import { CLARA_IDENTITY, CLARA_BUSINESS_IDENTITY, CLARA_WORKLINE_IDENTITY, identityFor } from "./persona";
import { workLinePrompt } from "./inbound-call-brain";
import type { InboundCallState } from "./call-sessions";

test("identityFor('workline') is its own text, not derived from either other identity", () => {
  assert.equal(identityFor("workline"), CLARA_WORKLINE_IDENTITY);
  assert.notEqual(CLARA_WORKLINE_IDENTITY, CLARA_BUSINESS_IDENTITY);
  assert.equal(CLARA_WORKLINE_IDENTITY.includes(CLARA_BUSINESS_IDENTITY), false);
  assert.equal(CLARA_WORKLINE_IDENTITY.includes(CLARA_IDENTITY), false);
  assert.equal(CLARA_BUSINESS_IDENTITY.includes(CLARA_WORKLINE_IDENTITY), false);
});

test("the work-line identity is his assistant, says so, and keeps the hard limits", () => {
  const t = CLARA_WORKLINE_IDENTITY;
  for (const front of ["main line", "Thanks for calling", "a team member will follow up", "ways to reach the company", "info@"]) {
    assert.equal(t.toLowerCase().includes(front.toLowerCase()), false, front);
  }
  assert.match(t, /work phone/);
  assert.match(t, /AI assistant/);
  assert.match(t, /never as/);
  assert.match(t, /third person/);
  assert.match(t, /Never ask for payment details/);
  assert.match(t, /Never agree to, quote or negotiate money/);
});

test("the composed work-line call prompt uses that identity, not the business one", () => {
  const state: InboundCallState = {
    callSid: "CA1", fromE164: "+18135550100", turns: [], learned: {}, status: "in-progress", startedAt: "", updatedAt: "",
    line: "work", profile: { kind: "client", name: "Jackson", company: "Acme Co" },
  };
  const prompt = workLinePrompt(state, "");
  assert.ok(prompt.startsWith(CLARA_WORKLINE_IDENTITY));
  assert.equal(prompt.includes("main line and the chat on"), false);
  assert.equal(prompt.includes("a team member will follow up"), false);
  assert.doesNotMatch(prompt, /Don't re-introduce yourself/);
  assert.match(prompt, /If they ask who you are/);
});
