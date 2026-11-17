import { test } from "node:test";
import assert from "node:assert/strict";
import {
  variantIndex, pickSubjectVariant, renderTemplate, evaluateSkipIf, withinSmsWindow, prospectTimezone,
  checkCapacity, processEnrollment, sequenceRunnerTick, sequenceRunnerMode,
  type DueEnrollment, type SequenceRunnerDeps,
} from "./sequenceRunner";
import type { CompanyFullRow } from "./osBridge";
import { pickSenderDomain as realPickSenderDomain } from "./senderRotation";

// ── variantIndex / pickSubjectVariant ────────────────────────────────────────────────────────

test("variantIndex: deterministic for the same enrollment id", () => {
  const id = "enrollment_abc123";
  assert.equal(variantIndex(id, 3), variantIndex(id, 3));
});
test("variantIndex: n=0 always returns 0, never divides by zero", () => {
  assert.equal(variantIndex("x", 0), 0);
});
test("variantIndex: roughly even distribution across many ids (mod n)", () => {
  const n = 4;
  const buckets = new Array(n).fill(0);
  for (let i = 0; i < 4000; i++) buckets[variantIndex(`enrollment_${i}`, n)]++;
  for (const count of buckets) assert.ok(count > 800 && count < 1200, `bucket count ${count} is far from the ~1000 expected`);
});
test("pickSubjectVariant: picks the variant at the enrollment's hash index, falls back to the plain subject with no variants", () => {
  const variants = [{ key: "a", text: "Subject A" }, { key: "b", text: "Subject B" }];
  const picked = pickSubjectVariant("enrollment_1", variants, "fallback subject");
  assert.ok(picked.text && variants.map((v) => v.text).includes(picked.text));
  assert.deepEqual(pickSubjectVariant("enrollment_1", undefined, "fallback subject"), { text: "fallback subject" });
});

// ── renderTemplate ───────────────────────────────────────────────────────────────────────────

test("renderTemplate: substitutes known tokens, reports unresolved ones as missing", () => {
  const r = renderTemplate("Hi {{contact.first_name}}, re {{company.name}} — {{unknown_token}}", { "contact.first_name": "Jane", "company.name": "Acme" });
  assert.equal(r.text, "Hi Jane, re Acme — {{unknown_token}}");
  assert.deepEqual(r.missing, ["unknown_token"]);
});
test("renderTemplate: no tokens at all is a clean pass-through", () => {
  assert.deepEqual(renderTemplate("plain text", {}), { text: "plain text", missing: [] });
});

// ── evaluateSkipIf ───────────────────────────────────────────────────────────────────────────

test("evaluateSkipIf: no_phone skips when the enrollment has no phone method", () => {
  assert.equal(evaluateSkipIf(["no_phone"], { hasPhone: false, smsConsentOk: true }).skip, true);
  assert.equal(evaluateSkipIf(["no_phone"], { hasPhone: true, smsConsentOk: true }).skip, false);
});
test("evaluateSkipIf: no_consent:sms skips when SMS consent isn't on file", () => {
  assert.equal(evaluateSkipIf(["no_consent:sms"], { hasPhone: true, smsConsentOk: false }).skip, true);
});
test("evaluateSkipIf: no conditions, or none matching, never skips", () => {
  assert.equal(evaluateSkipIf(undefined, { hasPhone: true, smsConsentOk: true }).skip, false);
  assert.equal(evaluateSkipIf([], { hasPhone: true, smsConsentOk: true }).skip, false);
});

// ── TCPA window ──────────────────────────────────────────────────────────────────────────────

