// The brief's "Calls & texts" lines (workLineLog.ts).

import { test } from "node:test";
import assert from "node:assert/strict";
import { callsAndTextsLines, type WorkLineEntry } from "./workLineLog";

const e = (p: Partial<WorkLineEntry>): WorkLineEntry => ({ at: "2026-09-25T14:00:00Z", channel: "call", from: "+18135550100", who: "+18135550100", did: "I took a message.", callback: false, ...p });

test("repeat contact from one person collapses to one line, latest need and action winning", () => {
  const { lines, callbacks } = callsAndTextsLines([
    e({ at: "2026-09-25T13:00:00Z", who: "Jackson (Acme Co)", need: "site down", callback: true }),
    e({ at: "2026-09-25T14:00:00Z", channel: "text", who: "Jackson (Acme Co)", need: "site still down", did: "I told them you'd handle it yourself.", important: true }),
  ]);
  assert.equal(lines.length, 1);
  assert.equal(lines[0], "Jackson (Acme Co) called and texted (2 times) — site still down. I told them you'd handle it yourself. (I told you about this as it happened.)");
  assert.deepEqual(callbacks, ["Jackson (Acme Co) — +18135550100: site still down"]);
});

test("callbacks sort first; a missed call with no message still shows", () => {
  const { lines } = callsAndTextsLines([
    e({ from: "+1", who: "Kim", did: "I replied.", channel: "text", at: "2026-09-25T15:00:00Z" }),
    e({ from: "+18135550199", who: "+18135550199", did: "They hung up before leaving a message.", callback: true }),
  ]);
  assert.match(lines[0], /^\+18135550199 called\. They hung up/);
  assert.match(lines[1], /^Kim texted\. I replied\./);
});

test("no entries, no lines", () => {
  assert.deepEqual(callsAndTextsLines([]), { lines: [], callbacks: [] });
});

test("a resolved entry (the owner's answer relayed) takes them off the callback list", () => {
  const { callbacks } = callsAndTextsLines([
    { at: "2026-09-29T14:00:00Z", channel: "text", from: "+18135550100", who: "Jackson", need: "price for a page", did: "I told them I'd check with you.", callback: true },
    { at: "2026-09-29T14:20:00Z", channel: "text", from: "+18135550100", who: "Jackson", did: "I sent your answer.", callback: false, resolved: true },
  ]);
  assert.deepEqual(callbacks, []);
});
