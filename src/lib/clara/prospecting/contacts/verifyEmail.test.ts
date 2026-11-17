import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyEmail, type VerifyEmailDeps } from "./verifyEmail";
import { cacheKey } from "../cache";

function fakeDeps(overrides: Partial<VerifyEmailDeps> = {}): VerifyEmailDeps {
  return {
    hunterEmailVerifier: { provider: "hunter", call: async () => ({ ok: false, error: "not called", costUnits: 0 }) },
    leadmagicEmailValidate: { provider: "leadmagic", call: async () => ({ ok: false, error: "not called", costUnits: 0 }) },
    loadRates: async () => ({ hunter_verify: 0.02, leadmagic_email: 0.03 } as never),
    cachedCall: async (args) => (args.allowLive ? { value: await args.fn(), cached: false, costUsd: args.costUsd } : { cached: false, skipped: true, costUsd: 0 }),
    cacheKey,
    ...overrides,
  };
}

test("neither provider configured: keeps the fallback status, costs nothing, attempted=false", async () => {
  delete process.env.CLARA_HUNTER_API_KEY;
  delete process.env.CLARA_LEADMAGIC_API_KEY;
  const r = await verifyEmail("jane@acme.com", { allowLive: true, fallbackStatus: "likely_valid" }, fakeDeps());
  assert.deepEqual(r, { status: "likely_valid", costUsd: 0, attempted: false });
});

test("Hunter deliverable (not accept_all) -> verified, tried first when both are configured", async () => {
  process.env.CLARA_HUNTER_API_KEY = "hk";
  process.env.CLARA_LEADMAGIC_API_KEY = "lk";
  try {
    let leadmagicCalled = false;
    const deps = fakeDeps({
      hunterEmailVerifier: { provider: "hunter", call: async () => ({ ok: true, costUnits: 0.02, status: 200, raw: {}, data: { email: "jane@acme.com", verdict: "deliverable", status: "valid", acceptAll: false } }) },
      leadmagicEmailValidate: { provider: "leadmagic", call: async () => { leadmagicCalled = true; return { ok: false, error: "unreachable", costUnits: 0 }; } },
    });
    const r = await verifyEmail("jane@acme.com", { allowLive: true, fallbackStatus: "unknown" }, deps);
    assert.equal(r.status, "verified");
    assert.equal(r.verifier, "hunter");
    assert.equal(leadmagicCalled, false);
  } finally {
    delete process.env.CLARA_HUNTER_API_KEY;
    delete process.env.CLARA_LEADMAGIC_API_KEY;
  }
});

test("Hunter accept_all -> catch_all", async () => {
  process.env.CLARA_HUNTER_API_KEY = "hk";
  try {
    const deps = fakeDeps({ hunterEmailVerifier: { provider: "hunter", call: async () => ({ ok: true, costUnits: 0.02, status: 200, raw: {}, data: { email: "jane@acme.com", verdict: "deliverable", acceptAll: true } }) } });
    const r = await verifyEmail("jane@acme.com", { allowLive: true, fallbackStatus: "unknown" }, deps);
    assert.equal(r.status, "catch_all");
  } finally {
    delete process.env.CLARA_HUNTER_API_KEY;
  }
});

test("Hunter undeliverable -> invalid", async () => {
  process.env.CLARA_HUNTER_API_KEY = "hk";
  try {
    const deps = fakeDeps({ hunterEmailVerifier: { provider: "hunter", call: async () => ({ ok: true, costUnits: 0.02, status: 200, raw: {}, data: { email: "jane@acme.com", verdict: "undeliverable" } }) } });
    const r = await verifyEmail("jane@acme.com", { allowLive: true, fallbackStatus: "unknown" }, deps);
    assert.equal(r.status, "invalid");
  } finally {
    delete process.env.CLARA_HUNTER_API_KEY;
  }
});

test("only LeadMagic configured: valid -> verified, catch_all -> catch_all, invalid -> invalid", async () => {
  process.env.CLARA_LEADMAGIC_API_KEY = "lk";
  try {
    for (const [verdict, expected] of [["deliverable", "verified"], ["catch_all", "catch_all"], ["undeliverable", "invalid"]] as const) {
      const deps = fakeDeps({ leadmagicEmailValidate: { provider: "leadmagic", call: async () => ({ ok: true, costUnits: 0.03, status: 200, raw: {}, data: { email: "jane@acme.com", verdict, credits: 1 } }) } });
      const r = await verifyEmail("jane@acme.com", { allowLive: true, fallbackStatus: "unknown" }, deps);
      assert.equal(r.status, expected, `verdict ${verdict}`);
      assert.equal(r.verifier, "leadmagic");
    }
  } finally {
    delete process.env.CLARA_LEADMAGIC_API_KEY;
  }
});

test("shadow mode (allowLive false): no provider is actually called, fallback status kept", async () => {
  process.env.CLARA_HUNTER_API_KEY = "hk";
  try {
    let called = false;
    const deps = fakeDeps({ hunterEmailVerifier: { provider: "hunter", call: async () => { called = true; return { ok: false, error: "x", costUnits: 0 }; } } });
    const r = await verifyEmail("jane@acme.com", { allowLive: false, fallbackStatus: "likely_valid" }, deps);
    assert.equal(called, false);
    assert.equal(r.status, "likely_valid");
    assert.equal(r.attempted, false);
  } finally {
    delete process.env.CLARA_HUNTER_API_KEY;
  }
});
