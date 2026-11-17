// Work-phone texts (workLineTexts.ts): the money/contract/scope guardrail, the lines that must name
// Clara, and the handler's early exits — the owner's own reply standing Clara down, groups ignored.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "clara-workline-"));
process.env.CLARA_CONFIG = path.join(tmp, "clara.config.json");
await fs.writeFile(process.env.CLARA_CONFIG, JSON.stringify({ dataDir: tmp, vaultRoot: tmp }), "utf8");
process.env.CLARA_MEMORY_ROOT = path.join(tmp, "Memory");

const { mustEscalate, finalReply, handleRelayEvent, importantTextBody, HOLDING_LINE } = await import("./workLineTexts");
const { readRelayState, STAND_DOWN_MS } = await import("./bluebubbles");

test("money, contracts and scope always escalate", () => {
  assert.equal(mustEscalate("how much would it cost to add a login page?"), true);
  assert.equal(mustEscalate("can you send over the contract"), true);
  assert.equal(mustEscalate("did the invoice go out"), true);
  assert.equal(mustEscalate("running 10 minutes late"), false);
});

test("the guardrail overrides whatever the model wrote", () => {
  const r = finalReply({ reply: "Sure, that's $500!" }, "what's the price for a new page");
  assert.equal(r.escalated, true);
  assert.doesNotMatch(r.text, /\$500/);
  assert.equal(r.askOwner, true);
  assert.match(r.text, /let me check with them and get right back to you/i);
  assert.doesNotMatch(r.text, /handle it (him|your)self/);
});

test("the holding line names Clara — from the owner's own number, \"let me check with the owner\" would read as the owner", () => {
  assert.match(HOLDING_LINE, /I'm Clara, .+'s assistant/);
  // The send path signs everything else (bluebubbles.signAsClara); finalReply itself adds nothing.
  assert.equal(finalReply({ reply: "Got it, I'll let him know." }, "running late").text, "Got it, I'll let him know.");
});

test("no usable answer means a holding line and asking the owner, never a made-up reply", () => {
  const r = finalReply({ reply: "" }, "hello");
  assert.equal(r.askOwner, true);
  assert.match(r.text, /let me check with them and get right back to you/i);
  assert.equal(finalReply({ reply: "Sure, I'll let him know.", wantsOwner: true }, "can you have him call me").askOwner, true);
  assert.equal(finalReply({ reply: "Running late is fine — he'll see you at 3." }, "running late").askOwner, false);
});

test("the owner's own send in a thread stands Clara down there", async () => {
  const before = Date.now();
  const r = await handleRelayEvent({
    type: "new-message",
    data: { guid: "m1", text: "Calling you in 5", isFromMe: true, handle: null, chats: [{ guid: "SMS;-;+18135550100", style: 45 }] },
  });
  assert.match(r, /standing down/);
  const t = (await readRelayState()).threads["SMS;-;+18135550100"];
  assert.ok(t.standDownUntil && t.standDownUntil >= before + STAND_DOWN_MS);
});

test("group chats and non-message events end before any lookup or reply", async () => {
  assert.equal(await handleRelayEvent({ type: "new-message", data: { guid: "g", text: "lunch?", isFromMe: false, handle: { address: "+18135550100" }, chats: [{ guid: "iMessage;+;chat1", style: 43 }] } }), "ignored: group");
  assert.equal(await handleRelayEvent({ type: "chat-read-status-changed", data: {} }), "not a new message");
});

test("the owner is never told the sender heard back unless the reply went out", () => {
  const sent = importantTextBody("Jackson", "+18135550100", "the invoice", true, "sent");
  assert.match(sent, /I told them you'd get back to them\./);
  const failed = importantTextBody("Jackson", "+18135550100", "the invoice", true, "failed");
  assert.match(failed, /couldn't send them a reply, so they haven't heard back yet/);
  assert.doesNotMatch(failed, /told them/);
  const unknown = importantTextBody("Jackson", "+18135550100", "the invoice", true, "unknown");
  assert.match(unknown, /couldn't confirm it went out/);
  assert.match(importantTextBody("Kim", "+1", "site down", false, "sent"), /looks urgent: site down/);
});
