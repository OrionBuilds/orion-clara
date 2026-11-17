// updateInboundLearned / updateLearned must never let a later blank turn wipe an earlier good
// value — a latent hazard that would have shipped as: LLM returns `{need:""}` on a wrap-up turn
// after an earlier turn captured a real need, and Object.assign would clobber it. Same shape on
// the outbound path.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createInboundSession,
  updateInboundLearned,
  getInboundSession,
  createSession,
  updateLearned,
  getSession,
} from "./call-sessions";

test("updateInboundLearned: an empty string keeps the existing value", () => {
  const sid = `CAtest-inbound-${Date.now()}-${Math.random()}`;
  createInboundSession(sid, "+15555550100");
  updateInboundLearned(sid, { need: "Their site is down", callerName: "Jackson" });
  updateInboundLearned(sid, { need: "", callback: "  " }); // wrap-up turn with blanks
  const s = getInboundSession(sid)!;
  assert.equal(s.learned.need, "Their site is down", "empty need must not overwrite");
  assert.equal(s.learned.callerName, "Jackson");
  assert.equal(s.learned.callback, undefined, "empty callback must not be stored");
});

test("updateInboundLearned: a non-empty value replaces the old one", () => {
  const sid = `CAtest-inbound-replace-${Date.now()}`;
  createInboundSession(sid, "+15555550101");
  updateInboundLearned(sid, { need: "old need" });
  updateInboundLearned(sid, { need: "sharper need after another turn" });
  assert.equal(getInboundSession(sid)!.learned.need, "sharper need after another turn");
});

test("updateInboundLearned: non-string values are ignored", () => {
  const sid = `CAtest-inbound-types-${Date.now()}`;
  createInboundSession(sid, "+15555550102");
  // A model that returns bad types must not throw or store garbage.
  updateInboundLearned(sid, { need: null as unknown as string, callerName: 42 as unknown as string });
  const s = getInboundSession(sid)!;
  assert.equal(s.learned.need, undefined);
  assert.equal(s.learned.callerName, undefined);
});

test("updateLearned (outbound): same guard — empty string keeps the old value", () => {
  const sid = `CAtest-outbound-${Date.now()}`;
  createSession(sid, {
    businessName: "Test Co",
    phoneE164: "+15555550200",
    goal: "test call",
    mustConfirm: [],
    requestor: "owner",
  });
  updateLearned(sid, { need: "captured earlier" });
  updateLearned(sid, { need: "" });
  assert.equal(getSession(sid)!.learned.need, "captured earlier");
});