test("prospectTimezone: maps common states, defaults to Eastern for unknown/missing", () => {
  assert.equal(prospectTimezone("CA"), "America/Los_Angeles");
  assert.equal(prospectTimezone("tx"), "America/Chicago");
  assert.equal(prospectTimezone(undefined), "America/New_York");
  assert.equal(prospectTimezone("ZZ"), "America/New_York");
});
test("withinSmsWindow: inside 9am-6pm on a weekday is true", () => {
  // 2026-01-05 is a Monday. 15:00 UTC = 10:00 Eastern (EST, UTC-5).
  assert.equal(withinSmsWindow("FL", new Date("2026-01-05T15:00:00Z")), true);
});
test("withinSmsWindow: before 9am, after 6pm, or on a weekend is false", () => {
  assert.equal(withinSmsWindow("FL", new Date("2026-01-05T11:00:00Z")), false); // 6am Eastern
  assert.equal(withinSmsWindow("FL", new Date("2026-01-06T00:00:00Z")), false); // 7pm Eastern (Jan 5)
  assert.equal(withinSmsWindow("FL", new Date("2026-01-03T15:00:00Z")), false); // Saturday
});

// ── checkCapacity (domain ramp + per-company/day + per-contact/day + global/day) ────────────────

function cap(overrides: Partial<Parameters<typeof checkCapacity>[0]> = {}): Parameters<typeof checkCapacity>[0] {
  return { globalToday: 0, globalPerDay: 50, contactToday: 0, companyToday: 0, companyThisWeek: 0, domainToday: 0, domainCap: 100, ...overrides };
}
test("checkCapacity: passes well under every cap", () => { assert.equal(checkCapacity(cap()).ok, true); });
test("checkCapacity: global 50/day cap", () => { assert.deepEqual(checkCapacity(cap({ globalToday: 50 })), { ok: false, reason: "global_daily_cap" }); });
test("checkCapacity: contact 1/day cap", () => { assert.deepEqual(checkCapacity(cap({ contactToday: 1 })), { ok: false, reason: "contact_daily_cap" }); });
test("checkCapacity: company 1/day cap", () => { assert.deepEqual(checkCapacity(cap({ companyToday: 1 })), { ok: false, reason: "company_daily_cap" }); });
test("checkCapacity: company 3/week cap", () => { assert.deepEqual(checkCapacity(cap({ companyThisWeek: 3 })), { ok: false, reason: "company_weekly_cap" }); });
test("checkCapacity: domain ramp cap", () => { assert.deepEqual(checkCapacity(cap({ domainToday: 100, domainCap: 100 })), { ok: false, reason: "domain_ramp_cap" }); });
test("checkCapacity: global cap is reported first when multiple caps are hit at once", () => {
  assert.equal(checkCapacity(cap({ globalToday: 50, contactToday: 1, domainToday: 100, domainCap: 100 })).reason, "global_daily_cap");
});

// ── processEnrollment — full state-machine integration over fakeDeps ───────────────────────────

function dueEmail(overrides: Partial<DueEnrollment> = {}): DueEnrollment {
  return {
    enrollment_id: "en_1", sequence_id: "seq_1", company_id: "co_1", contact_id: "contact_1",
    status: "active", current_step_no: 0,
    sequence_name: "Roofing outreach",
    step_id: "step_1", step_no: 1, channel: "email",
    template: { subject: "Quick question", body: "Hi {{contact.first_name}}, {{ai:opener}}" },
    ai_slots: [{ name: "opener", mustCite: false, fallback: "wanted to reach out." }],
    company_name: "Acme Roofing", city: "Tampa", state: "FL",
    person_name: "Jane Smith", person_first_name: "Jane",
    method_kind: "email", method_value: "jane@acmeroofing.com", verification_status: "verified",
    allow_role_addresses: false,
    ...overrides,
  };
}

function fullRow(): CompanyFullRow {
  return { company: {}, people: [], contact_methods: [], technologies: [], facts: [], signals: [], enrollments: [] };
}

