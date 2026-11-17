// The put-through greeting-hit decision (voice/route.ts, 2026-10-01): decideVipGreeting is the pure
// core of "what does Clara say and do when a tiered VIP's call comes in" — message-only vs transfer,
// and transfer-tier gated on the owner's calendar. The Next.js route itself isn't unit-tested anywhere in
// this codebase (it's all Twilio form-data/signature plumbing); this is the part that decides.

import { test } from "node:test";
import assert from "node:assert/strict";
import { decideVipGreeting, vipBlocksLiveTransfer, vipTakeMessageFallback, messageOnlyGreeting } from "./workLine";
import { OWNER_FIRST } from "./owner";

test("message_only tier never checks the calendar and never holds — always the take-a-message greeting", () => {
  const decision = decideVipGreeting("Blake", "message_only", null);
  assert.equal(decision.outcome, "message_only");
  if (decision.outcome !== "message_only") throw new Error("unreachable");
  assert.equal(decision.greeting, messageOnlyGreeting("Blake"));
  assert.match(decision.greeting, /unavailable to come to the phone/);
  assert.match(decision.headsUp, /Blake called/);
  assert.match(decision.headsUp, /message-only/);
});

test("message_only ignores a busy event even if one is passed in — tier alone decides", () => {
  const decision = decideVipGreeting("Blake", "message_only", { summary: "Doctor" });
  assert.equal(decision.outcome, "message_only");
});

test("transfer tier with no busy event goes straight to hold — unchanged behavior", () => {
  assert.deepEqual(decideVipGreeting("Eric", "transfer", null), { outcome: "hold" });
});

test("transfer tier with a busy event declines with calendar-aware reasoning instead of holding", () => {
  const decision = decideVipGreeting("Eric", "transfer", { summary: "Dentist" });
  assert.equal(decision.outcome, "vip_blocked_calendar");
  if (decision.outcome !== "vip_blocked_calendar") throw new Error("unreachable");
  assert.equal(decision.reasonKind, "appointment");
  assert.match(decision.greeting, new RegExp(`Hi Eric, it's Clara, ${OWNER_FIRST}'s AI assistant\\.`));
  assert.match(decision.greeting, /at an appointment right now/);
  assert.match(decision.greeting, /Can I take a message/);
  assert.match(decision.headsUp, /Eric called/);
  assert.match(decision.headsUp, /at an appointment/);
});

test("every decline-reason kind produces a distinct heads-up fragment for the owner", () => {
  const kinds: Array<["appointment" | "ooo" | "travel" | "meeting", string]> = [
    ["appointment", "Doctor"], ["ooo", "OOO"], ["travel", "Flight to NYC"], ["meeting", "Strategy sync"],
  ];
  const headsUps = kinds.map(([, title]) => {
    const d = decideVipGreeting("Tara", "transfer", { summary: title });
    return d.outcome === "vip_blocked_calendar" ? d.headsUp : "";
  });
  assert.equal(new Set(headsUps).size, 4);
});

test("vipBlocksLiveTransfer is true once a message-only tier or a calendar block decided this call — never ring mid-conversation after that", () => {
  assert.equal(vipBlocksLiveTransfer({ tier: "message_only" }, undefined), true);
  assert.equal(vipBlocksLiveTransfer({ tier: "transfer" }, "meeting"), true);
  assert.equal(vipBlocksLiveTransfer({ tier: "transfer" }, undefined), false);
  assert.equal(vipBlocksLiveTransfer(undefined, undefined), false);
});

test("the VIP take-a-message fallback varies from holdTransfer's returnLine but keeps the same offer", () => {
  const line = vipTakeMessageFallback();
  assert.match(line, new RegExp(`leave ${OWNER_FIRST} a message`));
  assert.match(line, /as soon as they're free/);
  assert.doesNotMatch(line, /can't break away just now/); // that's returnLine()'s wording, not this one
});
