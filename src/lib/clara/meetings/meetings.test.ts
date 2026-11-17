// Tests for the meeting digester's pure pieces: dedupe keys, digest parsing, the agent preamble,
// Wispr transcript chunk handling, and the shadow vault note.

import { test } from "node:test";
import assert from "node:assert/strict";
import { fuzzyKey, isDuplicate, normaliseTitle, type SeenEntry } from "./seen";
import { parseDigest, MAX_ITEMS } from "./digest";
import { buildPreamble, buildNotifyText, renderNote, notePathFor, type ResolvedItem } from "./file";
import { stripMarkers, nextOffset } from "./wispr";
import { meetTitle, parseMeetName } from "./meet";
import { ignoredReason } from "./ingest";
import type { MeetingDigest, MeetingRecord } from "./types";

const T0 = "2026-09-12T15:00:00.000Z";
const plus = (min: number) => new Date(new Date(T0).getTime() + min * 60_000).toISOString();
const entry = (over: Partial<SeenEntry>): SeenEntry => ({
  sourceKey: "wispr:abc", fuzzyKey: "title:acme kickoff", startedAt: T0, source: "wispr", digestedAt: T0, ...over,
});

// ── seen.ts ──
test("fuzzyKey: suffixes normalise away; calendarEventId wins", () => {
  assert.equal(normaliseTitle("Acme Kickoff - Notes by Gemini"), "acme kickoff");
  assert.equal(fuzzyKey({ title: "Acme Kickoff – Transcript" }), "title:acme kickoff");
  assert.equal(fuzzyKey({ title: "Acme Kickoff", calendarEventId: "evt123" }), "cal:evt123");
  assert.equal(meetTitle("Acme Kickoff - Notes by Gemini"), "Acme Kickoff");
});

test("isDuplicate: same title 7 min apart from another source is a dup", () => {
  const rec = { source: "meet" as const, sourceId: "doc1", title: "Acme Kickoff - Transcript", startedAt: plus(7) };
  assert.equal(isDuplicate(rec, [entry({})]), true);
});

test("isDuplicate: 12 min apart is NOT a dup", () => {
  const rec = { source: "meet" as const, sourceId: "doc1", title: "Acme Kickoff - Transcript", startedAt: plus(12) };
  assert.equal(isDuplicate(rec, [entry({})]), false);
});

test("isDuplicate: exact sourceKey always dups; calendarEventId beats title", () => {
  assert.equal(isDuplicate({ source: "wispr", sourceId: "abc", title: "whatever", startedAt: plus(500) }, [entry({})]), true);
  const seen = [entry({ fuzzyKey: "cal:evt1" })];
  assert.equal(isDuplicate({ source: "meet", sourceId: "d", title: "Totally different", calendarEventId: "evt1", startedAt: plus(3) }, seen), true);
  assert.equal(isDuplicate({ source: "meet", sourceId: "d", title: "Acme Kickoff", calendarEventId: "evt2", startedAt: plus(3) }, seen), false);
});

// ── digest.ts ──
test("parseDigest: extracts the first JSON object, validates owners, coerces costsMoney", () => {
  const raw = `Sure! {"summary":"s","decisions":["d1",""],"items":[
    {"owner":"FRIDAY","item":"Ship the landing page","why":"agreed","costsMoney":"yes"},
    {"owner":"bob","item":"ignored"},
    {"owner":"owner","item":"Sign the SOW","costsMoney":false,"due":"2026-09-20"},
    {"owner":"clara","item":""}]} trailing`;
  const d = parseDigest(raw);
  assert.ok(d);
  assert.equal(d.summary, "s");
  assert.deepEqual(d.decisions, ["d1"]);
  assert.equal(d.items.length, 2);
  assert.equal(d.items[0].owner, "friday");
  assert.equal(d.items[0].costsMoney, true);
  assert.equal(d.items[1].costsMoney, false);
  assert.equal(d.items[1].due, "2026-09-20");
});

test("parseDigest: garbage → null; caps items", () => {
  assert.equal(parseDigest("no json here"), null);
  assert.equal(parseDigest("{not json}"), null);
  assert.equal(parseDigest('{"foo":1}'), null);
  const many = JSON.stringify({ summary: "x", items: Array.from({ length: 30 }, (_, i) => ({ owner: "clara", item: `t${i}` })) });
  assert.equal(parseDigest(many)?.items.length, MAX_ITEMS);
});

// ── file.ts ──
const rec: MeetingRecord = {
  source: "wispr", sourceId: "m-42", title: "Acme weekly", attendees: ["Jordan", "Dana Acme"],
  startedAt: T0, endedAt: plus(30), transcript: "Jordan: Friday, ship it.\nDana: We'll need ads too.", shareLink: "https://wispr.example/s/42",
};
const item = (over: Partial<ResolvedItem>): ResolvedItem => ({ owner: "friday", item: "Deploy staging", why: "Dana asked", n: 1, ...over });

test("buildPreamble: single item, header + money flag + ref", () => {
  const p = buildPreamble(rec, [item({ client: "Acme", project: "Acme Site", costsMoney: true })], "wispr:m-42", { timeZone: "America/New_York" });
  assert.equal(p, [
    `From CLARA — meeting "Acme weekly" on Sat, Sep 12, 2026 with Jordan, Dana Acme. Client: Acme. Project: Acme Site.`,
    "Task: Deploy staging",
    "Context: Dana asked",
    "Flag: likely costs money — apply your spend gate.",
    "Ref: clara-meeting:wispr:m-42#1",
  ].join("\n"));
});

