import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyDeterministic, classifyReply, ROUTING_TABLE, routeReply, repliesTick, handleInboundSmsReply,
  PROSPECTS_LABEL, REVIEW_LABEL,
  type ClassifyDeps, type RouteReplyDeps, type RepliesTickDeps, type SmsReplyDeps, type ReplyClass,
} from "./replies";
import type { OutreachEventsLookupResult } from "./osBridge";
import type { GmailFullMessage } from "../ms-mail";

// ── classifyDeterministic — fixtures for every deterministic path ──────────────────────────────

test("classifyDeterministic: a DSN/bounce from mailer-daemon", () => {
  const r = classifyDeterministic({ from: "Mail Delivery Subsystem <mailer-daemon@googlemail.com>", subject: "Delivery Status Notification (Failure)", body: "Your message wasn't delivered to jane@acme.com because the address couldn't be found." });
  assert.deepEqual(r, { class: "bounce", confidence: 1, meetingIntent: false });
});
test("classifyDeterministic: a DSN detected by subject/body alone, non-mailer-daemon sender", () => {
  const r = classifyDeterministic({ from: "postmaster@acme.com", subject: "Undeliverable: following up", body: "This is an automatically generated Delivery Status Notification." });
  assert.equal(r?.class, "bounce");
});
test("classifyDeterministic: Auto-Submitted header marks an OOO regardless of body wording", () => {
  const r = classifyDeterministic({ from: "jane@acme.com", subject: "Re: quick question", body: "I'm currently unavailable.", autoSubmitted: "auto-replied" });
  assert.deepEqual(r, { class: "ooo", confidence: 1, meetingIntent: false });
});
test("classifyDeterministic: OOO detected from subject/body without the header", () => {
  const r = classifyDeterministic({ from: "jane@acme.com", subject: "Automatic reply: Out of Office", body: "I am out of office until Monday and will respond when I return." });
  assert.equal(r?.class, "ooo");
});
test("classifyDeterministic: an explicit unsubscribe/opt-out request", () => {
  const r = classifyDeterministic({ from: "jane@acme.com", subject: "Re: quick question", body: "Please unsubscribe me from this list." });
  assert.deepEqual(r, { class: "unsubscribe", confidence: 1, meetingIntent: false });
});
test("classifyDeterministic: STOP alone is recognized via the shared OPTOUT_RE", () => {
  assert.equal(classifyDeterministic({ from: "jane@acme.com", subject: "STOP", body: "" })?.class, "unsubscribe");
});
test("classifyDeterministic: an ordinary reply matches none of the deterministic paths", () => {
  assert.equal(classifyDeterministic({ from: "jane@acme.com", subject: "Re: quick question", body: "Sure, happy to chat — what did you have in mind?" }), undefined);
});
test("classifyDeterministic: bounce is checked before OOO/optout (precedence)", () => {
  const r = classifyDeterministic({ from: "mailer-daemon@acme.com", subject: "Automatic reply: unsubscribe request bounced", body: "" });
  assert.equal(r?.class, "bounce");
});

// ── classifyReply — tier escalation ─────────────────────────────────────────────────────────────

test("classifyReply: a deterministic match never calls runTier at all", async () => {
  let called = false;
  const deps: ClassifyDeps = { runTier: async () => { called = true; return { ok: false, engine: "lmstudio" }; } };
  const r = await classifyReply({ from: "jane@acme.com", subject: "STOP", body: "" }, deps);
  assert.equal(r.class, "unsubscribe");
  assert.equal(called, false);
});

test("classifyReply: a confident tier-1 result (>=0.7) is used directly, no tier-3 call", async () => {
  let calls = 0;
  const deps: ClassifyDeps = { runTier: async () => { calls++; return { ok: true, engine: "lmstudio", text: JSON.stringify({ class: "interested", confidence: 0.85, meeting_intent: true }) }; } };
  const r = await classifyReply({ from: "jane@acme.com", subject: "Re: quick question", body: "Yes let's talk" }, deps);
  assert.deepEqual(r, { class: "interested", confidence: 0.85, meetingIntent: true });
  assert.equal(calls, 1);
});

