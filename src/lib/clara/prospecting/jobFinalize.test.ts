import { test } from "node:test";
import assert from "node:assert/strict";
import { ensureJobList, addToJobList, finalizeJobs, resetFinalizeState, type FinalizeDeps } from "./jobFinalize";
import type { Job } from "./types";

function job(over: Partial<Job> = {}): Job {
  return { id: "11111111-1111-1111-1111-111111111111", title: "HVAC – Tampa", status: "running", ...over } as Job;
}

function fakes(over: Partial<FinalizeDeps> = {}) {
  const calls = { created: 0, added: [] as string[], updates: [] as Record<string, unknown>[], delivered: 0 };
  const deps: FinalizeDeps = {
    listResearchJobs: async () => [],
    updateResearchJob: async (_id, patch) => { calls.updates.push(patch); return job(); },
    prospectListsCreate: async () => { calls.created++; await new Promise((r) => setTimeout(r, 5)); return { id: "list-1" }; },
    prospectListsList: async () => [],
    prospectListsAddMembers: async (a) => { calls.added.push(...a.members.map((m) => m.company_id)); return {}; },
    researchJobReconcile: async (id) => ({ job_id: id, status: "completed", open_tasks: 0, spend_usd: 1, counts: {} }),
    companiesSearch: async () => [{ name: "Cool Air", fit_score: 80 }],
    deliverJobReport: async () => { calls.delivered++; return { ok: true, docUrl: "https://docs/x" }; },
    ...over,
  };
  return { deps, calls };
}

test("ensureJobList creates one list per job even under concurrent qualify tasks, and writes it back", async () => {
  resetFinalizeState();
  const { deps, calls } = fakes();
  const j = job();
  const ids = await Promise.all([ensureJobList(j, deps), ensureJobList(j, deps), ensureJobList(j, deps)]);
  assert.deepEqual(ids, ["list-1", "list-1", "list-1"]);
  assert.equal(calls.created, 1);
  assert.deepEqual(calls.updates[0], { list_id: "list-1" });
});

test("ensureJobList reuses an existing list whose origin is the job", async () => {
  resetFinalizeState();
  const { deps, calls } = fakes({ prospectListsList: async () => [{ id: "list-old", origin_job: { id: job().id } }] });
  assert.equal(await ensureJobList(job(), deps), "list-old");
  assert.equal(calls.created, 0);
});

test("addToJobList adds the company and never throws", async () => {
  resetFinalizeState();
  const { deps, calls } = fakes();
  await addToJobList(job(), "co-1", "qualified", deps);
  assert.deepEqual(calls.added, ["co-1"]);
  const broken = fakes({ prospectListsCreate: async () => { throw new Error("os down"); } });
  await addToJobList(job(), "co-2", "qualified", broken.deps); // no throw
});

test("finalizeJobs reports a drained running job and records the report url", async () => {
  resetFinalizeState();
  const { deps, calls } = fakes({ listResearchJobs: async (a) => (a?.status === "running" ? [job()] : []) });
  const notes = await finalizeJobs(deps);
  assert.equal(calls.delivered, 1);
  assert.ok(calls.updates.some((u) => u.report_url === "https://docs/x"));
  assert.match(notes[0], /reported HVAC/);
});

test("finalizeJobs leaves a job with open tasks alone", async () => {
  resetFinalizeState();
  const { deps, calls } = fakes({
    listResearchJobs: async (a) => (a?.status === "running" ? [job()] : []),
    researchJobReconcile: async (id) => ({ job_id: id, status: "running", open_tasks: 4, spend_usd: 0, counts: {} }),
  });
  await finalizeJobs(deps);
  assert.equal(calls.delivered, 0);
});

test("a completed job without a report is retried at most 3 times", async () => {
  resetFinalizeState();
  const done = job({ status: "completed", finished_at: new Date().toISOString(), report_url: null });
  const { deps, calls } = fakes({
    listResearchJobs: async (a) => (a?.status === "completed" ? [done] : []),
    deliverJobReport: async () => { calls.delivered++; return { ok: false, error: "drive down" }; },
  });
  for (let i = 0; i < 5; i++) await finalizeJobs(deps);
  assert.equal(calls.delivered, 3);
});
