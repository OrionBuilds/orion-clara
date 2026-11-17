// signals/writers.ts — shared glue every signal check uses to (a) record what it just observed as
// a fact (the "last checked" state, used both for cadence gating — see refresh.ts — and as the
// diff baseline next time) and (b) fire a company_signals row via signals_add when a real change
// was found. Kept tiny and well-tested so each check's own module stays focused on ITS detection
// logic rather than re-deriving how to talk to facts_add/signals_add.

import {
  factsAdd as factsAddReal,
  signalsAdd as signalsAddReal,
  type FactInput,
  type SignalsAddInput,
  type SignalsAddResult,
} from "../osBridge";

export interface WriterDeps {
  factsAdd: typeof factsAddReal;
  signalsAdd: typeof signalsAddReal;
}

export const defaultWriterDeps: WriterDeps = { factsAdd: factsAddReal, signalsAdd: signalsAddReal };

export interface WriteLastCheckedInput {
  companyId: string;
  /** /^[a-z0-9_.]{1,64}$/ — facts.field_name's CHECK constraint (see osBridge.ts's FactInput doc). */
  fieldName: string;
  /** The NEW observed value — a hash string for website/tech checks, or a JSON-stringified
   *  {rating, review_count, observed_at} snapshot for review_velocity. facts_add supersedes the
   *  prior row for us when this differs from what's currently on file (§28); when it's IDENTICAL,
   *  the OS just refreshes that row's observed_at in place — either way this call is exactly what
   *  "closes/opens facts via facts_add" means for this PR; nothing here ever touches valid_until
   *  directly. */
  value: string;
  sourceType: FactInput["source_type"];
  sourceUrl?: string;
  observedAt?: string;
}

/** Writes (or refreshes) the single fact that both records this check's last-checked state and
 *  serves as next time's diff baseline. Confidence 1 / grounded true: this is CLARA's own derived
 *  observation (a hash, a snapshot), not an LLM extraction with uncertainty attached. */
export async function writeLastCheckedFact(input: WriteLastCheckedInput, deps: Pick<WriterDeps, "factsAdd"> = defaultWriterDeps): Promise<void> {
  await deps.factsAdd({
    facts: [
      {
        subject_type: "company",
        subject_id: input.companyId,
        field_name: input.fieldName,
        value: input.value,
        source_type: input.sourceType,
        source_url: input.sourceUrl,
        observed_at: input.observedAt,
        confidence: 1,
        grounded: true,
      },
    ],
  });
}

export interface FireSignalInput {
  companyId: string;
  signalType: SignalsAddInput["signal_type"];
  headline: string;
  detail?: string;
  interpretation?: string;
  strength?: SignalsAddInput["strength"];
  /** The registry's (or a strength-scaled) score_delta — see registry.ts's doc comment on why this
   *  is the ONLY place a signal's score bump is decided, kept out of each check's detection logic. */
  scoreDelta: number;
  sourceUrl?: string;
  observedAt?: string;
}

/** Calls signals_add with an explicit score_delta — the one and only path any PR 17 signal uses to
 *  bump a company's fit_score (see osBridge.ts's SignalsAdd doc comment on why this is additive and
 *  separate from fitScoreRecompute). */
export async function fireSignal(input: FireSignalInput, deps: Pick<WriterDeps, "signalsAdd"> = defaultWriterDeps): Promise<SignalsAddResult> {
  return deps.signalsAdd({
    company_id: input.companyId,
    signal_type: input.signalType,
    headline: input.headline,
    detail: input.detail,
    interpretation: input.interpretation,
    strength: input.strength ?? "medium",
    score_delta: input.scoreDelta,
    source_url: input.sourceUrl,
    observed_at: input.observedAt,
  });
}
