// The end-of-call learned-patch normalization. Root cause of the blank-need finalize on live call
// CAa54e3b5a2c63c83b91dc09f3943a74bf (2026-09-29): a callback framing let the model return without
// `need`, and there was no fallback to the caller's own words.

import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeLearnedPatch } from "./inbound-call-brain";

const firstCaller =
  "Hi, I saw your website and I have a question about automation for my roofing company. Can someone call me back?";

test("empty-string values are dropped, non-empty values are kept and trimmed", () => {
  const p = normalizeLearnedPatch(
    { callerName: "  Jackson  ", company: "Bronco Box", need: "", callback: "  ", timeline: "" },
    { hangup: false },
  );
  assert.deepEqual(p, { callerName: "Jackson", company: "Bronco Box" });
});

test("non-string values are ignored (never assigned)", () => {
  const p = normalizeLearnedPatch(
    { callerName: "Jackson", callback: null as unknown as string, need: 42 as unknown as string },
    { hangup: false },
  );
  assert.deepEqual(p, { callerName: "Jackson" });
});

test("a null/undefined patch is safe — returns an empty object", () => {
  assert.deepEqual(normalizeLearnedPatch(undefined, { hangup: false }), {});
  assert.deepEqual(normalizeLearnedPatch(null, { hangup: true, firstCallerText: "" }), {});
});

test("on hangup, missing/empty need falls back to the caller's first words (trimmed to 120)", () => {
  const p = normalizeLearnedPatch(
    { callerName: "Jackson", company: "Bronco Box", need: "" },
    { hangup: true, existingNeed: "", firstCallerText: firstCaller },
  );
  assert.equal(
    p.need,
    firstCaller.slice(0, 120),
    "fallback should be the caller's own opener, capped at 120 chars",
  );
  assert.ok(p.need!.length <= 120);
  assert.equal(p.callerName, "Jackson");
});

test("on hangup, a non-empty need in the patch is used verbatim (no fallback)", () => {
  const p = normalizeLearnedPatch(
    { need: "Their site is down and they need the owner today" },
    { hangup: true, firstCallerText: firstCaller },
  );
  assert.equal(p.need, "Their site is down and they need the owner today");
});

test("on hangup, an existing need on the state means no fallback", () => {
  const p = normalizeLearnedPatch(
    { callerName: "Jackson" },
    { hangup: true, existingNeed: "already captured", firstCallerText: firstCaller },
  );
  assert.equal(p.need, undefined, "should not overwrite what the state already had");
});

test("not the last turn — no fallback even when need is empty", () => {
  const p = normalizeLearnedPatch(
    { callerName: "Jackson", need: "" },
    { hangup: false, firstCallerText: firstCaller },
  );
  assert.equal(p.need, undefined);
});

test("hangup with no caller text at all leaves need unset (nothing to fall back to)", () => {
  const p = normalizeLearnedPatch(
    { callerName: "Jackson" },
    { hangup: true, firstCallerText: "   " },
  );
  assert.equal(p.need, undefined);
});
