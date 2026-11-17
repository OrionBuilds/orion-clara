import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateJob, type Rates } from "./estimator";
import { normalizeJobSpec } from "./jobSpec";
import { DEFAULT_PRIORS } from "./priors";

const RATES: Rates = {
  places_search: 0.035, brave_query: 0.005, exa_query: 0, jina_read: 0, http_fetch: 0, dns_lookup: 0,
  hunter_verify: 0.02, hunter_find: 0.05, leadmagic_email: 0.03, leadmagic_mobile: 0.2,
  llm_t1_call: 0, llm_t2_call_lmstudio: 0, llm_t2_call_haiku: 0.004, llm_t3_call: 0.015,
  seconds_per_local_call: 12, seconds_per_cloud_call: 3,
  calls_per_company_t1: 1, calls_per_company_t2: 2, t3_share_of_qualified: 0.1,
  queries_per_cell: 3, places_pages_per_cell: 2, unique_companies_per_cell: 35, email_paid_share: 0.6,
};

function spec(overrides: Record<string, unknown> = {}) {
  const r = normalizeJobSpec({ industry: ["roofing"], location: { label: "Tampa, FL", radius_miles: 100 }, ...overrides });
  assert.equal(r.ok, true, r.errors.join("; "));
  return r.spec!;
}

test("estimateJob: a basic job has positive cost, cells and ETA", () => {
  const e = estimateJob(spec(), RATES, DEFAULT_PRIORS);
  assert.ok(e.assumptions.cells > 0);
  assert.ok(e.discovery > 0);
  assert.ok(e.total > 0);
  assert.ok(e.eta_hours >= 0);
  assert.equal(e.total, Math.round((e.discovery + e.web_research + e.ai + e.email_lookup + e.mobile_lookup) * 100) / 100);
});

test("estimateJob: asking for email+mobile costs strictly more than the website-only default", () => {
  const base = estimateJob(spec(), RATES, DEFAULT_PRIORS);
  const withContacts = estimateJob(spec({ enrichments: ["website", "owner", "email", "mobile"] }), RATES, DEFAULT_PRIORS);
  assert.ok(withContacts.total > base.total);
  assert.ok(withContacts.email_lookup > 0);
  assert.ok(withContacts.mobile_lookup > 0);
});

test("estimateJob: a bigger radius means more cells and a bigger discovery estimate", () => {
  const small = estimateJob(spec({ location: { label: "Tampa", radius_miles: 25 } }), RATES, DEFAULT_PRIORS);
  const big = estimateJob(spec({ location: { label: "Tampa", radius_miles: 150 } }), RATES, DEFAULT_PRIORS);
  assert.ok(big.assumptions.cells > small.assumptions.cells);
  assert.ok(big.discovery > small.discovery);
});

test("estimateJob: tier2=haiku moves calls to the cloud count and changes AI cost", () => {
  const local = estimateJob(spec(), RATES, DEFAULT_PRIORS, "lmstudio");
  const cloud = estimateJob(spec(), RATES, DEFAULT_PRIORS, "haiku");
  assert.notEqual(local.ai, cloud.ai);
  assert.equal(cloud.assumptions.tier2_engine, "haiku");
});

test("estimateJob: max_records caps the discovered count even with a huge radius", () => {
  const e = estimateJob(spec({ max_records: 10, location: { label: "Tampa", radius_miles: 300 } }), RATES, DEFAULT_PRIORS);
  assert.ok(e.assumptions.expected.discovered <= 10);
});

test("estimateJob: discovery is cells x queries x rate — every query runs in every cell", () => {
  const two = estimateJob(spec({ queries: ["a", "b"], sources: ["places", "brave"] }), RATES, DEFAULT_PRIORS);
  const eight = estimateJob(spec({ queries: ["a", "b", "c", "d", "e", "f", "g", "h"], sources: ["places", "brave"] }), RATES, DEFAULT_PRIORS);
  const cells = eight.assumptions.cells;
  assert.equal(eight.discovery, Math.round(cells * 8 * (RATES.places_search + RATES.brave_query) * 100) / 100);
  assert.ok(Math.abs(eight.discovery - 4 * two.discovery) < 0.05);
});

test("estimateJob: with LM Studio down (haiku) tier-1 classify is priced, not free", () => {
  const local = estimateJob(spec(), { ...RATES, llm_t1_call_haiku: 0.002 }, DEFAULT_PRIORS, "lmstudio");
  const cloud = estimateJob(spec(), { ...RATES, llm_t1_call_haiku: 0.002, llm_t2_call_haiku: 0 }, DEFAULT_PRIORS, "haiku");
  assert.ok(cloud.ai > local.ai);
  assert.equal(cloud.assumptions.local_calls, 0);
});
