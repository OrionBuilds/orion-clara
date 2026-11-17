// jobFinalize.ts — the two pieces the pipeline was missing (2026-10-07):
//
//   1. Every job gets a prospect list, and each company that qualifies (stage 70) joins it. Before
//      this, lists were only ever created by hand in the Office, so the promotion watcher (which
//      scans lists) never promoted anything and the LinkedIn queue (which reads promoted
//      companies) stayed empty.
//   2. A finalizer that, once a running job has no open tasks, reconciles it (the OS flips it to
//      completed and recomputes counts/spend) and delivers the job report. Nothing enqueued the
//      stage-99 report task or ever called research_job_reconcile, so jobs stayed `running` forever.

import {
  listResearchJobs as listResearchJobsReal,
  updateResearchJob as updateResearchJobReal,
  prospectListsCreate as prospectListsCreateReal,
  prospectListsList as prospectListsListReal,
  prospectListsAddMembers as prospectListsAddMembersReal,
  researchJobReconcile as researchJobReconcileReal,
  companiesSearch as companiesSearchReal,
} from "./osBridge";
import { deliverJobReport as deliverJobReportReal } from "./report/deliver";
import { toExportRows } from "./stages";
import type { Job } from "./types";

export interface FinalizeDeps {
  listResearchJobs: typeof listResearchJobsReal;
  updateResearchJob: typeof updateResearchJobReal;
  prospectListsCreate: typeof prospectListsCreateReal;
  prospectListsList: typeof prospectListsListReal;
  prospectListsAddMembers: typeof prospectListsAddMembersReal;
  researchJobReconcile: typeof researchJobReconcileReal;
  companiesSearch: typeof companiesSearchReal;
  deliverJobReport: typeof deliverJobReportReal;
}

export const defaultFinalizeDeps: FinalizeDeps = {
  listResearchJobs: listResearchJobsReal,
  updateResearchJob: updateResearchJobReal,
  prospectListsCreate: prospectListsCreateReal,
  prospectListsList: prospectListsListReal,
  prospectListsAddMembers: prospectListsAddMembersReal,
  researchJobReconcile: researchJobReconcileReal,
  companiesSearch: companiesSearchReal,
  deliverJobReport: deliverJobReportReal,
};

// One in-flight creation per job, so concurrent qualify tasks in a tick can't create two lists.
const pendingLists = new Map<string, Promise<string | undefined>>();

function rowsOf(raw: unknown): Record<string, unknown>[] {
  if (Array.isArray(raw)) return raw as Record<string, unknown>[];
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  for (const k of ["lists", "data", "rows"]) if (Array.isArray(o[k])) return o[k] as Record<string, unknown>[];
  return [];
}

function idOf(raw: unknown): string | undefined {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const inner = (o.list && typeof o.list === "object" ? o.list : o) as Record<string, unknown>;
  return typeof inner.id === "string" ? inner.id : undefined;
}

/** The job's list id — existing, found by origin job, or created (and written back to the job). */
export async function ensureJobList(job: Job, deps: FinalizeDeps = defaultFinalizeDeps): Promise<string | undefined> {
  if (job.list_id) return job.list_id;
  const inflight = pendingLists.get(job.id);
  if (inflight) return inflight;
  const p = (async () => {
    const existing = rowsOf(await deps.prospectListsList({})).find((l) => {
      const origin = l.origin_job as { id?: unknown } | null | undefined;
      return l.origin_job_id === job.id || origin?.id === job.id;
    });
    let id = typeof existing?.id === "string" ? existing.id : undefined;
    if (!id) {
      id = idOf(await deps.prospectListsCreate({
        name: (job.title || `Research ${job.id.slice(0, 8)}`).slice(0, 120),
        description: "Companies this research job qualified.",
        kind: "static",
        origin_job_id: job.id,
      }));
    }
    if (id) {
      await deps.updateResearchJob(job.id, { list_id: id }).catch(() => {});
      job.list_id = id;
    }
    return id;
  })();
  pendingLists.set(job.id, p);
  try {
    return await p;
  } finally {
    pendingLists.delete(job.id);
  }
}

/** Add a qualified company to the job's list. Best-effort: never fails the qualify task. */
export async function addToJobList(job: Job, companyId: string, reason: string, deps: FinalizeDeps = defaultFinalizeDeps): Promise<void> {
  try {
    const listId = await ensureJobList(job, deps);
    if (listId) await deps.prospectListsAddMembers({ list_id: listId, members: [{ company_id: companyId, added_reason: reason }] });
  } catch {
    /* the finalizer's list check and the Office still work without this one row */
  }
}

// Report attempts per job this process lifetime — a Drive outage must not retry every minute forever.
const reportAttempts = new Map<string, number>();
const MAX_REPORT_ATTEMPTS = 3;
const RECENT_MS = 7 * 24 * 60 * 60_000;

async function report(job: Job, deps: FinalizeDeps): Promise<string> {
  const n = (reportAttempts.get(job.id) ?? 0) + 1;
  reportAttempts.set(job.id, n);
  await ensureJobList(job, deps).catch(() => undefined);
  const companies = toExportRows(await deps.companiesSearch({ research_job_id: job.id, limit: 500 }));
  const res = await deps.deliverJobReport({ ...job, status: "completed" }, companies);
  if (res.ok && res.docUrl) await deps.updateResearchJob(job.id, { report_url: res.docUrl }).catch(() => {});
  return res.ok ? `reported ${job.title} (${companies.length} companies)` : `report failed for ${job.title}: ${res.error ?? "unknown"}`;
}

/** Finalize drained jobs. Returns human-readable notes for the tick result. */
export async function finalizeJobs(deps: FinalizeDeps = defaultFinalizeDeps, now: number = Date.now()): Promise<string[]> {
  const notes: string[] = [];
  for (const job of (await deps.listResearchJobs({ status: "running", limit: 25 }))) {
    try {
      const r = await deps.researchJobReconcile(job.id);
      if (r.status !== "completed") continue;
      notes.push(await report({ ...job, status: "completed" }, deps));
    } catch (e) {
      notes.push(`finalize ${job.id.slice(0, 8)} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  // A report that failed (or ran before this code existed) is retried a few times.
  for (const job of (await deps.listResearchJobs({ status: "completed", limit: 25 }))) {
    if (job.report_url) continue;
    const finished = job.finished_at ? Date.parse(job.finished_at) : 0;
    if (!finished || now - finished > RECENT_MS) continue;
    if ((reportAttempts.get(job.id) ?? 0) >= MAX_REPORT_ATTEMPTS) continue;
    try {
      notes.push(await report(job, deps));
    } catch (e) {
      notes.push(`report ${job.id.slice(0, 8)} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return notes;
}

/** Test hook. */
export function resetFinalizeState(): void {
  pendingLists.clear();
  reportAttempts.clear();
}
