import { test } from "node:test";
import assert from "node:assert/strict";
import { currentSpendContext, toOsProviderRequest, withSpendContext, type ProviderCallRecord } from "./ledger";

const base: ProviderCallRecord = { id: "x", ts: "2026-10-08T00:00:00Z", provider: "places", costUsd: 0.315, cached: false, status: "ok" };

test("toOsProviderRequest: uses the OS field names — job_id (not research_job_id) and an integer status", () => {
  const r = toOsProviderRequest({ ...base, jobId: "22222222-2222-4222-8222-222222222222", companyId: "c1", cacheKey: "k" });
  assert.equal(r.job_id, "22222222-2222-4222-8222-222222222222");
  assert.equal(r.company_id, "c1");
  assert.equal(r.status, 200);
  assert.equal(r.cost_usd, 0.315);
  assert.equal("research_job_id" in r, false);
});

test("toOsProviderRequest: errors map to 500 and omit absent ids", () => {
  const r = toOsProviderRequest({ ...base, status: "error", error: "402 out of credit", costUsd: 0 });
  assert.equal(r.status, 500);
  assert.equal(r.error, "402 out of credit");
  assert.equal("job_id" in r, false);
  assert.equal("company_id" in r, false);
});

test("withSpendContext: the job id is visible to code deep inside the handler, and only there", async () => {
  assert.equal(currentSpendContext(), undefined);
  const seen = await withSpendContext({ jobId: "j1", companyId: "c1" }, async () => {
    await new Promise((r) => setTimeout(r, 1));
    return currentSpendContext();
  });
  assert.deepEqual(seen, { jobId: "j1", companyId: "c1" });
  assert.equal(currentSpendContext(), undefined);
});
