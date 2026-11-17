import { test } from "node:test";
import assert from "node:assert/strict";
import { callLeadmagicEmail, type LeadmagicEmailDeps } from "./leadmagic";
import { cacheKey } from "../../cache";
import type { RungContext } from "../waterfall";

function ctx(overrides: Partial<RungContext> = {}): RungContext {
  return { companyId: "co_1", companyName: "Acme Roofing", fitScore: 80, allowLive: true, domain: "acme.com", person: { fullName: "Jane Smith", firstName: "Jane", lastName: "Smith" }, ...overrides };
}

function fakeDeps(overrides: Partial<LeadmagicEmailDeps> = {}): LeadmagicEmailDeps {
  return {
    leadmagicEmailFinder: { provider: "leadmagic", call: async () => ({ ok: false, error: "not called", costUnits: 0 }) },
    loadRates: async () => ({ leadmagic_email: 0.03 } as never),
    cachedCall: async (args) => (args.allowLive ? { value: await args.fn(), cached: false, costUsd: args.costUsd } : { cached: false, skipped: true, costUsd: 0 }),
    cacheKey,
    ...overrides,
  };
}

test("not_configured when CLARA_LEADMAGIC_API_KEY is unset", async () => {
  delete process.env.CLARA_LEADMAGIC_API_KEY;
  const r = await callLeadmagicEmail(ctx(), fakeDeps());
  assert.equal(r.hit, false);
  if (!r.hit) assert.equal(r.reason, "not_configured");
});

test("a deliverable finder result is a hit, status capped at likely_valid (finder-only)", async () => {
  process.env.CLARA_LEADMAGIC_API_KEY = "test-key";
  try {
    const deps = fakeDeps({ leadmagicEmailFinder: { provider: "leadmagic", call: async () => ({ ok: true, costUnits: 0.03, status: 200, raw: {}, data: { email: "jane@acme.com", status: "valid", verdict: "deliverable", credits: 1 } }) } });
    const r = await callLeadmagicEmail(ctx(), deps);
    assert.equal(r.hit, true);
    if (r.hit) { assert.equal(r.value, "jane@acme.com"); assert.equal(r.verificationStatus, "likely_valid"); }
  } finally {
    delete process.env.CLARA_LEADMAGIC_API_KEY;
  }
});

test("a domain-mismatch result is refused, never written", async () => {
  process.env.CLARA_LEADMAGIC_API_KEY = "test-key";
  try {
    const deps = fakeDeps({ leadmagicEmailFinder: { provider: "leadmagic", call: async () => ({ ok: true, costUnits: 0.03, status: 200, raw: {}, data: { email: "jane@other.com", verdict: "deliverable", domainMismatch: true, credits: 1 } }) } });
    const r = await callLeadmagicEmail(ctx(), deps);
    assert.equal(r.hit, false);
  } finally {
    delete process.env.CLARA_LEADMAGIC_API_KEY;
  }
});

test("an undeliverable verdict is a miss, not a bad write", async () => {
  process.env.CLARA_LEADMAGIC_API_KEY = "test-key";
  try {
    const deps = fakeDeps({ leadmagicEmailFinder: { provider: "leadmagic", call: async () => ({ ok: true, costUnits: 0.03, status: 200, raw: {}, data: { email: "jane@acme.com", verdict: "undeliverable", credits: 1 } }) } });
    const r = await callLeadmagicEmail(ctx(), deps);
    assert.equal(r.hit, false);
  } finally {
    delete process.env.CLARA_LEADMAGIC_API_KEY;
  }
});

test("callLeadmagicEmail: refuses cleanly without a target person, even if the key is set", async () => {
  process.env.CLARA_LEADMAGIC_API_KEY = "test-key";
  try {
    const r = await callLeadmagicEmail(ctx({ person: undefined }), fakeDeps());
    assert.equal(r.hit, false);
    if (!r.hit) assert.equal(r.reason, "no target person");
  } finally {
    delete process.env.CLARA_LEADMAGIC_API_KEY;
  }
});
