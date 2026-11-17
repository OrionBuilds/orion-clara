// Tests for the human-vs-robot mail filters, with the exact shapes seen in the live inbox on
// 2026-09-14 (Hooli "Task overdue", Globex "New Lead", a calendar invite, CLARA's own digest).

import { test } from "node:test";
import assert from "node:assert/strict";
import { automatedReason, domainOf, isClaraNotification, redactAddress, senderEmail } from "./mailFilters";

const H = (o: Record<string, string>) => new Map(Object.entries(o).map(([k, v]) => [k.toLowerCase(), v]));

test("domainOf: company domains pass, freemail and junk are null", () => {
  assert.equal(domainOf("taylor@initech.example"), "initech.example");
  assert.equal(domainOf("Someone@GMAIL.com"), null);
  assert.equal(domainOf("nope"), null);
  assert.equal(domainOf("@x.com"), null);
});

test("Hooli notification bot: automated by sender name even without headers", () => {
  assert.match(automatedReason({ from: "notifications@partner.example", subject: "Task overdue" }) ?? "", /automated sender/);
});

test("Globex lead blast: automated by List-Unsubscribe header", () => {
  const r = automatedReason({ from: '"Globex, Inc." <info@globex.example>', subject: "GLOBEX Has a New Lead!!!", headers: H({ "List-Unsubscribe": "<mailto:x>" }) });
  assert.equal(r, "mailing list");
});

test("calendar invites are automated by MIME type and by subject", () => {
  assert.equal(automatedReason({ from: "taylor@initech.example", subject: "Invitation: Acme kickoff @ Mon", mimeTypes: ["text/plain", "text/calendar"] }), "calendar");
  assert.equal(automatedReason({ from: "taylor@initech.example", subject: "Invitation: Acme kickoff @ Mon" }), "calendar");
});

test("Google Group relay, precedence bulk, auto-submitted and delivery reports are automated", () => {
  assert.equal(automatedReason({ from: "a@b.com", subject: "x", headers: H({ "X-Google-Group-Id": "1" }) }), "automated header");
  assert.equal(automatedReason({ from: "a@b.com", subject: "x", headers: H({ Precedence: "bulk" }) }), "precedence bulk");
  assert.equal(automatedReason({ from: "a@b.com", subject: "x", headers: H({ "Auto-Submitted": "auto-generated" }) }), "auto-submitted");
  assert.equal(automatedReason({ from: "a@b.com", subject: "x", headers: H({ "Auto-Submitted": "no" }) }), null);
  assert.equal(automatedReason({ from: "mailer-daemon@g.com", subject: "x" })?.startsWith("automated sender"), true);
});

test("a person at a client domain is not automated", () => {
  assert.equal(automatedReason({ from: "Taylor Client <taylor@initech.example>", subject: "Question about the site", headers: H({ "Content-Type": "text/plain" }) }), null);
});

test("isClaraNotification: header form and subject forms from a principal address only", () => {
  const owner = ["jordan@example.com"];
  assert.equal(isClaraNotification({ from: "Jordan Example <jordan@example.com>", subject: "Clara digest (10)" }, owner), true);
  assert.equal(isClaraNotification({ from: "jordan@example.com", subject: "Clara: schedule.job_cap" }, owner), true);
  assert.equal(isClaraNotification({ from: "jordan@example.com", subject: "Clara please book dinner" }, owner), false);
  assert.equal(isClaraNotification({ from: "someone@else.com", subject: "Clara digest (3)" }, owner), false);
  assert.equal(isClaraNotification({ from: "someone@else.com", subject: "anything", headers: H({ "X-Clara-Notify": "1" }) }, owner), true);
});

test("senderEmail and redactAddress", () => {
  assert.equal(senderEmail('"Globex, Inc." <INFO@Globex.Example>'), "info@globex.example");
  assert.equal(redactAddress("Taylor <taylor@initech.example>"), "t***@initech.example");
  assert.equal(redactAddress("junk"), "***");
});

test("isClaraNotification: X-Agent header from any agent is never a command", () => {
  assert.equal(isClaraNotification({ from: "jordan@example.com", subject: "[FRIDAY] Run report", headers: H({ "X-Agent": "FRIDAY" }) }, ["jordan@example.com"]), true);
});

test("isClaraNotification: self-addressed mail from a principal is Clara's own, whatever the subject", () => {
  const p = ["jordan@example.com"];
  assert.equal(isClaraNotification({ from: "Jordan <jordan@example.com>", to: "jordan@example.com", subject: "Evening wind-down — 2026-09-23" }, p), true);
  // A self-addressed REPLY is the owner answering a brief — an instruction, not Clara's own mail.
  assert.equal(isClaraNotification({ from: "Jordan <jordan@example.com>", subject: "Re: Morning brief — Thu Sep 24", headers: H({ To: "Jordan <jordan@example.com>" }) }, p), false);
  assert.equal(isClaraNotification({ from: "Jordan <jordan@example.com>", subject: "FRIDAY digest (10)", headers: H({ To: "Jordan <jordan@example.com>" }) }, p), true);
  // A principal writing to someone else is not self-addressed.
  assert.equal(isClaraNotification({ from: "jordan@example.com", to: "clara@example.com", subject: "book Taylor Thursday" }, p), false);
  // A stranger addressing the owner is not Clara.
  assert.equal(isClaraNotification({ from: "someone@example.com", to: "jordan@example.com", subject: "hello" }, p), false);
});
