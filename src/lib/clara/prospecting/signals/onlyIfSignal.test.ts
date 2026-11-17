import { test } from "node:test";
import assert from "node:assert/strict";
import { companyHasRecentSignal, type OnlyIfSignalDeps } from "./onlyIfSignal";
import type { SignalRow } from "../osBridge";

const NOW = new Date("2026-10-01T12:00:00Z");
const DAY_MS = 24 * 3600_000;

function row(signalType: string, daysAgo: number): SignalRow {
  return { id: `s_${daysAgo}`, company_id: "co_1", signal_type: signalType, headline: "h", observed_at: new Date(NOW.getTime() - daysAgo * DAY_MS).toISOString() };
}

function deps(rows: SignalRow[]): OnlyIfSignalDeps {
  return { now: () => NOW, signalsList: async () => rows };
}

test("true when a matching signal type is within the window", async () => {
  const d = deps([row("website_change", 2)]);
  assert.equal(await companyHasRecentSignal("co_1", ["website_change"], 7, d), true);
});

test("false when no signal of the requested type(s) exists at all", async () => {
  const d = deps([row("tech_added", 1)]);
  assert.equal(await companyHasRecentSignal("co_1", ["website_change", "review_velocity"], 7, d), false);
});

test("false when a matching signal exists but is OUTSIDE the window", async () => {
  const d = deps([row("website_change", 10)]);
  assert.equal(await companyHasRecentSignal("co_1", ["website_change"], 7, d), false);
});

test("boundary: a signal observed exactly at the window edge counts as within it (>=)", async () => {
  const d = deps([row("website_change", 7)]);
  assert.equal(await companyHasRecentSignal("co_1", ["website_change"], 7, d), true);
});

test("boundary: one millisecond past the window edge does not count", async () => {
  const justOutside: SignalRow = { id: "s_edge", company_id: "co_1", signal_type: "website_change", observed_at: new Date(NOW.getTime() - 7 * DAY_MS - 1).toISOString(), headline: "h" };
  const d = deps([justOutside]);
  assert.equal(await companyHasRecentSignal("co_1", ["website_change"], 7, d), false);
});

test("multiple signal types: matches if ANY one of them is recent", async () => {
  const d = deps([row("tech_added", 1), row("review_velocity", 2)]);
  assert.equal(await companyHasRecentSignal("co_1", ["website_change", "review_velocity"], 7, d), true);
});

test("empty signalTypes list is always false (nothing to gate on)", async () => {
  const d = deps([row("website_change", 1)]);
  assert.equal(await companyHasRecentSignal("co_1", [], 7, d), false);
});

test("empty companyId is always false", async () => {
  const d = deps([row("website_change", 1)]);
  assert.equal(await companyHasRecentSignal("", ["website_change"], 7, d), false);
});

test("a row with an unparseable observed_at is ignored, not a crash", async () => {
  const bad: SignalRow = { id: "s_bad", company_id: "co_1", signal_type: "website_change", observed_at: "not-a-date", headline: "h" };
  const d = deps([bad]);
  assert.equal(await companyHasRecentSignal("co_1", ["website_change"], 7, d), false);
});
