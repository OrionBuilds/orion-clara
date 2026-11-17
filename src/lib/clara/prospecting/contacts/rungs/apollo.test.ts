import { test } from "node:test";
import assert from "node:assert/strict";
import { callApollo, apolloPeopleMatch, type ApolloDeps } from "./apollo";
import { cacheKey } from "../../cache";
import type { RungContext } from "../waterfall";

function ctx(overrides: Partial<RungContext> = {}): RungContext {
  return { companyId: "co_1", companyName: "Acme Roofing", fitScore: 80, allowLive: true, domain: "acme.com", person: { fullName: "Jane Smith", firstName: "Jane", lastName: "Smith" }, ...overrides };
}

test("not_configured in this deploy — no CLARA_APOLLO_API_KEY is set anywhere", async () => {
  delete process.env.CLARA_APOLLO_API_KEY;
  const r = await callApollo(ctx());
  assert.equal(r.hit, false);
  if (!r.hit) assert.equal(r.reason, "not_configured");
});

test("if a key WERE configured, a matched email is a hit capped at likely_valid (finder-only)", async () => {
  process.env.CLARA_APOLLO_API_KEY = "test-key";
  try {
    const deps: ApolloDeps = {
      apolloPeopleMatch: async () => ({ email: "jane@acme.com", emailStatus: "verified" }),
      cachedCall: async (args) => (args.allowLive ? { value: await args.fn(), cached: false, costUsd: args.costUsd } : { cached: false, skipped: true, costUsd: 0 }),
      cacheKey,
    };
    const r = await callApollo(ctx(), deps);
    assert.equal(r.hit, true);
    if (r.hit) { assert.equal(r.value, "jane@acme.com"); assert.equal(r.verificationStatus, "likely_valid"); }
  } finally {
    delete process.env.CLARA_APOLLO_API_KEY;
  }
});

test("apolloPeopleMatch: a non-2xx response is a soft error, never throws", async () => {
  const r = await apolloPeopleMatch({ firstName: "Jane" }, { key: "k", fetchImpl: (async () => new Response("nope", { status: 403 })) as unknown as typeof fetch });
  assert.deepEqual(r, { error: "apollo 403" });
});
