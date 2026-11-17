// Pure-renderer tests for the model-based morning brief (2026-09-24): escaping and links in the
// HTML, the subject line, plain-English questions, and the spoken fallback's hygiene.

import { test } from "node:test";
import assert from "node:assert/strict";
import { renderBriefHtml, renderBriefMarkdown, renderBriefSpoken, briefSubject, questionFor, stripEmoji, type BriefModel } from "./briefModel";

const model = (over: Partial<BriefModel> = {}): BriefModel => ({
  date: "2026-09-24",
  now: "2026-09-24T12:00:00.000Z",
  meetings: {
    today: [{ id: "e1", start: "2026-09-24T14:00:00Z", end: "2026-09-24T14:30:00Z", summary: "Acme Co <review> & plan", attendees: ["eric@acme.example"], external: true, prepLink: "https://docs.google.com/document/d/abc/edit" }],
    tomorrowAm: [],
  },
  emails: [{ from: "Dana \"D\" Initech", subject: "Q4 <budget>", why: "VIP — asking about the invoice", link: "https://mail.google.com/mail/u/0/#inbox/t1", threadId: "t1" }],
  prep: [{ meeting: "Acme Co review", start: "2026-09-24T14:00:00Z", docName: "Prep — Acme Co review — 2026-09-24", link: "https://docs.google.com/document/d/abc/edit" }],
  team: {
    friday: { actions: [{ text: "Faster ad landing pages — video first, form in a pop-up", link: "https://docs.google.com/document/d/run1/edit" }], fromCache: true, fetchedAt: "2026-09-23T11:59:00Z" },

  },
  waiting: [{ agent: "friday", id: "A1", code: "3F2A", title: "Send the bi-weekly report to Globex", question: "Do you want FRIDAY to send the bi-weekly report to Globex?", age: "4h" }],
  watch: ["FRIDAY unreachable — approvals cached from 2026-09-23T11:59:00Z."],
  batched: ["[FRIDAY] Daily call counts now follow your local day"],
  counts: { meetings: 1, emails: 1, decisions: 1 },
  ...over,
});

