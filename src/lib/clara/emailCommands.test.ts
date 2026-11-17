// Tests for the owner email channel's pure checks and its summary line.

import { test } from "node:test";
import assert from "node:assert/strict";
import { dmarcPassed, stripQuoted, senderAddress, summarizeEmailCommands } from "./emailCommands";

const H = (o: Record<string, string>) => new Map(Object.entries(o).map(([k, v]) => [k.toLowerCase(), v]));

test("dmarcPassed only on an explicit pass", () => {
  assert.equal(dmarcPassed(H({ "Authentication-Results": "mx.google.com; dkim=pass; spf=pass; dmarc=pass (p=NONE)" })), true);
  assert.equal(dmarcPassed(H({ "Authentication-Results": "mx.google.com; dmarc=fail" })), false);
  assert.equal(dmarcPassed(H({ "Authentication-Results": "mx.google.com; dmarc=none" })), false);
  assert.equal(dmarcPassed(H({})), false);
});

test("stripQuoted keeps only the new text", () => {
  assert.equal(stripQuoted("Do the thing\n\nOn Mon, Sep 14, Clara wrote:\n> old"), "Do the thing");
});

test("senderAddress", () => {
  assert.equal(senderAddress("Jordan Example <JORDAN@Example.com>"), "jordan@example.com");
});

test("summary mentions skipped own notifications", () => {
  const s = summarizeEmailCommands({ scanned: 10, handled: 0, refused: [], failed: 0, skippedOwn: 2 });
  assert.match(s, /2 own notification\(s\) skipped/);
  assert.doesNotMatch(summarizeEmailCommands({ scanned: 1, handled: 1, refused: [], failed: 0, skippedOwn: 0 }), /own notification/);
});

test("summary mentions previously refused ids skipped", () => {
  const s = summarizeEmailCommands({ scanned: 3, handled: 0, refused: [], failed: 0, skippedOwn: 0, skippedRefused: 2 });
  assert.match(s, /2 previously refused skipped/);
});
