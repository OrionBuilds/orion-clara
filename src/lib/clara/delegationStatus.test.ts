// Tests for the bench-state mapper and the client-safe scrub.

import { test } from "node:test";
import assert from "node:assert/strict";
import { fridayState, clientSafeBlock, sanitizeForClient, completionMessage } from "./delegationStatus";

const RESULT = "Checked the repo.\nVERDICT: FAIL on src/lib/x.ts:12\n\n## CLIENT SUMMARY\nThe contact form now submits correctly and you'll get an email for each lead.";

test("FRIDAY: done with a CLIENT SUMMARY block yields client text, internal candor stripped", () => {
  const s = fridayState([{ status: "done", result: RESULT, summary: "fixed form" }]);
  assert.equal(s.state, "done");
  assert.match(s.clientText ?? "", /contact form now submits/);
  assert.doesNotMatch(s.clientText ?? "", /VERDICT|src\/lib/);
});

test("FRIDAY: done without the block has no client text", () => {
  const s = fridayState([{ status: "done", result: "did stuff" }]);
  assert.equal(s.state, "done"); assert.equal(s.clientText, undefined);
});

test("FRIDAY: statuses map to parked / failed / pending; no runs is pending", () => {
  assert.equal(fridayState([{ status: "awaiting_approval" }]).state, "parked");
  assert.equal(fridayState([{ status: "error", error: "boom" }]).internal, "boom");
  assert.equal(fridayState([{ status: "cancelled" }]).state, "failed");
  assert.equal(fridayState([{ status: "running" }]).state, "pending");
  assert.equal(fridayState([]).state, "pending");
});


test("clientSafeBlock tolerates marker variants and rejects a too-short block", () => {
  assert.match(clientSafeBlock("a\n**Client Summary:**\nAll good, live now.") ?? "", /All good/);
  assert.equal(clientSafeBlock("a\n## CLIENT SUMMARY\nok"), null);
  assert.equal(clientSafeBlock("no marker here"), null);
});

test("sanitizeForClient strips paths, file refs, loopback URLs, verdicts and code fences, and caps", () => {
  const dirty = "Fixed it in /home/user/app/src/lib/x.ts:12 and lib/y.tsx.\nSee http://127.0.0.1:3737/api/x\nVERDICT: FAIL\n```\ncode\n```\nDone.";
  const clean = sanitizeForClient(dirty);
  assert.doesNotMatch(clean, /\/home\/|x\.ts|y\.tsx|127\.0\.0\.1|VERDICT|code/);
  assert.match(clean, /Fixed it in [\s\S]*Done\./);
  assert.equal(sanitizeForClient("a".repeat(2000), 100).length, 100);
});

test("completionMessage uses the first name and falls back to the generic note", () => {
  const m = completionMessage("Casey Vendor", "landing page fix", undefined, "Jordan", "Acme Co");
  assert.match(m, /^Hi Casey,/); assert.match(m, /Jordan will follow up/); assert.match(m, /— Clara, Acme Co$/);
  assert.match(completionMessage("", "x", "It is live.", "Jordan"), /Hi there,[\s\S]*It is live\./);
});
