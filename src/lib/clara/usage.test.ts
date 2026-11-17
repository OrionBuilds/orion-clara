// The owner's calendar day is the bucket for every daily budget — not the UTC day, which rolled
// over at 20:00 EDT and made the job tripwire hold work through the afternoon (2026-09-24).

import { test } from "node:test";
import assert from "node:assert/strict";
import { localDayKey } from "./usage";

test("localDayKey buckets by America/New_York, not UTC", () => {
  // 2026-09-24T02:30Z is still the evening of the 23rd in New York.
  assert.equal(localDayKey(new Date("2026-09-24T02:30:00Z")), "2026-09-23");
  // 2026-09-24T12:00Z is 08:00 on the 24th.
  assert.equal(localDayKey(new Date("2026-09-24T12:00:00Z")), "2026-09-24");
  // 23:59 EDT on the 24th is 03:59Z on the 25th.
  assert.equal(localDayKey(new Date("2026-09-25T03:59:00Z")), "2026-09-24");
  assert.equal(localDayKey(new Date("garbage")), "");
});
