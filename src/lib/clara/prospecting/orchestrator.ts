// orchestrator.ts — the scheduler job `prospecting-orchestrator`: claims research_tasks in stage
// order, runs the matching stage handler, reports back, retries with backoff, and trips a
// per-provider circuit breaker on repeated 402/429/5xx. Detached, in-process guard like
// overnight-worker; a tick drains for at most ~50s so it never runs into the next minute's tick.

import { prospectingMode, ProviderError } from "./types";
import type { ClaimedTask, FunnelCounts, Job, StageResult, TaskType } from "./types";
import { runStage as runStageReal } from "./stages";
import {
  claimTasks as claimTasksReal,
  getResearchJob as getResearchJobReal,
  reportTask as reportTaskReal,
  addTasks as addTasksReal,
  bumpFunnel as bumpFunnelReal,
} from "./osBridge";

const DRAIN_BUDGET_MS = 50_000;
const CLAIM_BATCH = 10;
// §20: retries at 1m, 5m, 30m — indexed by (attempt - 1), floored at the last entry for attempt 4+.
export const BACKOFF_MS = [60_000, 300_000, 1_800_000];
export const BREAKER_OPEN_MS = 10 * 60_000;

interface BreakerState {
  openUntil: number;
}
const breakers = new Map<string, BreakerState>();

export function isBreakerOpen(provider: string, now: number = Date.now()): boolean {
  const b = breakers.get(provider);
  return Boolean(b && b.openUntil > now);
}
export function tripBreaker(provider: string, now: number = Date.now()): void {
  breakers.set(provider, { openUntil: now + BREAKER_OPEN_MS });
}
/** Test helper — real breaker state is process-lifetime, by design (a restart half-opens everything). */
export function resetBreakers(): void {
  breakers.clear();
}

export function nextNotBefore(attempt: number, now: number = Date.now()): string {
  const idx = Math.min(Math.max(attempt - 1, 0), BACKOFF_MS.length - 1);
  return new Date(now + BACKOFF_MS[idx]).toISOString();
}

const PROVIDER_FOR_TASK_TYPE: Partial<Record<TaskType, string>> = {
  discover: "places",
  crawl: "http",
  find_email: "leadmagic",
  verify_email: "hunter",
  find_phone: "leadmagic",
};

export interface OrchestratorDeps {
  /** Reconcile drained jobs, deliver their report (jobFinalize.ts). Runs after the drain loop. */
  finalizeJobs?: () => Promise<string[]>;
  claimTasks: (jobId: string | undefined, limit: number) => Promise<ClaimedTask[]>;
  getJob: (id: string) => Promise<Job>;
  reportTask: (taskId: string, result: StageResult & { not_before?: string }) => Promise<void>;
  addTasks: (jobId: string, tasks: Record<string, unknown>[]) => Promise<void>;
  bumpFunnel: (jobId: string, keys: (keyof FunnelCounts)[]) => Promise<void>;
  runStage: (task: ClaimedTask, job: Job) => Promise<StageResult>;
}

export const defaultOrchestratorDeps: OrchestratorDeps = {
  finalizeJobs: async () => (await import("./jobFinalize")).finalizeJobs(),
  claimTasks: claimTasksReal,
  getJob: getResearchJobReal,
  reportTask: reportTaskReal,
  addTasks: addTasksReal,
  bumpFunnel: bumpFunnelReal,
  runStage: runStageReal,
};

export interface TickResult {
  mode: string;
  claimed: number;
  completed: number;
  failed: number;
  skipped: number;
  notes: string[];
}

async function handleOne(task: ClaimedTask, jobCache: Map<string, Job>, deps: OrchestratorDeps, res: TickResult): Promise<void> {
  let job = jobCache.get(task.job_id);
  if (!job) {
    try {
      job = await deps.getJob(task.job_id);
      jobCache.set(task.job_id, job);
    } catch (e) {
      res.notes.push(`job ${task.job_id} unavailable: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
  }

  const provider = PROVIDER_FOR_TASK_TYPE[task.task_type];
  if (provider && isBreakerOpen(provider)) {
    await deps.reportTask(task.id, { status: "skipped", output: { reason: `circuit breaker open for ${provider}` } })
      .catch((e) => res.notes.push(`report ${task.task_type} ${task.id.slice(0, 8)} failed: ${errText(e)}`));
    res.skipped++;
    return;
  }

  try {
    const result = await deps.runStage(task, job);
    if (result.bump?.length) await deps.bumpFunnel(job.id, result.bump).catch(() => {});
    if (result.fan_out?.length) {
      await deps.addTasks(job.id, result.fan_out as unknown as Record<string, unknown>[])
        .catch((e) => res.notes.push(`fan-out from ${task.task_type} ${task.id.slice(0, 8)} failed: ${errText(e)}`));
    }
    await deps.reportTask(task.id, result);
    if (result.status === "completed") res.completed++;
    else if (result.status === "skipped") res.skipped++;
    else {
      res.failed++;
      res.notes.push(`${task.task_type} ${task.id.slice(0, 8)} failed: ${(result.error ?? "no error given").slice(0, 200)}`);
    }
  } catch (e) {
    if (provider && e instanceof ProviderError && e.opensBreaker) tripBreaker(provider);
    const notBefore = nextNotBefore(task.attempt + 1);
    res.notes.push(`${task.task_type} ${task.id.slice(0, 8)} threw: ${errText(e)}`);
    await deps.reportTask(task.id, { status: "failed", error: errText(e), not_before: notBefore })
      .catch((re) => res.notes.push(`report ${task.task_type} ${task.id.slice(0, 8)} failed: ${errText(re)} — the lease will expire and the task retries`));
    res.failed++;
  }
}

function errText(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).slice(0, 300);
}

/** Stop claiming new batches this close to the drain deadline: a task claimed but not handled
 *  before the tick ends sits until its lease expires and burns an attempt. */
const CLAIM_CUTOFF_MS = 20_000;

let running = false;

/** True while a tick is in flight — the in-process guard overlapping ticks fall back to. */
export function orchestratorRunning(): boolean {
  return running;
}

export async function prospectingOrchestratorTick(deps: OrchestratorDeps = defaultOrchestratorDeps, now: () => number = Date.now): Promise<TickResult> {
  const res: TickResult = { mode: prospectingMode(), claimed: 0, completed: 0, failed: 0, skipped: 0, notes: [] };
  if (res.mode === "off") return res;
  if (running) {
    res.notes.push("already running — overlapping tick skipped");
    return res;
  }
  running = true;
  const deadline = now() + DRAIN_BUDGET_MS;
  try {
    const jobCache = new Map<string, Job>();
    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (now() >= deadline - CLAIM_CUTOFF_MS) {
        res.notes.push("drain budget reached");
        break;
      }
      let tasks: ClaimedTask[];
      try {
        tasks = await deps.claimTasks(undefined, CLAIM_BATCH);
      } catch (e) {
        res.notes.push(`claim failed: ${e instanceof Error ? e.message : String(e)}`);
        break;
      }
      if (!tasks.length) break;
      res.claimed += tasks.length;
      for (const task of tasks) {
        if (now() >= deadline) {
          res.notes.push("drain budget reached mid-batch");
          break;
        }
        await handleOne(task, jobCache, deps, res);
      }
    }
    if (deps.finalizeJobs && res.mode === "active") {
      try {
        res.notes.push(...(await deps.finalizeJobs()));
      } catch (e) {
        res.notes.push(`finalize failed: ${errText(e)}`);
      }
    }
  } finally {
    running = false;
  }
  return res;
}
