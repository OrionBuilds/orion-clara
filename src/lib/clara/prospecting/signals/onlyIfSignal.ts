// signals/onlyIfSignal.ts — a STUB for sequence_steps.only_if_signal (text[], already live on the
// OS — orion/supabase/migrations/20261001100200_prospect_lists_sequences.sql) support.
//
// NOT WIRED TO ANYTHING YET. There is no sequence-processor/outreach-execution code anywhere in
// this repo to wire it into: `git log --all --oneline | grep -i sequence` turns up nothing, and the
// only `sequence` references in src/ are osClient.ts's CLI-unsafe-tool pattern (sequence_enroll),
// the Twilio SMS route's unrelated comments, and
// /api/prospects/lists/[id]/launch/route.ts — which is ITSELF a 501 stub whose own comment says
// outright: "stub until PR 14 (`sequenceRunner`, personalization, capacity/compliance)". So PRs
// 11-14/16 (the parallel contacts+outreach track) clearly haven't landed in this repo yet. This is
// a small, well-tested,
// standalone helper a future outreach PR can drop straight into its step-gating logic (`if
// (step.only_if_signal?.length && !(await companyHasRecentSignal(companyId, step.only_if_signal,
// windowDays))) { skip this step }`) — built on signals_list (PR 17's own signalsList wrapper), not
// on anything sequence-specific, so it has nothing to depend on here beyond osBridge.ts.

import { signalsList as signalsListReal, type SignalRow } from "../osBridge";

export interface OnlyIfSignalDeps {
  signalsList: typeof signalsListReal;
  now: () => Date;
}

export const defaultOnlyIfSignalDeps: OnlyIfSignalDeps = {
  signalsList: signalsListReal,
  now: () => new Date(),
};

/**
 * Has `companyId` had any signal of one of `signalTypes` within the last `withinDays` days?
 *
 * Passes `since` to signals_list (an efficient server-side pre-filter) AND re-checks the exact same
 * cutoff client-side against each row's `observed_at` — the latter is what actually decides the
 * answer (and what makes this deterministically unit-testable against fake data regardless of
 * what a fake signalsList does with `since`), the former just keeps a real OS call cheap.
 */
export async function companyHasRecentSignal(
  companyId: string,
  signalTypes: readonly string[],
  withinDays: number,
  deps: OnlyIfSignalDeps = defaultOnlyIfSignalDeps,
): Promise<boolean> {
  if (!companyId || !signalTypes.length || withinDays <= 0) return false;

  const nowMs = deps.now().getTime();
  const cutoffMs = nowMs - withinDays * 24 * 3600_000;
  const sinceIso = new Date(cutoffMs).toISOString();

  const rows: SignalRow[] = await deps.signalsList({ company_id: companyId, since: sinceIso });
  const wanted = new Set(signalTypes);

  return rows.some((r) => {
    if (!wanted.has(r.signal_type)) return false;
    const obsMs = Date.parse(r.observed_at);
    return Number.isFinite(obsMs) && obsMs >= cutoffMs;
  });
}
