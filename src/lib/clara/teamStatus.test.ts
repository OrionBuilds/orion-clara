// Tests for the team-status layer: subject ranking, the prose renderer (answer first, provenance
// second, channel caps, no codes/emoji, links dropped on voice), unreachable-bench provenance,
// ambiguity, and the delegation-receipt renderer. Everything here is pure; no bench is called.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { StatusResponse, StatusResult } from "@autom8ionlab/agent-core";
import { rankByName, renderStatus, renderDelegations, ago } from "./teamStatus";
import { newDelegation, type Delegation } from "./delegations";
import { TOOLS } from "./intent";

const NOW = Date.parse("2026-09-24T18:05:00.000Z");
const iso = (minsAgo: number) => new Date(NOW - minsAgo * 60_000).toISOString();

const friday: StatusResponse = {
  ok: true,
  asOf: iso(0),
  agent: "friday",
  subject: { type: "project", id: "p1", name: "Globex Website", client: "Globex" },
  summary: { stage: "client review", status: "active", health: "green", headline: "Build 12 went live this morning" },
  recent: [
    { when: iso(20), headline: "Pages tailored to your Google Ads and a dedicated call line", link: "https://docs.google.com/document/d/abc", source: "portal" },
    { when: iso(180), headline: "fix(landers): single-column hero (#21)", source: "git" },
    { when: iso(600), headline: "Deployed to production [#A1B2] ✅", link: "https://app.netlify.com/x", source: "deploy" },
    { when: iso(900), headline: "Fourth item", source: "run" },
  ],
  open: [{ when: iso(30), headline: "Weekly on-site SEO audit", source: "task" }],
  blocked: [],
  nextUp: [{ when: iso(0), headline: "Metal roof landing page copy", source: "task" }],
  approvalsPending: [{ when: iso(100), headline: "Send Dana the Globex report", detail: "approve #C0DE to send", source: "approval" }],
  sources: [
    { name: "portal feed", fetchedAt: iso(20), ok: true },
    { name: "last deploy", fetchedAt: iso(600), ok: true },
    { name: "github", fetchedAt: iso(0), ok: false, note: "timeout" },
  ],
};


test("rankByName: exact beats prefix beats contains; ties return every top-tier row", () => {
  const rows = [{ name: "Globex Website" }, { name: "Globex Marketing" }, { name: "Acme Co" }, { name: "globex" }];
  assert.deepEqual(rankByName("globex", rows).map((r) => r.name), ["globex"]);
  assert.deepEqual(rankByName("Globex W", rows).map((r) => r.name), ["Globex Website"]);
  assert.deepEqual(rankByName("acme", rows).map((r) => r.name), ["Acme Co"]);
  assert.equal(rankByName("glob", rows).length, 3, "three globex rows tie on contains");
  assert.deepEqual(rankByName("zzz", rows), []);
});