test("HTML escapes user content and keeps links clickable", () => {
  const html = renderBriefHtml(model());
  assert.ok(html.includes("Acme Co &lt;review&gt; &amp; plan"), "meeting summary escaped");
  assert.ok(html.includes("Q4 &lt;budget&gt;"), "subject escaped");
  assert.ok(html.includes('href="https://docs.google.com/document/d/abc/edit"'), "prep link present");
  assert.ok(html.includes('href="https://mail.google.com/mail/u/0/#inbox/t1"'), "gmail link present");
  assert.ok(!html.includes("<review>"), "no raw angle brackets from content");
  assert.ok(!/#3F2A|3F2A/.test(html), "approval code never rendered");
  assert.ok(html.includes("Do you want FRIDAY to send the bi-weekly report"), "question rendered");
  assert.ok(html.includes("FRIDAY unreachable — showing what I had from"), "stale peer flagged");

});

test("markdown mirrors the sections the gate and headline parsers expect", () => {
  const md = renderBriefMarkdown(model());
  for (const h of ["## Meetings today (1)", "## Tomorrow morning (0)", "## Emails that need you (1)", "## Prep for today (1)", "## What the team did", "## Questions for you (1)", "## Watch", "## Batched (1)"]) {
    assert.ok(md.includes(h), `missing ${h}`);
  }
  assert.ok(!/3F2A/.test(md));
});

test("subject line is built from the counts", () => {
  assert.equal(briefSubject(model()), "Morning brief — Thu Sep 24: 1 meeting, 1 email needs you, 1 decision");
  assert.equal(briefSubject(model({ counts: { meetings: 2, emails: 3, decisions: 0 } })), "Morning brief — Thu Sep 24: 2 meetings, 3 emails need you, 0 decisions");
  assert.equal(briefSubject(model({ counts: { meetings: 0, emails: 0, decisions: 0 } })), "Morning brief — Thu Sep 24: quiet day");
});

test("questionFor phrases decisions in plain English without codes", () => {
  assert.equal(questionFor({ agent: "friday", title: "Send bi-weekly report to Globex (#3F2A)" }), "Do you want FRIDAY to send bi-weekly report to Globex?");
  assert.equal(questionFor({ agent: "friday", title: "Deploy the Acme Co landing page" }), "Do you want FRIDAY to deploy the Acme Co landing page?");
  assert.equal(questionFor({ agent: "friday", title: "Acme Co: TypeScript upgrade" }), 'Do you want FRIDAY to go ahead with "Acme Co: TypeScript upgrade"?');
  assert.equal(questionFor({ agent: "clara", title: "Initech about the quote", kind: "call.business" }), "OK for me to make the call: Initech about the quote?");
  assert.equal(questionFor({ agent: "clara", title: "Reply to Dana re: invoice", kind: "email.send" }), "Send this email: Reply to Dana re: invoice?");
  assert.ok(!/#/.test(questionFor({ agent: "clara", title: "✅ Edit ICP doc (#AB12)", kind: "drive.modify" })));
});

test("spoken fallback is plain prose: no markdown, emoji or codes, no 'sir'", () => {
  const spoken = renderBriefSpoken(model({ waiting: [{ agent: "friday", id: "x", code: "9Z9Z", title: "t", question: "Do you want FRIDAY to merge the Acme Co build?" }] }));
  assert.ok(!/[*#_\[\]]/.test(spoken), `markdown chars in: ${spoken}`);
  assert.ok(!/9Z9Z/.test(spoken));
  assert.equal(stripEmoji(spoken), spoken);
  assert.equal((spoken.match(/\bsir\b/gi) ?? []).length, 0);
  assert.ok(spoken.startsWith("Good morning, "));
  assert.ok(spoken.endsWith("What do you need from me?"));
  assert.ok(spoken.includes("Do you want FRIDAY to merge the Acme Co build?"));
});

test("stripEmoji leaves ASCII and accents alone", () => {
  assert.equal(stripEmoji("Café ✅ done 🔔 — résumé"), "Café done — résumé");
});

test("Calls & texts appears only when the work line is on, with the callback list", () => {
  assert.doesNotMatch(renderBriefMarkdown(model()), /Calls & texts/);
  const m = model({ callsAndTexts: { lines: ["Jackson (Globex) called — site down. I took a message."], callbacks: ["Jackson (Globex) — +18135550100: site down"] } });
  const md = renderBriefMarkdown(m);
  assert.match(md, /## Calls & texts \(1\)\n- Jackson \(Globex\) called — site down\. I took a message\.\n\n\*\*Call back:\*\*\n- Jackson/);
  assert.match(renderBriefHtml(m), /Calls &amp; texts \(1\)/);
  assert.match(renderBriefSpoken(m), /On your work phone, one person called or texted\. You owe a callback, starting with Jackson \(Globex\)\./);
  assert.match(renderBriefSpoken(model({ callsAndTexts: { lines: [], callbacks: [] } })), /Nobody called or texted your work phone\./);
});

test("Prospecting section appears only when prospect_daily_stats produced a summary line", () => {
  assert.doesNotMatch(renderBriefMarkdown(model()), /## Prospecting/);
  assert.doesNotMatch(renderBriefHtml(model()), />Prospecting</);
  assert.doesNotMatch(renderBriefSpoken(model()), /Prospecting:/);

  const summary = "1,842 match ICP · 217 strong signals · 38 sent · 12 replies (4 interested) · 3 booked";
  const m = model({ prospecting: summary });
  assert.match(renderBriefMarkdown(m), new RegExp(`## Prospecting\\n${summary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n`));
  assert.match(renderBriefHtml(m), /<h2[^>]*>Prospecting<\/h2>/);
  assert.match(renderBriefHtml(m), /4 interested/);
  assert.match(renderBriefSpoken(m), /Prospecting: 1,842 match ICP/);
});