function fakeDeps(overrides: Partial<SequenceRunnerDeps> = {}): SequenceRunnerDeps {
  return {
    fetchDueEnrollments: async () => [],
    companiesGetFull: async () => fullRow(),
    checkSuppressed: async () => ({ blocked: false, hits: [] }),
    consentsOk: async () => true,
    renderStep: async (input) => ({ slots: Object.fromEntries(input.aiSlots.map((s) => [s.name, s.fallback ?? ""])), citations: {}, usedFallback: true, fromCache: false, evidenceHash: "h" }),
    mintUnsubscribeLink: async () => "https://x/u/abc",
    loadPhysicalAddress: async () => "123 Main St, Tampa, FL",
    prospectSettingsGet: async () => ({ global_email_per_day: 50 } as never),
    listSenderIdentities: async () => [{ fromAddressId: "addr_1", email: "clara@mail.acme.com", domain: "mail.acme.com" }],
    pickSenderDomain: (domains, opts) => realPickSenderDomain(domains, opts),
    isDomainPaused: async () => false,
    recordSend: async () => undefined,
    countsForTarget: async () => ({ contactToday: 0, companyToday: 0, companyThisWeek: 0 }),
    loadCapacityCounts: async () => ({ globalToday: 0, contactToday: 0, companyToday: 0, companyThisWeek: 0, domainToday: {} }),
    sendEmail: async () => ({ ok: true, messageId: "msg_1" }),
    sendSMS: async () => ({ ok: true, sid: "sms_1" }),
    isOnDnc: async () => false,
    createContactTask: async () => ({ ok: true }),
    outreachEventsAdd: async () => undefined,
    now: () => new Date("2026-01-05T15:00:00Z"), // Monday 10am Eastern — inside every window
    ...overrides,
  };
}
test("processEnrollment (email): a clean send writes a 'sent' event and records the send", async () => {
  process.env.CLARA_PROSPECT_SEQUENCES = "active";
  try {
    let recorded: unknown;
    let eventArgs: unknown;
    const deps = fakeDeps({ recordSend: async (r) => { recorded = r; }, outreachEventsAdd: async (a) => { eventArgs = a; } });
    const { outcome } = await processEnrollment(dueEmail(), deps);
    assert.equal(outcome.kind, "sent");
    assert.equal((recorded as { domain: string }).domain, "mail.acme.com");
    assert.equal((eventArgs as { event_type: string }).event_type, "sent");
  } finally {
    delete process.env.CLARA_PROSPECT_SEQUENCES;
  }
});

test("processEnrollment (email, shadow mode): never actually sends, reports a shadow skip", async () => {
  let sendCalled = false;
  const deps = fakeDeps({ sendEmail: async () => { sendCalled = true; return { ok: true }; } }); // CLARA_PROSPECT_SEQUENCES unset -> default shadow
  const { outcome } = await processEnrollment(dueEmail(), deps);
  assert.equal(outcome.kind, "skipped");
  if (outcome.kind === "skipped") assert.match(outcome.reason, /shadow/);
  assert.equal(sendCalled, false);
});

test("processEnrollment: a suppressed recipient is blocked before any send is attempted", async () => {
  process.env.CLARA_PROSPECT_SEQUENCES = "active";
  try {
    let sendCalled = false;
    const deps = fakeDeps({ checkSuppressed: async () => ({ blocked: true, hits: [{ reason: "unsubscribe" }] }), sendEmail: async () => { sendCalled = true; return { ok: true }; } });
    const { outcome } = await processEnrollment(dueEmail(), deps);
    assert.equal(outcome.kind, "blocked");
    if (outcome.kind === "blocked") assert.equal(outcome.reason, "suppressed");
    assert.equal(sendCalled, false);
  } finally {
    delete process.env.CLARA_PROSPECT_SEQUENCES;
  }
});

test("processEnrollment: missing a required template variable blocks with blocked:missing_var", async () => {
  process.env.CLARA_PROSPECT_SEQUENCES = "active";
  try {
    const e = dueEmail({ template: { subject: "Hi", body: "Re {{company.unknown_field}}" } });
    const { outcome } = await processEnrollment(e, fakeDeps());
    assert.equal(outcome.kind, "blocked");
    if (outcome.kind === "blocked") assert.match(outcome.reason, /^missing_var:/);
  } finally {
    delete process.env.CLARA_PROSPECT_SEQUENCES;
  }
});

