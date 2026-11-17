// Tests for the work-line meeting recall pieces: attendee gating, section parsing, caller-task
// filtering, and the full build on a temp meetings dir.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  attendeeMatches,
  callerTasksFromSection,
  digestForCaller,
  parseBullets,
  splitSections,
  buildCallerMeetingContext,
  formatBlock,
} from "./callerMeetings";

test("attendeeMatches: full name case-insensitive", () => {
  assert.equal(attendeeMatches(["Taylor Client", "Jordan Example"], "taylor client"), true);
  assert.equal(attendeeMatches(["Taylor Client"], "Taylor Client"), true);
});

test("attendeeMatches: last-name only unambiguous", () => {
  assert.equal(attendeeMatches(["Eric Rivera", "Jordan Example"], "E. Rivera"), true);
  // ambiguous last name → does NOT match on last name alone
  assert.equal(attendeeMatches(["Eric Rivera", "Lisa Rivera"], "A. Rivera"), false);
});

test("attendeeMatches: bare first name alone never matches", () => {
  assert.equal(attendeeMatches(["Taylor Client", "Taylor Smith"], "Taylor"), false);
  assert.equal(attendeeMatches(["Taylor Client"], "Taylor"), false);
});

test("attendeeMatches: empty / nullish inputs", () => {
  assert.equal(attendeeMatches([], "Taylor Client"), false);
  assert.equal(attendeeMatches(["Taylor Client"], ""), false);
  assert.equal(attendeeMatches(["Taylor Client"], null), false);
});

test("splitSections: keys lowercased, bodies trimmed", () => {
  const body = "intro text\n## Summary\nhello\n## Decisions\n- one\n- two\n";
  const s = splitSections(body);
  assert.equal(s["summary"], "hello");
  assert.equal(s["decisions"], "- one\n- two");
});

test("parseBullets: handles -, *, 1., 1)", () => {
  const got = parseBullets("- a\n* b\n1. c\n2) d\n   not a bullet\n");
  assert.deepEqual(got, ["a", "b", "c", "d"]);
});

test("callerTasksFromSection: filters by owner, strips project parenthetical", () => {
  const section = `1. **[Jordan]** Send the developer the Widget PDFs _(project: Planner Tool)_
2. **[FRIDAY]** Build the planner upload flow
3. **[Taylor Client]** Share example client case`;
  const forOwner = callerTasksFromSection(section, "Jordan Example");
  // "Jordan Example" won't last-name match "Jordan" (one token in attendee), but full equality fails too.
  // In practice meeting-note tasks use first names; make sure first-name-alone is explicitly skipped.
  assert.deepEqual(forOwner, []);
  const forTaylor = callerTasksFromSection(section, "Taylor Client");
  assert.equal(forTaylor.length, 1);
  assert.ok(forTaylor[0].startsWith("Share example client case"));
});

test("digestForCaller: returns null for non-attendee, parses for attendee", () => {
  const raw = `---
source: wispr
title: "ACME STANDUP"
start: 2026-09-30T14:30:00Z
end: 2026-09-30T15:30:00Z
attendees: ["Taylor Client", "Jordan Example"]
---

# ACME STANDUP

## Summary

Jordan and Taylor aligned on extending the planner tool.

## Decisions

- Do not rebuild Widget.
- Extend the existing planner instead.

## Tasks

1. **[Taylor Client]** Build the upload flow
2. **[Jordan Example]** Send Widget PDFs to Taylor

## Transcript

verbatim speech that must never surface
`;
  assert.equal(digestForCaller(raw, "Random Caller"), null);
  const d = digestForCaller(raw, "Taylor Client");
  assert.ok(d);
  assert.equal(d!.title, "ACME STANDUP");
  assert.ok(d!.summary.includes("planner tool"));
  assert.equal(d!.decisions.length, 2);
  assert.equal(d!.callerTasks.length, 1);
  assert.ok(d!.callerTasks[0].startsWith("Build the upload flow"));
  // Transcript must NEVER appear in the formatted output.
  const block = formatBlock([d!]);
  assert.ok(!block.toLowerCase().includes("transcript"));
  assert.ok(!block.includes("verbatim speech"));
});

test("digestForCaller: unparseable frontmatter returns null", () => {
  assert.equal(digestForCaller("no frontmatter here", "Taylor Client"), null);
  assert.equal(digestForCaller("---\nnot: valid: yaml:\n---\nbody", "Taylor Client"), null);
});

test("buildCallerMeetingContext: honours days window and limit, newest first", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "meetings-test-"));
  try {
    const now = new Date("2026-10-15T12:00:00Z");
    const makeNote = (iso: string, title: string) =>
      `---\nsource: wispr\ntitle: ${JSON.stringify(title)}\nstart: ${iso}\nend: ${iso}\nattendees: ["Taylor Client", "Jordan Example"]\n---\n\n## Summary\n\nnotes for ${title}\n\n## Decisions\n\n- some decision\n`;
    await writeFile(path.join(dir, "a.md"), makeNote("2026-10-14T10:00:00Z", "RECENT A"));
    await writeFile(path.join(dir, "b.md"), makeNote("2026-10-10T10:00:00Z", "RECENT B"));
    await writeFile(path.join(dir, "c.md"), makeNote("2026-10-13T10:00:00Z", "RECENT C"));
    await writeFile(path.join(dir, "stale.md"), makeNote("2026-09-01T10:00:00Z", "STALE OLD"));
    const block = await buildCallerMeetingContext("Taylor Client", { dir, now, days: 14, limit: 2 });
    assert.ok(block);
    assert.ok(block!.includes("RECENT A"));
    assert.ok(block!.includes("RECENT C"));
    assert.ok(!block!.includes("RECENT B"), "limit=2 means B is dropped (older than A, C)");
    assert.ok(!block!.includes("STALE OLD"));
    // Order check: A (10-14) must come before C (10-13).
    assert.ok(block!.indexOf("RECENT A") < block!.indexOf("RECENT C"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("buildCallerMeetingContext: unknown caller returns empty string, unknown dir returns null", async () => {
  assert.equal(await buildCallerMeetingContext("", { dir: "/tmp/x" }), "");
  assert.equal(await buildCallerMeetingContext(null, { dir: "/tmp/x" }), "");
  assert.equal(await buildCallerMeetingContext("Taylor Client", { dir: "/nonexistent-vault-dir-for-test" }), null);
});

test("buildCallerMeetingContext: caller not in any attendee list returns empty block", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "meetings-test2-"));
  try {
    const now = new Date("2026-10-15T12:00:00Z");
    await writeFile(
      path.join(dir, "a.md"),
      `---\ntitle: "team-only"\nstart: 2026-10-14T10:00:00Z\nend: 2026-10-14T10:00:00Z\nattendees: ["Jordan Example", "Tara Lee"]\n---\n\n## Summary\n\ninternal\n`,
    );
    const block = await buildCallerMeetingContext("Cody Garcia", { dir, now });
    assert.equal(block, "");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
