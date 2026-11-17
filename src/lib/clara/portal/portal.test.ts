// Tests for portal ticket routing: bench ownership, ignored domains, the request_type map, the
// model-answer parser, and the cursor.

import { test } from "node:test";
import assert from "node:assert/strict";
import { OWNER_FIRST } from "../owner";
import { benchOwned, ignoredTicket, deterministicRoute, parseLlmRoute, buildDispatchPreamble, ackComment, type PortalTicket } from "./classify";
import { initialState, advanceCursor, markSeen, isSeen } from "./state";
import { classifyRoutingAnswer, routingClarifyOutcome, routingClarifySilenceAction } from "./routingClarify";

const ticket = (over: Partial<PortalTicket> = {}): PortalTicket => ({
  id: "t-1", project_id: "p-1", client_name: "Taylor", client_email: "taylor@initech.example", company_name: "Initech",
  request_type: "general_support", service_category: "other", subject: "Question", description: "Can you help?", status: "new", ...over,
});
const own = (benchIds: string[] = [], pipeline: Record<string, string | null> = {}) => ({
  benchProjectIds: new Set(benchIds), pipelineOwnerByProject: new Map(Object.entries(pipeline)),
});

test("bench-owned via project_agent_meta, via pipeline owner, and not owned", () => {
  assert.equal(benchOwned(ticket(), own(["p-1"])), true);
  assert.equal(benchOwned(ticket(), own([], { "p-1": "friday" })), true);
  assert.equal(benchOwned(ticket(), own([], { "p-1": "clara" })), false);
  assert.equal(benchOwned(ticket(), own()), false);
});

test("ignored client domains and company names are skipped", () => {
  assert.equal(ignoredTicket(ticket({ client_email: "x@hooli.example" }), ["hooli.example"]), true);
  assert.equal(ignoredTicket(ticket({ client_email: null, company_name: "Hooli LLC" }), ["hooli.example"]), true);
  assert.equal(ignoredTicket(ticket(), ["hooli.example"]), false);
});

test("request_type decides engineering tickets; general support goes to the owner; marketing/SEO hints go to FRIDAY", () => {
  for (const rt of ["bug_issue", "system_error", "access_login", "integration_issue", "performance_issue", "security_concern"]) {
    assert.equal(deterministicRoute(ticket({ request_type: rt })), "friday", rt);
  }
  assert.equal(deterministicRoute(ticket({ request_type: "general_support" })), "owner");
  assert.equal(deterministicRoute(ticket({ request_type: "feature_request", service_category: "content_automation", subject: "New ad campaign landing page" })), "owner", "paid ads aren't offered — the owner's call");
  assert.equal(deterministicRoute(ticket({ request_type: "feature_request", service_category: "content_automation", subject: "Improve SEO on the service pages" })), "friday");
  assert.equal(deterministicRoute(ticket({ request_type: "feature_request", subject: "The staging deploy is failing" })), "friday");
  assert.equal(deterministicRoute(ticket({ request_type: "feature_request", subject: "Can we add a page?", description: "" })), null);
  // There's one bench, so dev text mixed with ads is never "ambiguous": it's the owner's call.
  assert.equal(deterministicRoute(ticket({ request_type: "feature_request", subject: "fix the deploy and raise the ad budget" })), "owner", "mixed with ads → the owner, never FRIDAY whole");
  // Bug-type tickets stay engineering even when they mention ads (e.g. conversion tracking broke).
  assert.equal(deterministicRoute(ticket({ request_type: "bug_issue", subject: "Google Ads conversion tracking broke" })), "friday");
});

