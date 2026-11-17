// budget.ts — §31 reserve-before-spend + the plain-English pause text, per job.
//
// The OS `provider_requests` AFTER INSERT trigger is the real hard cap once the orion migrations
// land (a job flips to `paused` the instant spend exceeds budget). This module is Clara's own belt:
// it refuses to even ATTEMPT a paid call whose cost would blow the job's max_spend_usd, so the
// trigger is a backstop rather than the only thing standing between a job and overspend. Pure —
// the orchestrator is responsible for calling the OS to actually pause/notify.

import type { Job } from "./types";

export interface BudgetCheck {
  ok: boolean;
  wouldSpendUsd: number;
  remainingUsd: number;
  reason?: "budget_exhausted";
}

/** Would reserving `costUsd` more blow the job's budget? costUsd<=0 never blocks (free/cached). */
export function checkReserve(job: Pick<Job, "budget_usd" | "spend_usd">, costUsd: number): BudgetCheck {
  const remainingUsd = job.budget_usd - job.spend_usd;
  const wouldSpendUsd = job.spend_usd + Math.max(0, costUsd);
  if (costUsd > 0 && wouldSpendUsd > job.budget_usd) {
    return { ok: false, wouldSpendUsd, remainingUsd, reason: "budget_exhausted" };
  }
  return { ok: true, wouldSpendUsd, remainingUsd };
}

/** Round a "needed" figure up to the nearest $5 for a tidy ask ("add 25", not "add 23.40"). */
function roundAskUp(usd: number): number {
  return Math.max(5, Math.ceil(usd / 5) * 5);
}

/** §31's plain-English pause text. `label` is the job's title as the owner knows it. */
export function pauseBudgetText(label: string, spentUsd: number, budgetUsd: number, neededUsd: number, mostlyWhat: string): string {
  const ask = roundAskUp(neededUsd);
  return `The ${label} job has used $${spentUsd.toFixed(0)} of its $${budgetUsd.toFixed(0)}. Finishing needs about $${neededUsd.toFixed(0)} more, mostly ${mostlyWhat}. Say "add ${ask} to the ${label} job" to continue or "stop it" to wrap up with what I have.`;
}

/** Per-job-per-day dedupe for the pause text — the orchestrator keeps this in whatever small store
 *  it already has (a Map in-process is enough; a restart re-sending once is harmless). */
export interface DedupeState {
  [jobId: string]: string; // last day (YYYY-MM-DD) a pause text went out for this job
}

export function alreadyNotifiedToday(state: DedupeState, jobId: string, today: string): boolean {
  return state[jobId] === today;
}

export function markNotified(state: DedupeState, jobId: string, today: string): DedupeState {
  return { ...state, [jobId]: today };
}
