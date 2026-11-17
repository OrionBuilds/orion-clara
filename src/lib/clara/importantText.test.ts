// Important texts to the owner (importantText.ts): one per contact per matter, nothing overnight unless
// it's an emergency.

import { test } from "node:test";
import assert from "node:assert/strict";
import { decideImportantText, importantKey, inImportantQuietHours, IMPORTANT_DEDUPE_MS } from "./importantText";

const NOON_NY = new Date("2026-09-25T16:00:00Z"); // 12:00 EDT
const LATE_NY = new Date("2026-09-26T02:30:00Z"); // 22:30 EDT
const EARLY_NY = new Date("2026-09-26T10:59:00Z"); // 06:59 EDT
const SEVEN_NY = new Date("2026-09-26T11:00:00Z"); // 07:00 EDT

test("the key is per contact and per matter, formatting-proof", () => {
  assert.equal(importantKey("+1 (813) 555-0100", "Site is DOWN"), importantKey("8135550100", "site is down"));
  assert.notEqual(importantKey("8135550100", "site is down"), importantKey("8135550100", "invoice question"));
  assert.notEqual(importantKey("8135550100", "site is down"), importantKey("8135550101", "site is down"));
});

test("a matter already texted is not texted again inside the window", () => {
  const key = importantKey("8135550100", "site down");
  const sent = { [key]: NOON_NY.getTime() - 60_000 };
  assert.equal(decideImportantText({ key, now: NOON_NY, sent }), "duplicate");
  const later = new Date(NOON_NY.getTime() + 2 * IMPORTANT_DEDUPE_MS); // noon the next day
  assert.equal(decideImportantText({ key, now: later, sent }), "send");
});

test("quiet hours are 21:00 to 07:00 New York time", () => {
  assert.equal(inImportantQuietHours(NOON_NY), false);
  assert.equal(inImportantQuietHours(LATE_NY), true);
  assert.equal(inImportantQuietHours(EARLY_NY), true);
  assert.equal(inImportantQuietHours(SEVEN_NY), false);
});

test("quiet hours hold ordinary matters but not emergencies", () => {
  const key = importantKey("8135550100", "x");
  assert.equal(decideImportantText({ key, now: LATE_NY, sent: {} }), "quiet-hours");
  assert.equal(decideImportantText({ key, now: LATE_NY, sent: {}, emergency: true }), "send");
});
