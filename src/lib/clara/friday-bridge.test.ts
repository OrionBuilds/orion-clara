// Tests for how a FRIDAY endpoint's answer is read: task ids are the receipt; a bare {ok:true}
// (the old memory/log fallback) is not a delegation.

import { test } from "node:test";
import assert from "node:assert/strict";
import { interpretFridayResponse } from "./friday-bridge";

test("chat answer with tasks yields the reply and the task ids", () => {
  const r = interpretFridayResponse({ reply: "On it", tasks: [{ id: "t-1" }, "t-2"], runs: [{ id: "r-1" }] }, "/api/friday/chat");
  assert.deepEqual(r, { reply: "On it", audio: undefined, taskIds: ["t-1", "t-2"], runId: "r-1" });
});

test("router-handled answer has a reply and no receipt", () => {
  const r = interpretFridayResponse({ reply: "Done inline", tasks: [] }, "/api/friday/chat");
  assert.deepEqual(r?.taskIds, []);
});

test("a bare {ok:true} is not an answer", () => {
  assert.equal(interpretFridayResponse({ ok: true }, "/api/memory/log"), null);
  assert.equal(interpretFridayResponse({}, "/x"), null);
});

test("content blocks and text fields still read", () => {
  assert.equal(interpretFridayResponse({ content: [{ text: "a" }, "b"] }, "/x")?.reply, "a b");
  assert.equal(interpretFridayResponse({ text: "t" }, "/x")?.reply, "t");
});
