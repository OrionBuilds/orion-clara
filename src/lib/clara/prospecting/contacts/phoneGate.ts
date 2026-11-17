// contacts/phoneGate.ts — the predicate that decides whether stage 90 (find_phone, contact.phone)
// is even allowed to run for a company. Pure; stages.ts calls this ONCE per find_email/verify_email
// completion, before ever invoking the phone waterfall — the waterfall itself (contacts/waterfall.ts
// + rungs/{placesPhone,dbprPhone,siteTel,leadmagicMobile}.ts) has no gating logic of its own.
//
// Plan: "fit ≥ 80, DM found, email ∈ {verified, likely_valid} OR fit ≥ 90, mobiles requested < 30%
// of qualified, job.allow_mobile." Read as: (fitScore ≥ 90 OR (fitScore ≥ 80 AND email sendable))
// AND decisionMakerFound AND allowMobile AND the job hasn't already spent its 30% mobile-lookup
// quota — every clause is a separate, independently-failing condition so a caller can show the
// owner exactly why a company didn't get a mobile search.

import type { VerificationStatus } from "./verification";

export const PHONE_GATE_MIN_FIT = 80;
export const PHONE_GATE_HIGH_FIT = 90;
/** §31/§plan: mobiles requested as a share of qualified companies — a cost control, not a quality
 *  one (leadmagic_mobile is the only paid rung in the phone waterfall). */
export const DEFAULT_MOBILE_SHARE_MAX = 0.3;

export interface PhoneGateInput {
  fitScore: number;
  decisionMakerFound: boolean;
  emailStatus: VerificationStatus | undefined;
  /** job.plan.gates.allow_mobile — the planner/owner's explicit opt-in for paid mobile lookups. */
  allowMobile: boolean;
  /** job.funnel.mobile_requested ?? 0 — how many mobile lookups this job has already attempted. */
  mobileRequested: number;
  /** job.funnel.ai_qualified ?? 0 — the funnel's qualified-company denominator for the 30% share. */
  qualifiedCount: number;
  /** job.plan.gates.mobile_share_max, falls back to DEFAULT_MOBILE_SHARE_MAX. */
  mobileShareMax?: number;
}

export interface PhoneGateDecision {
  allow: boolean;
  reason?: string;
}

function emailSendableForMobile(status: VerificationStatus | undefined): boolean {
  return status === "verified" || status === "likely_valid";
}

export function phoneGate(input: PhoneGateInput): PhoneGateDecision {
  if (!input.allowMobile) return { allow: false, reason: "job.allow_mobile is false" };
  if (!input.decisionMakerFound) return { allow: false, reason: "no decision maker found" };

  const fitOk =
    input.fitScore >= PHONE_GATE_HIGH_FIT ||
    (input.fitScore >= PHONE_GATE_MIN_FIT && emailSendableForMobile(input.emailStatus));
  if (!fitOk) {
    return {
      allow: false,
      reason:
        input.fitScore < PHONE_GATE_MIN_FIT
          ? `fit score ${input.fitScore} is below the ${PHONE_GATE_MIN_FIT} floor`
          : `fit score ${input.fitScore} is below ${PHONE_GATE_HIGH_FIT} and email is not verified/likely_valid`,
    };
  }

  const shareMax = input.mobileShareMax ?? DEFAULT_MOBILE_SHARE_MAX;
  // A zero/negative qualified count can't divide meaningfully — treat it as "not yet over quota"
  // rather than refuse every company before the funnel has any denominator to compare against.
  if (input.qualifiedCount > 0) {
    const share = input.mobileRequested / input.qualifiedCount;
    if (share >= shareMax) {
      return { allow: false, reason: `mobile lookups already at ${(share * 100).toFixed(0)}% of qualified companies (cap ${(shareMax * 100).toFixed(0)}%)` };
    }
  }

  return { allow: true };
}
