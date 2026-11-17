// Tests for the plain-language decisions rail: deterministic phrasing per source row, the ask
// renderer's channel shapes (no codes, SMS length), urgency ordering, and the same-day rule.

import { test } from "node:test";
import assert from "node:assert/strict";
import { phraseDecision, renderAsk, sortByUrgency, needsSameDayAsk, decisionIdFor, splitDecisionId, type Decision } from "./decisions";
import type { Approval } from "./approvals";
import type { AgentApproval } from "./agentProxy";

const NOW = Date.parse("2026-09-24T15:00:00Z");
const claraRow = (over: Partial<Approval>): Approval => ({
  id: "3c1b6f2e-0000-4000-8000-00000000ab12", kind: "email.send", title: "Email dana@acme.example: Sprint 2 report",
  summary: "Requested over sms. 900 char body.", requestor: "owner", createdAt: new Date(NOW - 3 * 3600_000).toISOString(),
  status: "pending", intent: {}, ...over,
});
const agentRow = (agent: "friday", over: Partial<AgentApproval>): AgentApproval => ({
  agent, id: "9d8e7f6a-0000-4000-8000-0000000012ef", title: "Send Dana the Acme Co sprint report", risk: "low",
  requestedAt: new Date(NOW - 26 * 3600_000).toISOString(), code: "12EF", raw: {}, ...over,
});

const NO_CODES = /#[0-9A-F]{3,6}\b|\[#|approve #/i;

test("clara rows phrase by kind, never with a code", () => {
  const d = phraseDecision("clara", claraRow({}));
  assert.equal(d.id, "clara:3c1b6f2e-0000-4000-8000-00000000ab12");
  assert.equal(d.question, "Send this email: Email dana@acme.example: Sprint 2 report?");
  assert.equal(d.category, "other");
  assert.doesNotMatch(renderAsk(d, "sms"), NO_CODES);
  const call = phraseDecision("clara", claraRow({ kind: "call.business", title: "Call Bay Roofing Supply about the quote" }));
  assert.match(call.question, /^OK for me to make the call: Call Bay Roofing Supply about the quote\?$/);
  assert.equal(call.defaultIfIgnored, "I won't place the call");
  const scope = phraseDecision("clara", claraRow({ kind: "scope.out-of-bounds", title: "Add a members area (Acme Co)" }));
  assert.equal(scope.category, "scope");
  const money = phraseDecision("clara", claraRow({ kind: "vendor.quote-req", title: "Quotes for a new laptop", amountUsd: 2400 }));
  assert.equal(money.category, "money");
  assert.equal(money.amountUsd, 2400);
});

test("friday rows prefer the structured question, then the headline, and classify money/scope", () => {
  const q = phraseDecision("friday", agentRow("friday", { needsDecision: { question: "Send Dana the Acme Co sprint report" }, headline: "Acme Co sprint report", summary: "Sprint 2 wrapped last night.", projectName: "Acme Co", clientName: "Dana" }));
  assert.equal(q.question, "Send Dana the Acme Co sprint report?");
  assert.equal(q.why, "Sprint 2 wrapped last night.");
  assert.deepEqual(q.subject, { project: "Acme Co", client: "Dana" });
  assert.equal(q.category, "other");
  const money = phraseDecision("friday", agentRow("friday", { title: "Renew the Netlify plan ($228/yr)", kind: "spend", expiresAt: "2026-09-26T12:00:00Z" }));
  assert.equal(money.category, "money");
  assert.equal(money.amountUsd, 228);
  assert.match(money.defaultIfIgnored, /^it expires/);
  const scope = phraseDecision("friday", agentRow("friday", { title: "Build the members area", detail: "Client asked for work outside the agreed scope." }));
  assert.equal(scope.category, "scope");
  assert.equal(scope.question, "Should FRIDAY go ahead with this: Build the members area?");
  const verb = phraseDecision("friday", agentRow("friday", { title: "Deploy the Acme Co landing page" }));
  assert.equal(verb.question, "Do you want FRIDAY to deploy the Acme Co landing page?");
});


test("renderAsk: sms ≤ 300 chars with the default clause, voice drops it, email adds context", () => {
  const d = phraseDecision("friday", agentRow("friday", { title: "Send the report", summary: "S".repeat(200), needsDecision: { question: "Send Dana the Acme Co sprint report" } }));
  const sms = renderAsk(d, "sms");
  assert.ok(sms.length <= 300, `${sms.length}`);
  assert.match(sms, /If I don't hear back, FRIDAY holds it\.$/);
  const voice = renderAsk(d, "voice");
  assert.doesNotMatch(voice, /If I don't hear back/);
  assert.match(renderAsk(d, "email"), /If I don't hear back/);
  for (const ch of ["sms", "voice", "email", "brief", "chat"] as const) assert.doesNotMatch(renderAsk(d, ch), NO_CODES);
});

test("urgency: money before scope before other, oldest first within", () => {
  const mk = (category: Decision["category"], hoursAgo: number, id: string): Decision =>
    ({ ...phraseDecision("friday", agentRow("friday", { id, title: `t ${id}`, requestedAt: new Date(NOW - hoursAgo * 3600_000).toISOString() })), category });
  const sorted = sortByUrgency([mk("other", 30, "a"), mk("money", 1, "b"), mk("scope", 10, "c"), mk("money", 5, "d")]);
  assert.deepEqual(sorted.map((d) => d.nativeId), ["d", "b", "c", "a"]);
});

test("needsSameDayAsk: never for other; money when old in business hours, expiring, or client waiting", () => {
  const base = phraseDecision("friday", agentRow("friday", { title: "Renew the Netlify plan ($228/yr)", kind: "spend", requestedAt: new Date(NOW - 3 * 3600_000).toISOString() }));
  assert.equal(needsSameDayAsk({ ...base, category: "other" }, NOW, true), false);
  assert.equal(needsSameDayAsk(base, NOW, true), true);
  assert.equal(needsSameDayAsk({ ...base, requestedAt: new Date(NOW - 10 * 60_000).toISOString() }, NOW, true), false);
  assert.equal(needsSameDayAsk({ ...base, requestedAt: new Date(NOW - 10 * 60_000).toISOString(), expiresAt: new Date(NOW + 3600_000).toISOString() }, NOW, false), true);
  assert.equal(needsSameDayAsk(base, NOW, false), false);
  assert.equal(needsSameDayAsk({ ...base, raw: { clientWaiting: true }, requestedAt: new Date(NOW).toISOString() }, NOW, false), true);
});

test("decision ids round-trip", () => {
  assert.deepEqual(splitDecisionId(decisionIdFor("friday", "abc:def")), { agent: "friday", nativeId: "abc:def" });
  assert.equal(splitDecisionId("nope"), null);
});
