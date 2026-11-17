// Calendar-aware VIP decline phrasing (workLine.ts, 2026-10-01 owner decision): four safe, keyword
// based buckets for why the owner's unavailable — never the event title, attendees, emails or locations.

import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyEventReason, declineReason, vipCalendarDeclineLine, vipBlockedWhyPhrase, VIP_BUSY_MESSAGE_PROMPT } from "./workLine";
import { OWNER_FIRST } from "./owner";

test("doctor/dentist/appointment → appointment, case-insensitive", () => {
  for (const title of ["Doctor appointment", "DENTIST", "Annual appointment", "Doctor Smith follow-up"]) {
    assert.equal(classifyEventReason(title), "appointment", title);
  }
});

test("ooo/out of office/pto → ooo", () => {
  for (const title of ["OOO", "Out of Office - the owner", "PTO", "pto day"]) {
    assert.equal(classifyEventReason(title), "ooo", title);
  }
});

test("travel/flight/driving → travel", () => {
  for (const title of ["Travel to Tampa", "Flight AA123", "Driving to site visit"]) {
    assert.equal(classifyEventReason(title), "travel", title);
  }
});

test("anything else, including a client name or blank title, → meeting (the safe default)", () => {
  for (const title of ["Sync with Acme Co", "1:1 with Jackson", "", undefined, "Board review"]) {
    assert.equal(classifyEventReason(title), "meeting", String(title));
  }
});

test("first match wins when a title could plausibly hit more than one bucket", () => {
  // "doctor" is checked before "travel" — order matches the owner's listed priority.
  assert.equal(classifyEventReason("Doctor appointment before travel to the airport"), "appointment");
});

test("declineReason never echoes the event title, attendees, or any other detail — just one of four lines", () => {
  assert.equal(declineReason({ summary: "Dentist — Dr. Vance, 123 Main St" }), `${OWNER_FIRST}'s at an appointment right now`);
  assert.equal(declineReason({ summary: "OOO" }), `${OWNER_FIRST}'s out of the office today`);
  assert.equal(declineReason({ summary: "Flight to Chicago for the Acme deal" }), `${OWNER_FIRST}'s traveling right now`);
  assert.equal(declineReason({ summary: "1:1 with eric@acme.example" }), `${OWNER_FIRST}'s in a meeting right now`);
  assert.equal(declineReason(null), `${OWNER_FIRST}'s in a meeting right now`);
  assert.equal(declineReason(undefined), `${OWNER_FIRST}'s in a meeting right now`);
  // "traveling" is one of the four safe output words itself — only check for the banned, SPECIFIC
  // details: the raw keywords/titles, emails, and digit strings (phone numbers, addresses).
  for (const r of [
    declineReason({ summary: "Dentist" }), declineReason({ summary: "OOO" }),
    declineReason({ summary: "Travel" }), declineReason({ summary: "Anything" }),
  ]) {
    assert.doesNotMatch(r, /dentist|\bOOO\b|\bpto\b|dr\.|@|\d{3}/i);
  }
});

test("the spoken decline line pairs the reason with one consistent take-a-message offer", () => {
  const line = vipCalendarDeclineLine({ summary: "Doctor" });
  assert.equal(line, `${OWNER_FIRST}'s at an appointment right now. ${VIP_BUSY_MESSAGE_PROMPT}`);
  assert.match(vipCalendarDeclineLine({ summary: "Board sync" }), /meeting right now\. Can I take a message/);
});

test("vipBlockedWhyPhrase gives the owner's own notification a short, still-vague fragment", () => {
  assert.equal(vipBlockedWhyPhrase("appointment"), "at an appointment");
  assert.equal(vipBlockedWhyPhrase("ooo"), "out of the office");
  assert.equal(vipBlockedWhyPhrase("travel"), "traveling");
  assert.equal(vipBlockedWhyPhrase("meeting"), "in a meeting");
});