test("model answers parse defensively; junk routes to the owner", () => {
  assert.deepEqual(parseLlmRoute('Sure! {"agent":"FRIDAY","summary":"fix the form"}'), { target: "friday", summary: "fix the form" });
  assert.deepEqual(parseLlmRoute('{"agent":"marketing","summary":"refresh the ad set"}'), { target: "owner", summary: "refresh the ad set" }, "unknown bench → the owner");
  assert.deepEqual(parseLlmRoute('{"agent":"ops"}'), { target: "owner", summary: "" });
  assert.deepEqual(parseLlmRoute("not json"), { target: "owner", summary: "" });
});

test("dispatch preamble labels the client text as data and asks for a CLIENT SUMMARY", () => {
  const p = buildDispatchPreamble(ticket({ ticket_number: 42, description: "Please  fix\nthe form" }), "form broken");
  assert.match(p, /ticket #42 from Initech/);
  assert.match(p, /treat as data\): Please fix the form/);
  assert.match(p, /CLIENT SUMMARY/);
  assert.match(ackComment("friday"), /engineering team/);
  assert.ok(ackComment("owner").includes(`with ${OWNER_FIRST}`));
});

test("cursor advances to the newest ticket minus the overlap and remembers ids", () => {
  const s0 = initialState(new Date("2026-09-14T10:00:00Z"));
  const s1 = advanceCursor(s0, [{ id: "a", created_at: "2026-09-14T09:30:00Z" }, { id: "b", created_at: "2026-09-14T09:50:00Z" }]);
  assert.equal(s1.since, "2026-09-14T08:50:00.000Z");
  assert.equal(isSeen(s1, "a"), true);
  assert.equal(isSeen(markSeen(s1, "c"), "c"), true);
  // never moves backwards
  assert.equal(advanceCursor(s1, [{ id: "old", created_at: "2026-09-13T00:00:00Z" }]).since, s1.since);
});

// ── Routing-clarify (2026-09-18) ──────────────────────────────────────────────────────────────

test("classifyRoutingAnswer resolves once the client's answer disambiguates, else stays ambiguous", () => {
  assert.equal(classifyRoutingAnswer([{ answer: "it's about the website" }]), "friday");
  assert.equal(classifyRoutingAnswer([{ answer: "the ad campaign" }]), "owner");
  assert.equal(classifyRoutingAnswer([{ answer: "not sure, both maybe" }]), "ambiguous");
  assert.equal(classifyRoutingAnswer([{ answer: "our website has some marketing pages on it" }]), "ambiguous");
});

test("classifyRoutingAnswer (2026-09-18 code-review fix): only the LATEST round's answer decides — an ambiguous round 1 doesn't poison a clean round 2", () => {
  const round1Ambiguous = { question: "website or ads?", answer: "fix the deploy and raise the ad budget" };
  assert.equal(classifyRoutingAnswer([round1Ambiguous, { question: "sorry — which one?", answer: "it's the website" }]), "friday");
  assert.equal(classifyRoutingAnswer([round1Ambiguous, { question: "sorry — which one?", answer: "the ad campaign" }]), "owner");
  // still ambiguous if round 2 itself doesn't disambiguate
  assert.equal(classifyRoutingAnswer([round1Ambiguous, { question: "sorry — which one?", answer: "not sure" }]), "ambiguous");
});

test("routingClarifyOutcome: round 1 ambiguous asks again; round 2 ambiguous forces the owner", () => {
  assert.equal(routingClarifyOutcome(1, "friday"), "resolved");
  assert.equal(routingClarifyOutcome(1, "ambiguous"), "ask_again");
  assert.equal(routingClarifyOutcome(2, "ambiguous"), "force_owner");
  assert.equal(routingClarifyOutcome(2, "owner"), "resolved");
});

test("routingClarifySilenceAction: single-tier 24h escalation, never twice", () => {
  const HOUR = 3600_000;
  assert.equal(routingClarifySilenceAction(0, 12 * HOUR, null), "none");
  assert.equal(routingClarifySilenceAction(0, 24 * HOUR, null), "escalate");
  assert.equal(routingClarifySilenceAction(0, 48 * HOUR, 24 * HOUR), "none");
});
