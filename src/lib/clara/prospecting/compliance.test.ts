import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MEGA_DOMAINS, domainSize, OPTOUT_RE, isOptOutReply, unsubMailto, appendOptOut,
  isRoleAddress, sendGate, checkSuppressed, checkEmailQuota, DEFAULT_EMAIL_QUOTAS,
  type SuppressionCheckDeps,
} from "./compliance";

// ── FRIDAY parity (ported verbatim — these assertions mirror FRIDAY's own outreach.ts tests in
// spirit: same inputs, same outputs, so a future drift between the two copies is caught here) ────

test("domainSize: a known mega domain, or a subdomain of one, is 'large'", () => {
  assert.equal(domainSize("hubspot.com"), "large");
  assert.equal(domainSize("blog.hubspot.com"), "large");
  assert.equal(domainSize("www.stripe.com"), "large");
});
test("domainSize: an unknown domain is 'unknown', never guessed as small/mid", () => {
  assert.equal(domainSize("acmeroofing.com"), "unknown");
});
test("MEGA_DOMAINS contains the household names the list was seeded with", () => {
  for (const d of ["google.com", "amazon.com", "linkedin.com", "anthropic.com"]) assert.ok(MEGA_DOMAINS.has(d));
});

test("isOptOutReply: matches unsubscribe/stop/remove-me language, case-insensitive", () => {
  assert.ok(isOptOutReply("Re: your email", "please unsubscribe me"));
  assert.ok(isOptOutReply("STOP", ""));
  assert.ok(isOptOutReply("", "take me off this list"));
  assert.equal(OPTOUT_RE.test("not interested but keep going"), false);
});
test("isOptOutReply: ordinary replies don't false-positive", () => {
  assert.equal(isOptOutReply("Re: pricing question", "what's the cost?"), false);
});

test("unsubMailto: builds a mailto with the domain in the subject", () => {
  assert.equal(unsubMailto("clara@example.com", { domain: "acme.com" }), "mailto:clara@example.com?subject=unsubscribe%20acme.com");
});
test("appendOptOut: appends a STOP footer with the given from-address", () => {
  const out = appendOptOut("Hi Jane, following up.", "clara@example.com");
  assert.match(out, /reply STOP/);
  assert.match(out, /clara@example\.com/);
});

// ── Role addresses ───────────────────────────────────────────────────────────────────────────

test("isRoleAddress: recognizes common role local-parts", () => {
  for (const addr of ["info@acme.com", "sales@acme.com", "noreply@acme.com", "Support@Acme.com"]) {
    assert.ok(isRoleAddress(addr), addr);
  }
});
test("isRoleAddress: a personal address is not a role address", () => {
  assert.equal(isRoleAddress("jane.smith@acme.com"), false);
});

// ── sendGate ─────────────────────────────────────────────────────────────────────────────────

function gateInput(overrides: Partial<Parameters<typeof sendGate>[0]> = {}): Parameters<typeof sendGate>[0] {
  return { email: "jane@acmeroofing.com", verificationStatus: "verified", isOnlyAddress: false, allowRole: false, ...overrides };
}

test("sendGate: a mega-domain address is always refused, even if verified", () => {
  const d = sendGate(gateInput({ email: "jane@hubspot.com" }));
  assert.equal(d.ok, false);
  assert.equal(d.reason, "mega_domain");
});
test("sendGate: a role address is refused unless it's the only address AND allow_role", () => {
  assert.equal(sendGate(gateInput({ email: "info@acmeroofing.com" })).reason, "role_address");
  assert.equal(sendGate(gateInput({ email: "info@acmeroofing.com", isOnlyAddress: true, allowRole: false })).reason, "role_address");
  assert.equal(sendGate(gateInput({ email: "info@acmeroofing.com", isOnlyAddress: true, allowRole: true })).ok, true);
});
test("sendGate: an unsendable verification status is refused", () => {
  for (const status of ["risky", "invalid", "unknown"] as const) {
    assert.equal(sendGate(gateInput({ verificationStatus: status })).reason, "not_sendable");
  }
});
test("sendGate: verified/likely_valid/catch_all personal addresses on an ordinary domain pass", () => {
  for (const status of ["verified", "likely_valid", "catch_all"] as const) {
    assert.equal(sendGate(gateInput({ verificationStatus: status })).ok, true);
  }
});

// ── checkSuppressed (thin wrapper over osBridge.suppressionsCheck) ──────────────────────────────

test("checkSuppressed: passes channel/email/phone/domain/company/contact straight through", async () => {
  let args: unknown;
  const deps: SuppressionCheckDeps = { suppressionsCheck: async (a) => { args = a; return { blocked: true, hits: [{ reason: "unsubscribe" }] }; } };
  const r = await checkSuppressed({ channel: "email", email: "jane@acme.com", companyId: "co_1" }, deps);
  assert.equal(r.blocked, true);
  assert.deepEqual(args, { channel: "email", email: "jane@acme.com", phone: undefined, domain: undefined, company_id: "co_1", contact_id: undefined });
});

// ── Quotas ───────────────────────────────────────────────────────────────────────────────────

test("checkEmailQuota: defaults match the plan (global 50/day, contact 1/day, company 1/day & 3/week)", () => {
  assert.deepEqual(DEFAULT_EMAIL_QUOTAS, { globalPerDay: 50, contactPerDay: 1, companyPerDay: 1, companyPerWeek: 3 });
});
test("checkEmailQuota: global cap is checked first and wins even if a narrower cap is also hit", () => {
  const d = checkEmailQuota({ globalToday: 50, contactToday: 1, companyToday: 1, companyThisWeek: 3 });
  assert.equal(d.blocked, true);
  assert.equal(d.reason, "global_daily_cap");
});
test("checkEmailQuota: contact daily cap", () => {
  const d = checkEmailQuota({ globalToday: 0, contactToday: 1, companyToday: 0, companyThisWeek: 0 });
  assert.deepEqual(d, { blocked: true, reason: "contact_daily_cap" });
});
test("checkEmailQuota: company daily cap", () => {
  const d = checkEmailQuota({ globalToday: 0, contactToday: 0, companyToday: 1, companyThisWeek: 0 });
  assert.deepEqual(d, { blocked: true, reason: "company_daily_cap" });
});
test("checkEmailQuota: company weekly cap", () => {
  const d = checkEmailQuota({ globalToday: 0, contactToday: 0, companyToday: 0, companyThisWeek: 3 });
  assert.deepEqual(d, { blocked: true, reason: "company_weekly_cap" });
});
test("checkEmailQuota: under every cap passes", () => {
  assert.deepEqual(checkEmailQuota({ globalToday: 49, contactToday: 0, companyToday: 0, companyThisWeek: 2 }), { blocked: false });
});
