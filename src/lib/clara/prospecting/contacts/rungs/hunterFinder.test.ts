import { test } from "node:test";
import assert from "node:assert/strict";
import { callHunterFinder, type HunterFinderDeps } from "./hunterFinder";
import { cacheKey } from "../../cache";
import type { RungContext } from "../waterfall";

function ctx(overrides: Partial<RungContext> = {}): RungContext {
  return { companyId: "co_1", companyName: "Acme Roofing", fitScore: 80, allowLive: true, domain: "acme.com", person: { fullName: "Jane Smith" }, ...overrides };
}

function fakeDeps(overrides: Partial<HunterFinderDeps> = {}): HunterFinderDeps {
  return {
    hunterEmailFinder: { provider: "hunter", call: async () => ({ ok: false, error: "not called", costUnits: 0 }) },
    loadRates: async () => ({ hunter_find: 0.05 } as never),
    cachedCall: async (args) => (args.allowLive ? { value: await args.fn(), cached: false, costUsd: args.costUsd } : { cached: false, skipped: true, costUsd: 0 }),
    cacheKey,
    ...overrides,
  };
}

test("not_configured when CLARA_HUNTER_API_KEY is unset", async () => {
  delete process.env.CLARA_HUNTER_API_KEY;
  const r = await callHunterFinder(ctx(), fakeDeps());
  assert.equal(r.hit, false);
  if (!r.hit) assert.equal(r.reason, "not_configured");
});

test("a deliverable find is a hit capped at likely_valid", async () => {
  process.env.CLARA_HUNTER_API_KEY = "test-key";
  try {
    const deps = fakeDeps({ hunterEmailFinder: { provider: "hunter", call: async () => ({ ok: true, costUnits: 0.05, status: 200, raw: {}, data: { email: "jane@acme.com", score: 80, verdict: "deliverable", sources: [] } }) } });
    const r = await callHunterFinder(ctx(), deps);
    assert.equal(r.hit, true);
    if (r.hit) { assert.equal(r.value, "jane@acme.com"); assert.equal(r.verificationStatus, "likely_valid"); assert.equal(r.confidence, 0.8); }
  } finally {
    delete process.env.CLARA_HUNTER_API_KEY;
  }
});

test("an undeliverable verdict is refused outright", async () => {
  process.env.CLARA_HUNTER_API_KEY = "test-key";
  try {
    const deps = fakeDeps({ hunterEmailFinder: { provider: "hunter", call: async () => ({ ok: true, costUnits: 0.05, status: 200, raw: {}, data: { email: "jane@acme.com", verdict: "undeliverable", sources: [] } }) } });
    const r = await callHunterFinder(ctx(), deps);
    assert.equal(r.hit, false);
  } finally {
    delete process.env.CLARA_HUNTER_API_KEY;
  }
});

test("a single-word name has no usable first/last name — refused before any call", async () => {
  process.env.CLARA_HUNTER_API_KEY = "test-key";
  try {
    let called = false;
    const deps = fakeDeps({ hunterEmailFinder: { provider: "hunter", call: async () => { called = true; return { ok: false, error: "x", costUnits: 0 }; } } });
    const r = await callHunterFinder(ctx({ person: { fullName: "Madonna" } }), deps);
    assert.equal(r.hit, false);
    assert.equal(called, false);
  } finally {
    delete process.env.CLARA_HUNTER_API_KEY;
  }
});
