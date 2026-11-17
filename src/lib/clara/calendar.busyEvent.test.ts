// calendar.busyEvent(): the gate that decides whether a transfer-tier VIP rings the owner or gets a
// calendar-aware decline (2026-10-01 owner decision). Must fail OPEN — a slow or erroring Graph
// call must never cost a VIP their transfer.
//
// Graph-shaped fixtures (subject/showAs/isCancelled), matching ms-calendar.ts's RawEvent — NOT
// Google's shape (summary/status/transparency). pickBusyEvent's OUTPUT still has a `.summary`
// field (CalEvent is unchanged externally); only the raw INPUT shape changed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { pickBusyEvent, busyEvent, BUSY_EVENT_TIMEOUT_MS } from "./ms-calendar";

const NOW = "2026-10-01T14:00:00.000Z";

function ev(over: Partial<{ id: string; subject: string; start: string; end: string; showAs: string; isCancelled: boolean }> = {}) {
  return {
    id: over.id ?? "e1",
    subject: over.subject ?? "Client sync",
    start: { dateTime: over.start ?? "2026-10-01T13:30:00.000Z" },
    end: { dateTime: over.end ?? "2026-10-01T14:30:00.000Z" },
    showAs: over.showAs,
    isCancelled: over.isCancelled,
  };
}

test("an overlapping busy event is picked", () => {
  const picked = pickBusyEvent([ev()], NOW);
  assert.equal(picked?.id, "e1");
  assert.equal(picked?.summary, "Client sync");
});

test("Graph's default — no showAs field at all — counts as busy", () => {
  const raw = [{ id: "e2", subject: "No explicit status", start: { dateTime: "2026-10-01T13:00:00.000Z" }, end: { dateTime: "2026-10-01T15:00:00.000Z" } }];
  assert.equal(pickBusyEvent(raw, NOW)?.id, "e2");
});

test("no event at all → null", () => {
  assert.equal(pickBusyEvent([], NOW), null);
});

test("an event that doesn't overlap now (past or future) is not picked", () => {
  assert.equal(pickBusyEvent([ev({ start: "2026-10-01T10:00:00.000Z", end: "2026-10-01T11:00:00.000Z" })], NOW), null);
  assert.equal(pickBusyEvent([ev({ start: "2026-10-01T16:00:00.000Z", end: "2026-10-01T17:00:00.000Z" })], NOW), null);
});

test("a free (showAs: free) event never blocks, even if it overlaps now", () => {
  assert.equal(pickBusyEvent([ev({ showAs: "free" })], NOW), null);
});

test("a tentative (showAs) or cancelled (isCancelled) event never blocks", () => {
  assert.equal(pickBusyEvent([ev({ showAs: "tentative" })], NOW), null);
  assert.equal(pickBusyEvent([ev({ isCancelled: true })], NOW), null);
});

test("the start boundary is inclusive, the end boundary is exclusive", () => {
  assert.equal(pickBusyEvent([ev({ start: NOW, end: "2026-10-01T14:30:00.000Z" })], NOW)?.id, "e1");
  assert.equal(pickBusyEvent([ev({ start: "2026-10-01T13:00:00.000Z", end: NOW })], NOW), null);
});

test("the first matching busy event in the list wins when several overlap", () => {
  const picked = pickBusyEvent([
    ev({ id: "free", showAs: "free" }),
    ev({ id: "busy-1" }),
    ev({ id: "busy-2" }),
  ], NOW);
  assert.equal(picked?.id, "busy-1");
});

test("busyEvent() resolves the picked event through an injected fetch", async () => {
  const picked = await busyEvent(NOW, { fetchEvents: async () => [ev()] });
  assert.equal(picked?.id, "e1");
});

test("busyEvent() fails open (null) when the fetch throws", async () => {
  const picked = await busyEvent(NOW, { fetchEvents: async () => { throw new Error("graph is down"); } });
  assert.equal(picked, null);
});

test("busyEvent() fails open (null) when the fetch is slower than the timeout", async () => {
  const picked = await busyEvent(NOW, {
    timeoutMs: 20,
    fetchEvents: () => new Promise((resolve) => setTimeout(() => resolve([ev()]), 500)),
  });
  assert.equal(picked, null);
});

test("the default timeout is 2 seconds, so a VIP never waits long for the gate", () => {
  assert.equal(BUSY_EVENT_TIMEOUT_MS, 2_000);
});

test("no event found at all (free calendar) resolves null, not an error", async () => {
  const picked = await busyEvent(NOW, { fetchEvents: async () => [] });
  assert.equal(picked, null);
});
