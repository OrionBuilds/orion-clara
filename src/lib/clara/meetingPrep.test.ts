// Candidate selection for meeting prep (2026-09-24): only today's timed meetings with at least one
// external attendee, and never one that already has a document.

import { test } from "node:test";
import assert from "node:assert/strict";
import { selectCandidates, externalAttendees, isAllDay } from "./meetingPrep";
import type { CalEvent } from "./ms-calendar";

const ev = (over: Partial<CalEvent>): CalEvent => ({
  id: "e", summary: "Meeting", start: "2026-09-24T14:00:00-04:00", end: "2026-09-24T14:30:00-04:00",
  attendees: ["jordan@example.com", "eric@globex.example"], calendarOwner: "work", ...over,
});
const HOME = "example.com";
const opts = (already: string[] = []) => ({ date: "2026-09-24", alreadyPrepared: new Set(already), homeDomain: HOME });

test("external attendees exclude the business domain and its subdomains", () => {
  assert.deepEqual(externalAttendees(["jordan@example.com", "bot@mail.example.com", "eric@globex.example"], HOME), ["eric@globex.example"]);
  assert.deepEqual(externalAttendees(undefined, HOME), []);
});

test("all-day events are detected by date-only starts or ≥23h spans", () => {
  assert.equal(isAllDay({ start: "2026-09-24", end: "2026-09-25" }), true);
  assert.equal(isAllDay({ start: "2026-09-24T00:00:00-04:00", end: "2026-09-25T00:00:00-04:00" }), true);
  assert.equal(isAllDay({ start: "2026-09-24T14:00:00-04:00", end: "2026-09-24T15:00:00-04:00" }), false);
});

test("selectCandidates keeps today's external timed meetings that are not already prepared", () => {
  const events = [
    ev({ id: "a" }),                                                         // keep
    ev({ id: "b", attendees: ["jordan@example.com", "clara@example.com"] }), // internal → skip
    ev({ id: "c", start: "2026-09-24", end: "2026-09-25" }),                 // all-day → skip
    ev({ id: "d", start: "2026-09-25T14:00:00-04:00", end: "2026-09-25T14:30:00-04:00" }), // tomorrow → skip
    ev({ id: "e" }),                                                         // already prepared → skip
    ev({ id: "f", attendees: [] }),                                          // no attendees → skip
  ];
  assert.deepEqual(selectCandidates(events, opts(["e"])).map((e) => e.id), ["a"]);
});