test("classifyReply: a low-confidence tier-1 result (<0.7) escalates to tier-3", async () => {
  let tierCalls: number[] = [];
  const deps: ClassifyDeps = {
    runTier: async (tier) => {
      tierCalls.push(tier);
      if (tier === 1) return { ok: true, engine: "lmstudio", text: JSON.stringify({ class: "question", confidence: 0.4, meeting_intent: false }) };
      return { ok: true, engine: "anthropic", text: JSON.stringify({ class: "interested", confidence: 0.9, meeting_intent: false }) };
    },
  };
  const r = await classifyReply({ from: "jane@acme.com", subject: "Re:", body: "maybe, tell me more" }, deps);
  assert.deepEqual(tierCalls, [1, 3]);
  assert.equal(r.class, "interested");
});

test("classifyReply: both tiers fail -> unknown, never throws", async () => {
  const deps: ClassifyDeps = { runTier: async () => ({ ok: false, engine: "lmstudio" }) };
  const r = await classifyReply({ from: "jane@acme.com", subject: "Re:", body: "hmm" }, deps);
  assert.equal(r.class, "unknown");
});

test("classifyReply: tier-3 failing after a weak tier-1 falls back to the weak tier-1 result rather than unknown", async () => {
  const deps: ClassifyDeps = {
    runTier: async (tier) => (tier === 1 ? { ok: true, engine: "lmstudio", text: JSON.stringify({ class: "not_now", confidence: 0.5, meeting_intent: false }) } : { ok: false, engine: "anthropic" }),
  };
  const r = await classifyReply({ from: "jane@acme.com", subject: "Re:", body: "not right now" }, deps);
  assert.deepEqual(r, { class: "not_now", confidence: 0.5, meetingIntent: false });
});

test("classifyReply: an invalid class name from the model is normalized to unknown, never passed through raw", async () => {
  const deps: ClassifyDeps = { runTier: async () => ({ ok: true, engine: "lmstudio", text: JSON.stringify({ class: "definitely_a_lead!!", confidence: 0.9 }) }) };
  const r = await classifyReply({ from: "jane@acme.com", subject: "Re:", body: "x" }, deps);
  assert.equal(r.class, "unknown");
});

// ── ROUTING_TABLE — assertions per the plan's Part 6 §4 table ──────────────────────────────────

