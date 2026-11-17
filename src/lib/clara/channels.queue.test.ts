// Per-call hold queues (channels.deleteQueueByName): finding the one to delete in Twilio's list.
// The list body used to be trimmed to 300 characters before parsing, so nothing ever matched and
// a queue leaked for every connected transfer (found in live testing, 2026-09-29).

import { test } from "node:test";
import assert from "node:assert/strict";
import { queueSidFromList, queuePageSearch } from "./channels";

const list = JSON.stringify({
  queues: [
    { sid: "QU1", friendly_name: "hold-CA111", current_size: 0 },
    { sid: "QU2", friendly_name: "hold-CA222", current_size: 1 },
  ],
  page: 0,
});

test("finds the queue by its exact friendly name, and nothing else", () => {
  assert.equal(queueSidFromList(list, "hold-CA222"), "QU2");
  assert.equal(queueSidFromList(list, "hold-CA22"), null);
  assert.equal(queueSidFromList(list, "hold-CA999"), null);
});

test("a truncated or empty list body is a miss, never a throw", () => {
  assert.equal(queueSidFromList(list.slice(0, 40), "hold-CA111"), null);
  assert.equal(queueSidFromList("", "hold-CA111"), null);
  assert.equal(queueSidFromList("{}", "hold-CA111"), null);
});

test("pagination: the target on a later page is not reported as absent", () => {
  const page1 = JSON.stringify({ queues: [{ sid: "QU1", friendly_name: "hold-CA111" }], next_page_uri: "/2010-04-01/Accounts/AC00/Queues.json?Page=1&PageSize=50" });
  const page2 = JSON.stringify({ queues: [{ sid: "QU9", friendly_name: "hold-CA999" }], next_page_uri: null });
  assert.equal(queuePageSearch(page1, "hold-CA999").sid, null);
  assert.equal(queuePageSearch(page1, "hold-CA999").nextPath, "/Queues.json?Page=1&PageSize=50");
  assert.equal(queuePageSearch(page2, "hold-CA999").sid, "QU9");
  assert.equal(queuePageSearch(page2, "hold-CA999").nextPath, null);
  // A body missing next_page_uri (the last page) says the search is done.
  assert.equal(queuePageSearch(JSON.stringify({ queues: [] }), "hold-CAX").nextPath, null);
});
