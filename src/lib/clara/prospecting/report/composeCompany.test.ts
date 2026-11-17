import { test } from "node:test";
import assert from "node:assert/strict";
import {
  composeSummarySection, composeTimelineSection, composeFactsSection, composePeopleSection,
  composeTechSection, composeSignalsSection, composeCallBriefSection, composeCompanyResearchDoc,
} from "./composeCompany";
import type { CompanyFullRow } from "../osBridge";

test("composeSummarySection: includes name, location, fit score, rating, revenue", () => {
  const lines = composeSummarySection({ name: "Acme Roofing", city: "Tampa", state: "FL", fit_score: 85, rating: 4.5, review_count: 120, revenue_low: 1_000_000, revenue_high: 2_000_000 });
  assert.match(lines[0], /Acme Roofing — Tampa, FL/);
  assert.ok(lines.some((l) => l.includes("Fit score: 85")));
  assert.ok(lines.some((l) => l.includes("4.5★")));
  assert.ok(lines.some((l) => l.includes("$1,000,000")));
});

test("composeTimelineSection: empty timeline has a placeholder, non-empty is newest-first as given, capped at 20", () => {
  assert.deepEqual(composeTimelineSection([]), ["(no timeline events yet)"]);
  const rows = Array.from({ length: 25 }, (_, i) => ({ event_type: "signal", summary: `s${i}`, occurred_at: "2026-01-01T00:00:00Z" }));
  const lines = composeTimelineSection(rows);
  assert.equal(lines.length, 20);
});

test("composeFactsSection: sorts by confidence descending, caps at 15", () => {
  const facts = [
    { id: "1", field_name: "owner", value: "Jane", confidence: 0.4 },
    { id: "2", field_name: "year_founded", value: 2004, confidence: 0.9 },
  ];
  const lines = composeFactsSection(facts);
  assert.ok(lines[0].startsWith("- year_founded"));
});

test("composePeopleSection: shows title + best email + best phone per person", () => {
  const people = [{ id: "p1", full_name: "Jane Smith", title: "Owner" }];
  const methods = [
    { person_id: "p1", kind: "email", value: "jane@acme.com", verification_status: "verified" },
    { person_id: "p1", kind: "mobile", value: "+18135551234" },
  ];
  const lines = composePeopleSection(people, methods);
  assert.match(lines[0], /Jane Smith — Owner · jane@acme\.com \(verified\) · \+18135551234 \(mobile\)/);
});
test("composePeopleSection: no people is a clean placeholder", () => {
  assert.deepEqual(composePeopleSection([], []), ["(no decision maker identified yet)"]);
});

test("composeTechSection / composeSignalsSection: list rows or a placeholder when empty", () => {
  assert.deepEqual(composeTechSection([]), ["(no technology detected yet)"]);
  assert.deepEqual(composeTechSection([{ category: "crm", name: "GoHighLevel" }]), ["- crm: GoHighLevel"]);
  assert.deepEqual(composeSignalsSection([]), ["(no buying signals yet)"]);
});

test("composeCallBriefSection: renders opener, talking points, objections; placeholder when absent", () => {
  assert.deepEqual(composeCallBriefSection(undefined), ["(call brief unavailable)"]);
  const lines = composeCallBriefSection({ opener: "Hi Jane", talkingPoints: ["point A"], objections: [{ objection: "too busy", response: "15 min, your time" }] });
  assert.equal(lines[0], "Opener: Hi Jane");
  assert.ok(lines.some((l) => l.includes("point A")));
  assert.ok(lines.some((l) => l.includes("too busy") && l.includes("15 min")));
});

test("composeCompanyResearchDoc: assembles every section in the plan's stated order with the title", () => {
  const full: CompanyFullRow = {
    company: { name: "Acme Roofing", city: "Tampa", state: "FL", fit_score: 85 },
    people: [], contact_methods: [], technologies: [], facts: [], signals: [], enrollments: [],
  };
  const doc = composeCompanyResearchDoc(full, [], undefined, "2026-10-01");
  assert.match(doc, /^Research — Acme Roofing — 2026-10-01/);
  const order = ["## Summary", "## Timeline", "## Top facts", "## People", "## Tech stack", "## Signals", "## Call brief"];
  let lastIndex = -1;
  for (const heading of order) {
    const idx = doc.indexOf(heading);
    assert.ok(idx > lastIndex, `${heading} should appear after the previous section`);
    lastIndex = idx;
  }
});