test("ROUTING_TABLE: every one of the 10 classes has an entry", () => {
  const classes: ReplyClass[] = ["interested", "question", "not_now", "not_interested", "unsubscribe", "ooo", "bounce", "referral", "wrong_person", "unknown"];
  for (const c of classes) assert.ok(ROUTING_TABLE[c], c);
});
test("ROUTING_TABLE: interested replies stop the enrollment, task + draft, and are hot-notify-eligible", () => {
  assert.deepEqual(ROUTING_TABLE.interested, { enrollmentEventType: "replied", ownerNotify: "important_if_meeting", createTask: true, draftReply: true });
});
test("ROUTING_TABLE: question pauses 48h with a task + draft", () => {
  const a = ROUTING_TABLE.question;
  assert.equal(a.enrollmentEventType, "blocked");
  assert.equal(a.rescheduleHours, 48);
  assert.equal(a.createTask, true);
  assert.equal(a.draftReply, true);
});
test("ROUTING_TABLE: not_now stops and snoozes 90 days, no task/draft", () => {
  const a = ROUTING_TABLE.not_now;
  assert.equal(a.enrollmentEventType, "stopped");
  assert.equal(a.snoozeDays, 90);
  assert.equal(a.createTask, false);
});
test("ROUTING_TABLE: not_interested stops and suppresses the company 180 days", () => {
  const a = ROUTING_TABLE.not_interested;
  assert.equal(a.enrollmentEventType, "stopped");
  assert.equal(a.companySuppressionDays, 180);
});
test("ROUTING_TABLE: unsubscribe is a count-only notification, never a task", () => {
  const a = ROUTING_TABLE.unsubscribe;
  assert.equal(a.enrollmentEventType, "unsubscribed");
  assert.equal(a.ownerNotify, "count_only");
  assert.equal(a.createTask, false);
});
test("ROUTING_TABLE: ooo reschedules 7 days out, no owner notification at all", () => {
  const a = ROUTING_TABLE.ooo;
  assert.equal(a.enrollmentEventType, "skipped");
  assert.equal(a.rescheduleHours, 24 * 7);
  assert.equal(a.ownerNotify, "none");
});
test("ROUTING_TABLE: bounce marks the enrollment bounced, count-only", () => {
  assert.equal(ROUTING_TABLE.bounce.enrollmentEventType, "bounced");
  assert.equal(ROUTING_TABLE.bounce.ownerNotify, "count_only");
});
test("ROUTING_TABLE: referral and wrong_person both stop + task, never an auto-draft", () => {
  for (const c of ["referral", "wrong_person"] as const) {
    assert.equal(ROUTING_TABLE[c].enrollmentEventType, "stopped");
    assert.equal(ROUTING_TABLE[c].createTask, true);
    assert.equal(ROUTING_TABLE[c].draftReply, false);
  }
});
test("ROUTING_TABLE: unknown pauses for review with the Clara/Review Gmail label", () => {
  const a = ROUTING_TABLE.unknown;
  assert.equal(a.enrollmentEventType, "blocked");
  assert.equal(a.gmailLabel, REVIEW_LABEL);
  assert.equal(a.createTask, true);
});

// ── routeReply — execution over fakeDeps ────────────────────────────────────────────────────────

function enrollment(overrides: Partial<NonNullable<OutreachEventsLookupResult["enrollment"]>> = {}) {
  return { enrollment_id: "en_1", sequence_id: "seq_1", company_id: "co_1", person_id: "p_1", contact_id: "contact_1", status: "active", ...overrides };
}
function routeDeps(overrides: Partial<RouteReplyDeps> = {}): RouteReplyDeps {
  return {
    outreachEventsAdd: async () => undefined,
    suppressionsAdd: async () => undefined,
    factsAdd: async () => ({ inserted: [], signals_emitted: [] }),
    createContactTask: async () => undefined,
    textOwnerImportant: async () => "duplicate",
    createReplyDraft: async () => ({ ok: true, id: "draft_1" }),
    now: () => new Date("2026-01-05T15:00:00Z"),
    ...overrides,
  };
}