test("processEnrollment (sms): skipped when SMS consent is not on file (consent gate)", async () => {
  process.env.CLARA_PROSPECT_SEQUENCES = "active";
  try {
    let smsCalled = false;
    const e = dueEmail({ channel: "sms", method_kind: "mobile", method_value: "+18135551234", template: { body: "Hi {{contact.first_name}}" }, requires_consent: "sms" });
    const deps = fakeDeps({ consentsOk: async () => false, sendSMS: async () => { smsCalled = true; return { ok: true }; } });
    const { outcome } = await processEnrollment(e, deps);
    assert.equal(outcome.kind, "skipped");
    if (outcome.kind === "skipped") assert.equal(outcome.reason, "no_consent");
    assert.equal(smsCalled, false);
  } finally {
    delete process.env.CLARA_PROSPECT_SEQUENCES;
  }
});

test("processEnrollment (sms): sends when consent is on file and inside the TCPA window", async () => {
  process.env.CLARA_PROSPECT_SEQUENCES = "active";
  try {
    const e = dueEmail({ channel: "sms", method_kind: "mobile", method_value: "+18135551234", template: { body: "Hi {{contact.first_name}}" }, requires_consent: "sms" });
    const { outcome } = await processEnrollment(e, fakeDeps());
    assert.equal(outcome.kind, "sent");
  } finally {
    delete process.env.CLARA_PROSPECT_SEQUENCES;
  }
});

test("processEnrollment (sms): skipped outside the TCPA window even with consent", async () => {
  process.env.CLARA_PROSPECT_SEQUENCES = "active";
  try {
    const e = dueEmail({ channel: "sms", method_kind: "mobile", method_value: "+18135551234", template: { body: "Hi" }, requires_consent: "sms" });
    const deps = fakeDeps({ now: () => new Date("2026-01-05T02:00:00Z") }); // 9pm Eastern the prior day
    const { outcome } = await processEnrollment(e, deps);
    assert.equal(outcome.kind, "skipped");
    if (outcome.kind === "skipped") assert.equal(outcome.reason, "outside_tcpa_window");
  } finally {
    delete process.env.CLARA_PROSPECT_SEQUENCES;
  }
});

test("processEnrollment (sms): a DNC number is blocked, never sent", async () => {
  process.env.CLARA_PROSPECT_SEQUENCES = "active";
  try {
    const e = dueEmail({ channel: "sms", method_kind: "mobile", method_value: "+18135551234", template: { body: "Hi" }, requires_consent: "sms" });
    const deps = fakeDeps({ isOnDnc: async () => true });
    const { outcome } = await processEnrollment(e, deps);
    assert.deepEqual(outcome, { kind: "blocked", reason: "dnc" });
  } finally {
    delete process.env.CLARA_PROSPECT_SEQUENCES;
  }
});

test("processEnrollment (task): creates a contact task when promoted (contact_id present)", async () => {
  process.env.CLARA_PROSPECT_SEQUENCES = "active";
  try {
    const e = dueEmail({ channel: "task", template: { body: "Call them", task_title: "Follow up" } });
    const { outcome } = await processEnrollment(e, fakeDeps());
    assert.equal(outcome.kind, "task_created");
  } finally {
    delete process.env.CLARA_PROSPECT_SEQUENCES;
  }
});
test("processEnrollment (task): skipped as not_promoted when there's no CRM contact yet", async () => {
  process.env.CLARA_PROSPECT_SEQUENCES = "active";
  try {
    const e = dueEmail({ channel: "task", contact_id: undefined, template: { body: "Call them" } });
    const { outcome } = await processEnrollment(e, fakeDeps());
    assert.deepEqual(outcome, { kind: "skipped", reason: "not_promoted" });
  } finally {
    delete process.env.CLARA_PROSPECT_SEQUENCES;
  }
});
test("processEnrollment (call): defaults to an owner task, never an autonomous Clara call", async () => {
  process.env.CLARA_PROSPECT_SEQUENCES = "active";
  try {
    const e = dueEmail({ channel: "call", template: { body: "notes" } });
    let taskArgs: unknown;
    const deps = fakeDeps({ createContactTask: async (a) => { taskArgs = a; return { ok: true }; } });
    const { outcome } = await processEnrollment(e, deps);
    assert.equal(outcome.kind, "call_placed");
    assert.match((taskArgs as { title: string }).title, /Call/);
  } finally {
    delete process.env.CLARA_PROSPECT_SEQUENCES;
  }
});

