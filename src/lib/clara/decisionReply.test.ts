// Tests for the reply parser and target resolver. The classifier is the gate that keeps money
// safe, so the table is deliberately long and includes the known bad shapes ("can you do it
// tomorrow?", "don't do it").

import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyDecisionReply, matchByReference, resolveTarget, moneyGuardPasses, splitClauses, parseDeferUntil, stripQuotedReply } from "./decisionReply";
import { phraseDecision, type Decision } from "./decisions";
import type { AgentApproval } from "./agentProxy";

const NOW = Date.parse("2026-09-24T15:00:00Z");
const row = (agent: "friday", over: Partial<AgentApproval>): Decision =>
  phraseDecision(agent, { agent, id: over.id ?? "9d8e7f6a-0000-4000-8000-0000000012ef", title: "x", risk: "low", requestedAt: new Date(NOW - 3600_000).toISOString(), code: "12EF", raw: {}, ...over });
const roofReport = row("friday", { id: "1", title: "Send Dana the Acme Co sprint report", needsDecision: { question: "Send Dana the Acme Co sprint report" }, projectName: "Acme Co", clientName: "Dana" });
const initechBudget = row("friday", { id: "2", title: "Initech search daily budget", kind: "budget_change", fromValue: "$40/day", toValue: "$60/day", clientName: "Initech" });
const netlify = row("friday", { id: "3", title: "Renew the Netlify plan ($228/yr)", kind: "spend" });

const table: Array<[string, "approve" | "reject" | "defer" | "question" | "none"]> = [
  ["yes", "approve"], ["Yes.", "approve"], ["yep", "approve"], ["ok", "approve"], ["okay go ahead", "approve"],
  ["go ahead", "approve"], ["do it", "approve"], ["send it", "approve"], ["ship it", "approve"], ["approved", "approve"],
  ["sure, go ahead", "approve"], ["yes please", "approve"], ["sounds good", "approve"], ["green light", "approve"],
  ["fine by me", "approve"], ["yes go ahead with that", "approve"], ["confirm", "approve"], ["proceed", "approve"],
  ["no", "reject"], ["nope", "reject"], ["hold that", "reject"], ["hold off", "reject"], ["not yet", "reject"],
  ["don't", "reject"], ["do not send it", "reject"], ["leave it", "reject"], ["skip it", "reject"], ["reject", "reject"],
  ["decline", "reject"], ["cancel that", "reject"], ["no, hold the Initech one", "reject"], ["nah", "reject"],
  ["can you do it tomorrow?", "question"], ["what happens if I approve?", "question"], ["should I say yes?", "question"],
  ["is it ready?", "none"], ["don't do it", "reject"], ["yes but actually no", "question"], ["ok what's the weather", "none"],
  ["what's on my calendar", "none"], ["remind me to call Marcus", "none"], ["how's Acme Co going", "none"],
  ["yes, but only if the client has paid, otherwise hold it until we hear back from them and then decide again next week after the call with Dana about the invoice and the scope", "question"],
  ["send it Monday", "defer"], ["yes, tomorrow", "defer"], ["do it next week", "defer"], ["later", "none"], ["hold it until Friday", "defer"],
  ["not now, ask me tomorrow", "defer"], ["maybe after the call", "defer"],
];

test("classifier table", () => {
  for (const [text, want] of table) {
    const got = classifyDecisionReply(text, { now: new Date(NOW) }).verdict;
    assert.equal(got, want, `"${text}" → ${got}, wanted ${want}`);
  }
});

test("approve words after the third word do not approve unless a reference is present", () => {
  assert.equal(classifyDecisionReply("I think we should probably go ahead", { now: new Date(NOW) }).verdict, "none");
  assert.equal(classifyDecisionReply("go ahead with the Acme Co report", { hasReference: true, now: new Date(NOW) }).verdict, "approve");
  assert.equal(classifyDecisionReply("go ahead with the Acme Co report", { hasReference: true }).strong, true);
});

test("strong = reference or a reply within 10 minutes of the ask", () => {
  assert.equal(classifyDecisionReply("yes", { askedAgoMs: 5 * 60_000 }).strong, true);
  assert.equal(classifyDecisionReply("yes", { askedAgoMs: 60 * 60_000 }).strong, false);
});