test("routeReply (interested + meeting intent): texts the owner important and writes a 'replied' event", async () => {
  let eventArgs: unknown, texted = false;
  const deps = routeDeps({ outreachEventsAdd: async (a) => { eventArgs = a; }, textOwnerImportant: async () => { texted = true; return "send"; } });
  await routeReply({ enrollment: enrollment(), companyName: "Acme Roofing", classification: { class: "interested", confidence: 0.9, meetingIntent: true }, email: { from: "jane@acme.com", subject: "Re: intro", body: "Let's set up a call", threadId: "t1", messageId: "m1" } }, deps);
  assert.equal((eventArgs as { event_type: string }).event_type, "replied");
  assert.equal(texted, true);
});
test("routeReply (interested, no meeting/price/contract language): does NOT text the owner important", async () => {
  let texted = false;
  const deps = routeDeps({ textOwnerImportant: async () => { texted = true; return "send"; } });
  await routeReply({ enrollment: enrollment(), companyName: "Acme Roofing", classification: { class: "interested", confidence: 0.9, meetingIntent: false }, email: { from: "jane@acme.com", subject: "Re:", body: "sounds good, keep me posted", threadId: "t1", messageId: "m1" } }, deps);
  assert.equal(texted, false);
});
test("routeReply (not_interested): suppresses the company for 180 days", async () => {
  let suppressArgs: unknown;
  const deps = routeDeps({ suppressionsAdd: async (a) => { suppressArgs = a; } });
  await routeReply({ enrollment: enrollment(), companyName: "Acme Roofing", classification: { class: "not_interested", confidence: 0.9, meetingIntent: false } }, deps);
  const args = suppressArgs as { kind: string; value: string; expires_at: string };
  assert.equal(args.kind, "company");
  assert.equal(args.value, "co_1");
  assert.equal(new Date(args.expires_at).getTime() - deps.now().getTime(), 180 * 86_400_000);
});
test("routeReply (question): reschedules 48h out via a 'blocked' event with next_run_at set", async () => {
  let eventArgs: unknown;
  const deps = routeDeps({ outreachEventsAdd: async (a) => { eventArgs = a; } });
  await routeReply({ enrollment: enrollment(), companyName: "Acme Roofing", classification: { class: "question", confidence: 0.9, meetingIntent: false } }, deps);
  const a = eventArgs as { event_type: string; next_run_at: string };
  assert.equal(a.event_type, "blocked");
  assert.equal(new Date(a.next_run_at).getTime() - deps.now().getTime(), 48 * 3_600_000);
});
test("routeReply: no contact_id on the enrollment skips task creation even when the class calls for one", async () => {
  let taskCalled = false;
  const deps = routeDeps({ createContactTask: async () => { taskCalled = true; } });
  await routeReply({ enrollment: enrollment({ contact_id: undefined }), companyName: "Acme Roofing", classification: { class: "referral", confidence: 0.9, meetingIntent: false } }, deps);
  assert.equal(taskCalled, false);
});
test("routeReply: an SMS-origin reply (no email field) never attempts a Gmail draft", async () => {
  let draftCalled = false;
  const deps = routeDeps({ createReplyDraft: async () => { draftCalled = true; return { ok: true }; } });
  await routeReply({ enrollment: enrollment(), companyName: "Acme Roofing", classification: { class: "interested", confidence: 0.9, meetingIntent: true } }, deps);
  assert.equal(draftCalled, false);
});

// ── repliesTick ──────────────────────────────────────────────────────────────────────────────

function gmailMsg(overrides: Partial<GmailFullMessage> = {}): GmailFullMessage {
  return {
    id: "m1", threadId: "t1", from: "jane@acme.com", to: "clara@example.com", subject: "Re: quick question",
    snippet: "", date: "", labelIds: [], unread: true,
    headers: new Map([["message-id", "<m1@acme.com>"]]), body: "Sure, let's talk", mimeTypes: ["text/plain"],
    ...overrides,
  };
}
function tickDeps(overrides: Partial<RepliesTickDeps> = {}): RepliesTickDeps {
  return {
    searchMessages: async () => [{ id: "m1" } as never],
    fetchMessageFull: async () => gmailMsg(),
    outreachEventsLookup: async () => ({ match: "email", enrollment: enrollment() }),
    classify: async () => ({ class: "interested", confidence: 0.9, meetingIntent: false }),
    routeReply: async () => ({ action: ROUTING_TABLE.interested }),
    ensureLabel: async () => "label_id",
    addLabel: async () => ({ ok: true }),
    companyNameFor: async () => "Acme Roofing",
    ...overrides,
  };
}

