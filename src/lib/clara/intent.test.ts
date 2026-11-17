// Tests for the owner-ask waiver (delegationForce). Owner rule 2026-09-15: "if I ask an agent to do
// something then there should be no approval needed from me again — I asked for the task", with
// money-adjacent work still confirmed (his choice). Only the owner, only on a live channel.

import { test } from "node:test";
import assert from "node:assert/strict";
import { delegationForce } from "./intent";

const LIVE = ["sms", "voice", "chat", "email"];

test("the owner's own ask over sms/voice/chat/email runs any ordinary tool without an approval row", () => {
  for (const source of LIVE) {
    for (const tool of ["delegate_to_agent", "send_email", "move_event", "cancel_event", "portal_message", "drive_edit", "restart_service"]) {
      assert.equal(delegationForce(tool, { principal: "owner", source }), true, `${tool} over ${source}`);
    }
  }
});

test("money-adjacent work still gets one confirmation, even when the owner asks", () => {
  assert.equal(delegationForce("send_for_signature", { principal: "owner", source: "chat" }), false);
  assert.equal(delegationForce("call_business", { principal: "owner", source: "sms" }, "call.business"), false);
});

test("anyone else, or work nobody asked for, keeps the queue", () => {
  assert.equal(delegationForce("send_email", { principal: "vendor", source: "email" }), false);
  assert.equal(delegationForce("delegate_to_agent", { principal: "vendor", source: "sms" }), false);
  assert.equal(delegationForce("send_email", { principal: "owner", source: "scheduler" }), false);
});

// ── drive_edit payload shaping (2026-09-23 ICP incident) ─────────────────────────────────────────
// The tool used to hand the executor one bare string for every op, which the executor could not
// read, so every Doc edit failed. These pin the flat-args → per-op object mapping.
import { buildDriveEditPayload, pageText } from "./intent";

test("drive_edit builds the executor's object shape per op", () => {
  assert.deepEqual(buildDriveEditPayload({ op: "docs-insert", text: "\n\nNew bullet" }), { op: "docs-insert", payload: { text: "\n\nNew bullet" } });
  assert.deepEqual(
    buildDriveEditPayload({ op: "docs-replace", replacements: [{ find: "Roofers", replace: "Roofing contractors" }] }),
    { op: "docs-replace", payload: { replacements: [{ find: "Roofers", replace: "Roofing contractors" }] } },
  );
  assert.deepEqual(
    buildDriveEditPayload({ op: "sheets-write", range: "Sheet1!A2", values: [["a", 1]] }),
    { op: "sheets-write", payload: { range: "Sheet1!A2", values: [["a", 1]], mode: "overwrite" } },
  );
  assert.deepEqual(buildDriveEditPayload({ op: "drive-replace-content", text: "x" }), { op: "drive-replace-content", payload: { content: "x" } });
  // Unknown op degrades to append (the least destructive op), never to a throw.
  assert.equal(buildDriveEditPayload({ op: "nope", text: "t" }).op, "docs-insert");
});

test("drive_read pages a long file instead of silently cutting it at 2k", () => {
  const full = "a".repeat(30_000);
  const p1 = pageText(full, 0, 12_000);
  assert.equal(p1.text.length, 12_000);
  assert.equal(p1.next, 12_000);
  const p3 = pageText(full, 24_000, 12_000);
  assert.equal(p3.text.length, 6_000);
  assert.equal(p3.next, null);
  assert.equal(pageText("short", 0, 12_000).next, null);
  assert.equal(pageText("short", 99, 12_000).text, "");
});

// ── OS clara.instruction: scheduled runs (2026-10-28) ────────────────────────────────────────────
import { readOnlyBlocks, READ_ONLY_TOOLS, TOOLS } from "./intent";

test("a scheduled run never gets the owner-ask waiver, even with source chat", () => {
  assert.equal(delegationForce("send_email", { principal: "owner", source: "chat", scheduled: { readOnly: false } }), false);
  assert.equal(delegationForce("send_email", { principal: "owner", source: "chat" }), true);
});

test("read-only scheduled runs execute only allowlisted reads", () => {
  const ro = { scheduled: { readOnly: true } };
  assert.equal(readOnlyBlocks("crm_lookup", ro), false);
  for (const t of ["send_email", "draft_email", "sweep_inbox", "move_event", "delegate_to_agent", "whats_waiting_on_me", "add_task"]) {
    assert.equal(readOnlyBlocks(t, ro), true, t);
  }
  assert.equal(readOnlyBlocks("send_email", { scheduled: { readOnly: false } }), false);
  assert.equal(readOnlyBlocks("send_email", {}), false);
});

test("every read-only tool exists in the catalog and none is irreversible", () => {
  const byName = new Map(TOOLS.map((t) => [t.name, t]));
  for (const name of READ_ONLY_TOOLS) {
    assert.ok(byName.has(name), `${name} is not a tool`);
    assert.equal(byName.get(name)!.reversible, true, `${name} is irreversible`);
  }
});