test("quoted mail is stripped before classification", () => {
  const mail = "yes\n\nOn Wed, Sep 24, 2026 Clara wrote:\n> Send Dana the Acme Co sprint report?\n> If I don't hear back, FRIDAY holds it.";
  assert.equal(stripQuotedReply(mail), "yes");
  assert.equal(classifyDecisionReply(mail).verdict, "approve");
  assert.equal(classifyDecisionReply("> only quoted").verdict, "question");
});

test("parseDeferUntil is coarse and forward-looking", () => {
  const now = new Date("2026-09-24T15:00:00");
  assert.equal(parseDeferUntil("send it monday", now)?.slice(0, 10), "2026-09-28");
  assert.equal(parseDeferUntil("tomorrow", now)?.slice(0, 10), "2026-09-25");
  assert.equal(parseDeferUntil("next week", now)?.slice(0, 10), "2026-09-28");
  assert.ok(Date.parse(parseDeferUntil("in 2 hours", now)!) === now.getTime() + 2 * 3600_000);
  assert.equal(parseDeferUntil("no time words here", now), undefined);
});

test("matchByReference: subject names, ≥2 tokens, or the dollar amount", () => {
  const pending = [roofReport, initechBudget, netlify];
  assert.deepEqual(matchByReference("yes to the Acme Co report", pending).map((d) => d.nativeId), ["1"]);
  assert.deepEqual(matchByReference("hold the Initech bump", pending).map((d) => d.nativeId), ["2"]);
  assert.deepEqual(matchByReference("approve the $228 one", pending).map((d) => d.nativeId), ["3"]);
  assert.deepEqual(matchByReference("renew netlify", pending).map((d) => d.nativeId), ["3"]);
  assert.deepEqual(matchByReference("yes", pending), []);
  assert.deepEqual(matchByReference("ok go ahead", pending), []);
});

test("resolveTarget: reference → last-asked (6h) → only-one (asked 24h) → clarify", () => {
  const pending = [roofReport, initechBudget];
  const asked = new Set(["friday:1"]);
  assert.equal(resolveTarget("yes to the acme co report", pending, null, asked, NOW).kind, "hit");
  const la = resolveTarget("yes", pending, { id: "friday:2", askedAt: new Date(NOW - 3600_000).toISOString() }, asked, NOW);
  assert.equal(la.kind, "hit"); if (la.kind === "hit") assert.equal(la.via, "last-asked");
  const stale = resolveTarget("yes", pending, { id: "friday:2", askedAt: new Date(NOW - 7 * 3600_000).toISOString() }, asked, NOW);
  assert.equal(stale.kind, "clarify");
  const only = resolveTarget("yes", [roofReport], null, asked, NOW);
  assert.equal(only.kind, "hit"); if (only.kind === "hit") assert.equal(only.via, "only-one");
  assert.equal(resolveTarget("yes", [initechBudget], null, new Set(), NOW).kind, "clarify");
  const cl = resolveTarget("yes", pending, null, asked, NOW);
  assert.equal(cl.kind, "clarify"); if (cl.kind === "clarify") assert.equal(cl.candidates[0].nativeId, "2"); // money first
});

test("money guard: money needs reference or last-asked; only-one is not enough", () => {
  assert.equal(moneyGuardPasses({ kind: "hit", decision: initechBudget, via: "only-one" }), false);
  assert.equal(moneyGuardPasses({ kind: "hit", decision: initechBudget, via: "last-asked" }), true);
  assert.equal(moneyGuardPasses({ kind: "hit", decision: initechBudget, via: "reference" }), true);
  assert.equal(moneyGuardPasses({ kind: "hit", decision: roofReport, via: "only-one" }), true);
});

test("splitClauses: one answer per item in an email", () => {
  assert.deepEqual(splitClauses("yes to the Acme Co report, hold the Initech bump"), ["yes to the Acme Co report, hold the Initech bump"]);
  assert.deepEqual(splitClauses("yes to the Acme Co report; hold the Initech bump"), ["yes to the Acme Co report", "hold the Initech bump"]);
  assert.deepEqual(splitClauses("yes to the Acme Co report, and hold the Initech bump"), ["yes to the Acme Co report", "hold the Initech bump"]);
  assert.deepEqual(splitClauses("Yes to the Acme Co report.\nNo to the Netlify renewal."), ["Yes to the Acme Co report", "No to the Netlify renewal"]);
});