test("repliesTick: searches with the exact -label:Clara/Prospects query", async () => {
  let query = "";
  const deps = tickDeps({ searchMessages: async (q) => { query = q; return []; } });
  await repliesTick(deps);
  assert.equal(query, `newer_than:2d -label:${PROSPECTS_LABEL}`);
});
test("repliesTick: a message that doesn't resolve to any enrollment is scanned but not matched/routed", async () => {
  let routeCalled = false;
  const deps = tickDeps({ outreachEventsLookup: async () => ({ match: null, enrollment: null }), routeReply: async () => { routeCalled = true; return { action: ROUTING_TABLE.unknown }; } });
  const r = await repliesTick(deps);
  assert.equal(r.scanned, 1);
  assert.equal(r.matched, 0);
  assert.equal(routeCalled, false);
});
test("repliesTick: a matched reply is classified, routed, and tallied by class", async () => {
  const r = await repliesTick(tickDeps());
  assert.equal(r.matched, 1);
  assert.equal(r.routed.interested, 1);
});
test("repliesTick: every processed message gets the Clara/Prospects label, matched or not (never reprocessed)", async () => {
  let labeledIds: string[] = [];
  const deps = tickDeps({ outreachEventsLookup: async () => ({ match: null, enrollment: null }), addLabel: async (id) => { labeledIds.push(id); return { ok: true }; } });
  await repliesTick(deps);
  assert.ok(labeledIds.includes("m1"));
});
test("repliesTick: an unknown classification also gets the Clara/Review label, chained through the id the first move returned", async () => {
  let labeledIds: string[] = [];
  const deps = tickDeps({
    classify: async () => ({ class: "unknown", confidence: 0.2, meetingIntent: false }),
    addLabel: async (id) => { labeledIds.push(id); return { ok: true, newId: `${id}-moved` }; },
  });
  await repliesTick(deps);
  // Clara/Prospects (first call, on the original id) then Clara/Review (second call) — the second
  // call must use the id the first move returned, not the original, since Graph reassigns the
  // message a new id on every folder move (ms-mail.ts's addLabel/archive) — this is exactly the
  // chaining hazard found and fixed in repliesTick/inboxZero.ts/triage.ts.
  assert.deepEqual(labeledIds, ["m1", "m1-moved"]);
});

// ── handleInboundSmsReply ────────────────────────────────────────────────────────────────────

function smsDeps(overrides: Partial<SmsReplyDeps> = {}): SmsReplyDeps {
  return {
    outreachEventsLookup: async () => ({ match: "phone", enrollment: enrollment() }),
    classify: async () => ({ class: "interested", confidence: 0.9, meetingIntent: false }),
    routeReply: async () => ({ action: ROUTING_TABLE.interested }),
    companyNameFor: async () => "Acme Roofing",
    recordInboundContactConsent: async () => undefined,
    isOnDnc: async () => false,
    addToDnc: async () => undefined,
    ...overrides,
  };
}

test("handleInboundSmsReply: a phone with no matching enrollment is a clean non-match (the ordinary case)", async () => {
  const deps = smsDeps({ outreachEventsLookup: async () => ({ match: null, enrollment: null }) });
  const r = await handleInboundSmsReply("+18135550199", "hey who is this", deps);
  assert.deepEqual(r, { matched: false });
});
test("handleInboundSmsReply: a matched reply always records inbound_contact consent, regardless of content", async () => {
  let consentPhone: string | undefined;
  const deps = smsDeps({ recordInboundContactConsent: async (p) => { consentPhone = p; } });
  await handleInboundSmsReply("+18135550199", "sounds good", deps);
  assert.equal(consentPhone, "+18135550199");
});
test("handleInboundSmsReply: an opt-out-shaped reply also lands on the DNC list", async () => {
  let dncPhone: string | undefined;
  const deps = smsDeps({ classify: async () => ({ class: "unsubscribe", confidence: 1, meetingIntent: false }), addToDnc: async (p) => { dncPhone = p; } });
  const r = await handleInboundSmsReply("+18135550199", "please stop texting me", deps);
  assert.equal(r.class, "unsubscribe");
  assert.equal(dncPhone, "+18135550199");
});
test("handleInboundSmsReply: already-on-DNC never double-adds", async () => {
  let addCalled = false;
  const deps = smsDeps({ classify: async () => ({ class: "unsubscribe", confidence: 1, meetingIntent: false }), isOnDnc: async () => true, addToDnc: async () => { addCalled = true; } });
  await handleInboundSmsReply("+18135550199", "STOP", deps);
  assert.equal(addCalled, false);
});