test("chat render: answer line, then provenance with freshness and unreachable sources", () => {
  const out = renderStatus({ friday }, { channel: "chat", now: NOW });
  const lines = out.split("\n");
  assert.equal(lines[0], "Globex Website is in client review and on track — Build 12 went live this morning.");
  assert.match(lines[1], /^As of \d{1,2}:\d{2} (AM|PM) today, per FRIDAY: portal feed 20 min ago, last deploy 10h ago; github unreachable\.$/);
  assert.match(out, /Recent activity:/);
  assert.match(out, /In flight:/);
  assert.match(out, /Next up:/);
  assert.match(out, /Waiting on you:\n- Send Dana the Globex report/);
  assert.ok(out.includes("https://docs.google.com/document/d/abc"), "chat keeps links");
  assert.doesNotMatch(out, /#[A-Z0-9]{4}|approve #|✅/, "codes and emoji are stripped");
});

test("sms render: at most 6 lines and 600 chars, still answer + provenance first", () => {
  const out = renderStatus({ friday }, { channel: "sms", now: NOW });
  const lines = out.split("\n");
  assert.ok(lines.length <= 6, `${lines.length} lines`);
  assert.ok(out.length <= 600, `${out.length} chars`);
  assert.match(lines[0], /^Globex Website is in client review and on track/);
  assert.match(lines[1], /^As of .* per FRIDAY/);
});

test("voice render drops links", () => {
  const out = renderStatus({ friday }, { channel: "voice", now: NOW });
  assert.doesNotMatch(out, /https?:\/\//);
  assert.ok(out.split("\n").length <= 6);
});

test("cached bench answer says so in the provenance line", () => {
  const out = renderStatus({ friday, cached: { friday: { fetchedAt: iso(40) } }, unreachable: ["friday"] }, { channel: "chat", now: NOW });
  assert.match(out.split("\n")[1], /FRIDAY unreachable — last I saw was 40 min ago/);
});

test("bench down with nothing cached is said plainly, never invented", () => {
  const out = renderStatus({ unreachable: ["friday"] }, { channel: "chat", now: NOW });
  assert.match(out, /couldn't reach FRIDAY/);
  assert.doesNotMatch(out, /on track|in trouble/);
});

test("ambiguous subject asks which one, never a numbered list", () => {
  const amb: StatusResult = { ok: false, error: "ambiguous", candidates: [{ id: "1", name: "Globex Website" }, { id: "2", name: "Globex Marketing", client: "Globex" }] };
  const out = renderStatus({ friday: amb }, { channel: "sms", now: NOW });
  assert.equal(out, "Which one — Globex Website, or Globex Marketing (Globex)?");
});

test("portfolio render leads with the roll-up and lists the bench's items", () => {
  const pf: StatusResponse = { ...friday, subject: { type: "portfolio", id: "all", name: "portfolio" }, summary: { status: "active", health: "amber", headline: "2 of 6 projects need attention" } };
  const out = renderStatus({ friday: pf }, { channel: "chat", now: NOW });
  assert.match(out.split("\n")[0], /^Across the board: 2 of 6 projects need attention/);
  assert.match(out, /Pages tailored to your Google Ads/);
});

test("delegation receipts: replyTo and askedBy round-trip through newDelegation", () => {
  const d = newDelegation({ summary: "put the lead form first", source: { kind: "sms", ref: "SM1" }, replyTo: { channel: "sms", from: "+15550001111" }, askedBy: "owner" }, "friday", { taskIds: ["t1"] });
  assert.deepEqual(d.replyTo, { channel: "sms", from: "+15550001111" });
  assert.equal(d.askedBy, "owner");
  const plain = newDelegation({ summary: "x", source: { kind: "email", ref: "m1" } }, "friday", {});
  assert.equal(plain.replyTo, undefined);
  assert.equal(plain.askedBy, undefined);
});

test("renderDelegations: counts, filters by query, short on sms", () => {
  const rows: Delegation[] = [
    { ...newDelegation({ summary: "put the lead form first", source: { kind: "sms", ref: "1" }, askedBy: "owner" }, "friday", { taskIds: ["t1"] }, iso(120)), status: "done", lastPolledAt: iso(10) },
    { ...newDelegation({ summary: "refresh the Acme ad creative", source: { kind: "chat", ref: "2" }, askedBy: "owner" }, "friday", { taskIds: ["t2"] }, iso(30)) },
    { ...newDelegation({ summary: "old finished thing", source: { kind: "email", ref: "3" } }, "friday", { taskIds: ["t3"] }, iso(5000)), status: "done", lastPolledAt: iso(4000) },
  ];
  const all = renderDelegations(rows, undefined, "chat", NOW);
  assert.match(all, /^1 in progress, 1 finished, 0 stuck\./);
  assert.doesNotMatch(all, /old finished thing/, "older than 48h is dropped");
  const lead = renderDelegations(rows, "lead form", "sms", NOW);
  assert.match(lead, /FRIDAY — put the lead form first: done \(10 min ago\)/);
  assert.doesNotMatch(lead, /Acme/);
  assert.match(renderDelegations(rows, "zzz", "chat", NOW), /haven't handed anything matching/);
});

test("ago", () => {
  assert.equal(ago(iso(0), NOW), "just now");
  assert.equal(ago(iso(5), NOW), "5 min ago");
  assert.equal(ago(iso(120), NOW), "2h ago");
  assert.equal(ago(iso(60 * 24), NOW), "yesterday");
});

test("status questions are Clara's tools, and the tools say so", () => {
  const names = TOOLS.map((t) => t.name);
  for (const n of ["project_status", "client_status", "delegation_status"]) assert.ok(names.includes(n), n);
  const ps = TOOLS.find((t) => t.name === "project_status")!;
  assert.match(ps.description, /Never delegate a status question/);
  assert.equal(ps.reversible, true);
  assert.equal(ps.speed, "fast");
});