test("processEnrollment: capacity block (global cap) prevents a send even when everything else passes", async () => {
  process.env.CLARA_PROSPECT_SEQUENCES = "active";
  try {
    const deps = fakeDeps({ loadCapacityCounts: async () => ({ globalToday: 50, contactToday: 0, companyToday: 0, companyThisWeek: 0, domainToday: {} }) });
    const { outcome } = await processEnrollment(dueEmail(), deps);
    assert.deepEqual(outcome, { kind: "blocked", reason: "global_daily_cap" });
  } finally {
    delete process.env.CLARA_PROSPECT_SEQUENCES;
  }
});

test("processEnrollment: an unexpected error is caught and reported as blocked, never thrown", async () => {
  process.env.CLARA_PROSPECT_SEQUENCES = "active";
  try {
    const deps = fakeDeps({ companiesGetFull: async () => { throw new Error("OS timeout"); } });
    const { outcome } = await processEnrollment(dueEmail(), deps);
    assert.equal(outcome.kind, "blocked");
    if (outcome.kind === "blocked") assert.match(outcome.reason, /^error:/);
  } finally {
    delete process.env.CLARA_PROSPECT_SEQUENCES;
  }
});

// ── Tick ─────────────────────────────────────────────────────────────────────────────────────

test("sequenceRunnerMode: defaults to shadow, reads CLARA_PROSPECT_SEQUENCES", () => {
  assert.equal(sequenceRunnerMode({ ...process.env, CLARA_PROSPECT_SEQUENCES: undefined }), "shadow");
  assert.equal(sequenceRunnerMode({ ...process.env, CLARA_PROSPECT_SEQUENCES: "active" }), "active");
  assert.equal(sequenceRunnerMode({ ...process.env, CLARA_PROSPECT_SEQUENCES: "off" }), "off");
  assert.equal(sequenceRunnerMode({ ...process.env, CLARA_PROSPECT_SEQUENCES: "garbage" }), "shadow");
});

test("sequenceRunnerTick: off mode never even fetches due enrollments", async () => {
  process.env.CLARA_PROSPECT_SEQUENCES = "off";
  try {
    let called = false;
    const deps = fakeDeps({ fetchDueEnrollments: async () => { called = true; return []; } });
    const r = await sequenceRunnerTick(deps);
    assert.equal(r.mode, "off");
    assert.equal(called, false);
  } finally {
    delete process.env.CLARA_PROSPECT_SEQUENCES;
  }
});

test("sequenceRunnerTick: tallies outcomes across every due enrollment", async () => {
  process.env.CLARA_PROSPECT_SEQUENCES = "active";
  try {
    const deps = fakeDeps({
      fetchDueEnrollments: async () => [dueEmail({ enrollment_id: "e1" }), dueEmail({ enrollment_id: "e2" }), dueEmail({ enrollment_id: "e3", channel: "task" })],
    });
    const r = await sequenceRunnerTick(deps);
    assert.equal(r.due, 3);
    assert.equal(r.sent, 2);
    assert.equal(r.taskCreated, 1);
  } finally {
    delete process.env.CLARA_PROSPECT_SEQUENCES;
  }
});
