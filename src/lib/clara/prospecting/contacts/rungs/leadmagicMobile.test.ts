import { test } from "node:test";
import assert from "node:assert/strict";
import { callLeadmagicMobile, type LeadmagicMobileDeps } from "./leadmagicMobile";
import { cacheKey } from "../../cache";
import type { RungContext } from "../waterfall";

function ctx(overrides: Partial<RungContext> = {}): RungContext {
  return { companyId: "co_1", companyName: "Acme Roofing", fitScore: 90, allowLive: true, email: "jane@acme.com", ...overrides };
}

function fakeDeps(overrides: Partial<LeadmagicMobileDeps> = {}): LeadmagicMobileDeps {
  return {
    leadmagicMobileFinder: { provider: "leadmagic", call: async () => ({ ok: false, error: "not called", costUnits: 0 }) },
    loadRates: async () => ({ leadmagic_mobile: 0.2 } as never),
    cachedCall: async (args) => (args.allowLive ? { value: await args.fn(), cached: false, costUsd: args.costUsd } : { cached: false, skipped: true, costUsd: 0 }),
    cacheKey,
    ...overrides,
  };
}

test("not_configured when CLARA_LEADMAGIC_API_KEY is unset", async () => {
  delete process.env.CLARA_LEADMAGIC_API_KEY;
  const r = await callLeadmagicMobile(ctx(), fakeDeps());
  assert.equal(r.hit, false);
  if (!r.hit) assert.equal(r.reason, "not_configured");
});

test("no email and no LinkedIn profile — refused before any call", async () => {
  process.env.CLARA_LEADMAGIC_API_KEY = "test-key";
  try {
    let called = false;
    const deps = fakeDeps({ leadmagicMobileFinder: { provider: "leadmagic", call: async () => { called = true; return { ok: false, error: "x", costUnits: 0 }; } } });
    const r = await callLeadmagicMobile(ctx({ email: undefined, person: undefined }), deps);
    assert.equal(r.hit, false);
    assert.equal(called, false);
  } finally {
    delete process.env.CLARA_LEADMAGIC_API_KEY;
  }
});

test("a found mobile is a hit, kind=mobile, status likely_valid", async () => {
  process.env.CLARA_LEADMAGIC_API_KEY = "test-key";
  try {
    const deps = fakeDeps({ leadmagicMobileFinder: { provider: "leadmagic", call: async () => ({ ok: true, costUnits: 0.2, status: 200, raw: {}, data: { mobile: "+18135551234", credits: 1 } }) } });
    const r = await callLeadmagicMobile(ctx(), deps);
    assert.equal(r.hit, true);
    if (r.hit) { assert.equal(r.kind, "mobile"); assert.equal(r.value, "+18135551234"); assert.equal(r.verificationStatus, "likely_valid"); }
  } finally {
    delete process.env.CLARA_LEADMAGIC_API_KEY;
  }
});
