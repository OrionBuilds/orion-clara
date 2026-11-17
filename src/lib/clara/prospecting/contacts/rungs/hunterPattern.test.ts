import { test } from "node:test";
import assert from "node:assert/strict";
import { applyHunterPattern, findDirectMatch, callHunterPattern, type HunterPatternDeps } from "./hunterPattern";
import { cacheKey } from "../../cache";
import type { RungContext } from "../waterfall";
import type { HunterPerson } from "@autom8ionlab/agent-core";

function ctx(overrides: Partial<RungContext> = {}): RungContext {
  return { companyId: "co_1", companyName: "Acme Roofing", fitScore: 80, allowLive: true, domain: "acme.com", person: { fullName: "Jane Smith", firstName: "Jane", lastName: "Smith" }, ...overrides };
}

function person(name: string, first: string, last: string): HunterPerson {
  return { email: `${first.toLowerCase()}.${last.toLowerCase()}@acme.com`, firstName: first, lastName: last, sources: [] };
}

test("applyHunterPattern: {first}.{last} substitutes and lowercases", () => {
  assert.equal(applyHunterPattern("{first}.{last}", { fullName: "Jane Smith" }, "acme.com"), "jane.smith@acme.com");
});
test("applyHunterPattern: {f}{last} (first-initial) substitutes", () => {
  assert.equal(applyHunterPattern("{f}{last}", { fullName: "Jane Smith" }, "acme.com"), "jsmith@acme.com");
});
test("applyHunterPattern: an unrecognized token bails rather than guessing", () => {
  assert.equal(applyHunterPattern("{nickname}", { fullName: "Jane Smith" }, "acme.com"), undefined);
});
test("applyHunterPattern: a single-word name (no last name) bails", () => {
  assert.equal(applyHunterPattern("{first}.{last}", { fullName: "Madonna" }, "acme.com"), undefined);
});

test("findDirectMatch: matches on first+last name, case-insensitive", () => {
  const people = [person("x", "Bob", "Jones"), person("x", "Jane", "Smith")];
  const m = findDirectMatch(people, { fullName: "jane smith" });
  assert.equal(m?.email, "jane.smith@acme.com");
});
test("findDirectMatch: no match returns undefined", () => {
  assert.equal(findDirectMatch([person("x", "Bob", "Jones")], { fullName: "Jane Smith" }), undefined);
});

function fakeDeps(overrides: Partial<HunterPatternDeps> = {}): HunterPatternDeps {
  return {
    hunterDomainSearch: { provider: "hunter", call: async () => ({ ok: false, error: "not called", costUnits: 0 }) },
    loadRates: async () => ({ hunter_find: 0.05 } as never),
    cachedCall: async (args) => {
      if (!args.allowLive) return { cached: false, skipped: true, costUsd: 0 };
      const value = await args.fn();
      return { value, cached: false, costUsd: args.costUsd };
    },
    cacheKey,
    ...overrides,
  };
}

test("callHunterPattern: not_configured when CLARA_HUNTER_API_KEY is unset", async () => {
  delete process.env.CLARA_HUNTER_API_KEY;
  const r = await callHunterPattern(ctx(), fakeDeps());
  assert.equal(r.hit, false);
  if (!r.hit) assert.equal(r.reason, "not_configured");
});

test("callHunterPattern: a direct name match on the domain-search response is a hit", async () => {
  process.env.CLARA_HUNTER_API_KEY = "test-key";
  try {
    const deps = fakeDeps({
      hunterDomainSearch: { provider: "hunter", call: async () => ({ ok: true, costUnits: 1, status: 200, raw: {}, data: { people: [person("x", "Jane", "Smith")] } }) },
    });
    const r = await callHunterPattern(ctx(), deps);
    assert.equal(r.hit, true);
    if (r.hit) { assert.equal(r.value, "jane.smith@acme.com"); assert.equal(r.verificationStatus, "likely_valid"); }
  } finally {
    delete process.env.CLARA_HUNTER_API_KEY;
  }
});

test("callHunterPattern: a pattern with >=2 confirmations constructs the target's address", async () => {
  process.env.CLARA_HUNTER_API_KEY = "test-key";
  try {
    const deps = fakeDeps({
      hunterDomainSearch: {
        provider: "hunter",
        call: async () => ({ ok: true, costUnits: 1, status: 200, raw: {}, data: { pattern: "{first}.{last}", people: [person("x", "Bob", "Jones"), person("x", "Amy", "Lee")] } }),
      },
    });
    const r = await callHunterPattern(ctx(), deps); // target is Jane Smith, not in the people list
    assert.equal(r.hit, true);
    if (r.hit) assert.equal(r.value, "jane.smith@acme.com");
  } finally {
    delete process.env.CLARA_HUNTER_API_KEY;
  }
});

test("callHunterPattern: a pattern with only 1 confirmation is NOT trusted (the plan's >=2 rule)", async () => {
  process.env.CLARA_HUNTER_API_KEY = "test-key";
  try {
    const deps = fakeDeps({
      hunterDomainSearch: { provider: "hunter", call: async () => ({ ok: true, costUnits: 1, status: 200, raw: {}, data: { pattern: "{first}.{last}", people: [person("x", "Bob", "Jones")] } }) },
    });
    const r = await callHunterPattern(ctx(), deps);
    assert.equal(r.hit, false);
  } finally {
    delete process.env.CLARA_HUNTER_API_KEY;
  }
});

test("callHunterPattern: shadow mode (allowLive false) never calls Hunter", async () => {
  process.env.CLARA_HUNTER_API_KEY = "test-key";
  try {
    let called = false;
    const deps = fakeDeps({ hunterDomainSearch: { provider: "hunter", call: async () => { called = true; return { ok: false, error: "x", costUnits: 0 }; } } });
    const r = await callHunterPattern(ctx({ allowLive: false }), deps);
    assert.equal(r.hit, false);
    assert.equal(called, false);
  } finally {
    delete process.env.CLARA_HUNTER_API_KEY;
  }
});