test("buildPreamble: numbered when ≥2, no flag when not money, unknown client", () => {
  const p = buildPreamble(rec, [item({ n: 2 }), item({ n: 5, item: "Rotate keys", why: "leak" })], "wispr:m-42", { timeZone: "UTC" });
  assert.match(p, /Client: unknown\. Project: —\./);
  assert.match(p, /^1\. Task: Deploy staging$/m);
  assert.match(p, /^2\. Task: Rotate keys$/m);
  assert.match(p, /Ref: clara-meeting:wispr:m-42#2$/m);
  assert.match(p, /Ref: clara-meeting:wispr:m-42#5$/m);
  assert.doesNotMatch(p, /spend gate/);
});

// ── wispr.ts ──
test("stripMarkers / nextOffset on a truncated chunk fixture", () => {
  const chunk = [
    "<<<PARTICIPANT NAMES: Jordan, Dana>>>",
    "Jordan: hello",
    "Dana: hi",
    "(...truncated, 2500 chars remaining; continue with view_transcript.start_char=1500...)",
  ].join("\n");
  assert.equal(nextOffset(chunk), 1500);
  assert.equal(stripMarkers(chunk), "Jordan: hello\nDana: hi");
  const last = "Dana: bye\n<<<END TRANSCRIPT>>>";
  assert.equal(nextOffset(last), null);
  assert.equal(stripMarkers(last), "Dana: bye");
});

// ── shadow note render ──
test("renderNote: shadow fixture", () => {
  const digest: MeetingDigest = {
    summary: "Agreed to ship staging.",
    decisions: ["Go with option B"],
    items: [],
  };
  const items: ResolvedItem[] = [
    item({ n: 1, client: "Acme", costsMoney: true }),
    item({ n: 2, owner: "owner", item: "Sign SOW", why: "contract", due: "2026-09-20" }),
  ];
  const note = renderNote(rec, digest, items, { mode: "shadow", sourceKey: "wispr:m-42", generatedAt: T0 });
  assert.match(note, /^---\nsource: wispr\nsourceId: "m-42"\n/);
  assert.match(note, /\nmode: shadow\n/);
  assert.match(note, /shareLink: "https:\/\/wispr\.example\/s\/42"/);
  assert.match(note, /SHADOW run/);
  assert.match(note, /## Summary\n\nAgreed to ship staging\./);
  assert.match(note, /## Decisions\n\n- Go with option B/);
  assert.match(note, /1\. \*\*\[FRIDAY\]\*\* Deploy staging _\(client: Acme, COSTS MONEY\)_\n {3}- why: Dana asked\n {3}- would dispatch to FRIDAY/);
  assert.match(note, /2\. \*\*\[the owner\]\*\* Sign SOW _\(due 2026-09-20\)_[\s\S]*would file for the owner/);
  assert.match(note, /## Transcript\n\n```text\nJordan: Friday, ship it\./);
  assert.doesNotMatch(note, /\n\n\n/);
  assert.equal(notePathFor(rec, "UTC"), "meetings/2026-09-12-acme-weekly.md");
  const sms = buildNotifyText(rec, items, { mode: "shadow", notePath: "meetings/x.md" });
  assert.match(sms, /^SHADOW: Meeting "Acme weekly" digested — 2 items\. Yours \(1\): Sign SOW\. FRIDAY 1 \(would send\)\. 1 flagged as costing money\./);
});

// ── Gemini doc names ──
test("parseMeetName: strips the Gemini suffix AND the embedded timestamp, returns the scheduled start", () => {
  const p = parseMeetName("Dana Sample - 2026/09/11 14:55 EDT - Notes by Gemini");
  assert.equal(p.title, "Dana Sample");
  assert.equal(p.startedAt, "2026-09-11T18:55:00.000Z");
  assert.equal(meetTitle("Acme Co | Globex Training - 2026/09/11 11:55 EDT - Notes by Gemini"), "Acme Co | Globex Training");
  assert.equal(parseMeetName("Weekly sync - Notes by Gemini").startedAt, undefined);
  assert.equal(parseMeetName("Odd - 2026/09/11 14:55 XYZ - Transcript").startedAt, undefined, "unknown zone → no guessed start");
});

test("isDuplicate: the Gemini copy of a Wispr-digested meeting dedupes (title + scheduled start)", () => {
  const wispr = entry({ sourceKey: "wispr:e06e", fuzzyKey: fuzzyKey({ title: "Dana Sample" }), startedAt: "2026-09-11T19:00:00.000Z" });
  const p = parseMeetName("Dana Sample - 2026/09/11 14:55 EDT - Notes by Gemini");
  const rec = { source: "meet" as const, sourceId: "doc-dana", title: p.title, startedAt: p.startedAt! };
  assert.equal(isDuplicate(rec, [wispr]), true);
  assert.equal(fuzzyKey({ title: "Dana Sample - 2026/09/11 14:55 EDT" }), "title:dana sample", "normaliser also drops a stray stamp");
});

// ── ignore list ──
test("ignoredReason: title, attendee domain, or ≥3 transcript mentions; otherwise null", () => {
  const kw = ["globex", "globex corp", "globexcorp"];
  const base = { title: "Acme kickoff", transcript: "we talked about ads", summary: "" };
  assert.equal(ignoredReason(base, kw), null);
  assert.match(ignoredReason({ ...base, title: "Globex Corp Standup" }, kw)!, /title/);
  assert.match(ignoredReason({ ...base, attendeeEmails: ["dev@globexcorp.com"] }, kw)!, /globexcorp\.com/);
  assert.match(ignoredReason({ ...base, title: "Initech review", transcript: "Globex setup, Globex migration, globex app" }, kw)!, /3×/);
  assert.equal(ignoredReason({ ...base, transcript: "someone mentioned Globex once" }, kw), null, "a passing mention is not enough");
  assert.equal(ignoredReason({ ...base, title: "Globex Corp Standup" }, []), null, "empty list disables");
});
