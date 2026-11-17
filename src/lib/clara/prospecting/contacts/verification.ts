// contacts/verification.ts — the email verification state machine (plan §13).
//
// Pure. Two jobs:
//   1. mapVerificationStatus — turn one provider's raw verdict into the OS's six-state vocabulary
//      (contact_methods.verification_status CHECK: verified|likely_valid|catch_all|risky|invalid|
//      unknown), honoring the plan's explicit mapping table AND the "finder-only" distinction: a
//      rung that only FOUND an address (site_mailto, hunter_pattern, hunter_finder, leadmagic's
//      email-finder) never independently verified it, so even a positive-looking verdict caps out
//      at "likely_valid" — only a dedicated verify call (Hunter email-verifier, LeadMagic
//      email-validation — stage 87, verify.email) can earn "verified".
//   2. decay/terminal helpers — "verified" decays to "likely_valid" after 90 days (plan §13: a
//      verification result goes stale, not wrong); "invalid" is terminal for 90 days (a hard bounce
//      or a provider's "doesn't exist" isn't worth re-checking sooner — see phoneGate.ts/the
//      contact.email gate's own "no verified/likely_valid email <180 d" rule for the OTHER half of
//      this, which lives in stages.ts since it reads the job spec, not this pure module).
//
// contacts/waterfall.ts and every rungs/*.ts file import ONLY mapVerificationStatus (set the
// INITIAL status right after a find/verify call); decayVerification/isInvalidTerminal are for a
// later re-check path (a future PR's recurring contact-refresh) and are exported now so that PR
// doesn't have to touch this file's shape.

export type VerificationStatus = "verified" | "likely_valid" | "catch_all" | "risky" | "invalid" | "unknown";

/** The normalized verdict vocabulary every provider client (agent-core's hunterVerdict/
 *  leadmagicVerdict) already reduces its raw status string to — this module never parses a raw
 *  provider string itself, it only classifies the already-normalized verdict. */
export type ProviderVerdict = "deliverable" | "catch_all" | "undeliverable" | "risky" | "not_found" | "unknown";

export interface VerificationInput {
  /** Kept for future provider-specific exceptions; the mapping below is provider-agnostic today
   *  because agent-core's hunterVerdict/leadmagicVerdict already normalize onto the same five-way
   *  ProviderVerdict enum (see hunter.ts's HunterVerdict / leadmagic.ts's LeadMagicVerdict). */
  provider: "hunter" | "leadmagic" | "site" | "manual" | "apollo";
  verdict: ProviderVerdict;
  /** True when this call only FOUND the address (a finder), never independently verified it.
   *  false for a dedicated verify/validate call (Hunter email-verifier, LeadMagic email-validation). */
  isFinderOnly: boolean;
}

/**
 * Plan §13's table: "Hunter deliverable→verified, accept_all→catch_all, undeliverable→invalid,
 * risky→risky; LeadMagic valid→verified, catch_all→catch_all, invalid→invalid; finder-only without
 * verify→likely_valid." Both providers' raw verdicts are already normalized to the same
 * ProviderVerdict by the time they reach here (hunterVerdict/leadmagicVerdict in agent-core), so one
 * table serves both — "accept_all" IS this module's "catch_all", "valid" IS "deliverable".
 */
export function mapVerificationStatus(input: VerificationInput): VerificationStatus {
  if (input.isFinderOnly) {
    // A finder never ran a verify call — even a provider that LOOKS confident (its own "deliverable"
    // read on a pattern-constructed address) only earns "likely_valid". A finder that came back
    // flatly bad (undeliverable/not_found) is still bad regardless of who ran the check.
    if (input.verdict === "undeliverable") return "invalid";
    if (input.verdict === "catch_all") return "catch_all";
    if (input.verdict === "risky") return "risky";
    return "likely_valid"; // deliverable | not_found(shouldn't reach here — caller treats as a miss) | unknown
  }
  switch (input.verdict) {
    case "deliverable": return "verified";
    case "catch_all": return "catch_all";
    case "undeliverable": return "invalid";
    case "risky": return "risky";
    default: return "unknown";
  }
}

export const VERIFIED_DECAY_DAYS = 90;
export const INVALID_TERMINAL_DAYS = 90;

/** "verified" older than 90 days reads as "likely_valid" — still sendable, just no longer freshly
 *  confirmed. Every other status is unaffected by age (an "invalid" doesn't un-decay; see
 *  isInvalidTerminal for that side). */
export function decayVerification(status: VerificationStatus, verifiedAt: Date, now: Date = new Date()): VerificationStatus {
  if (status !== "verified") return status;
  const days = (now.getTime() - verifiedAt.getTime()) / 86_400_000;
  return days >= VERIFIED_DECAY_DAYS ? "likely_valid" : status;
}

/** True while an "invalid" result is still within its 90-day terminal window — callers (the email
 *  waterfall) should not re-attempt finding/verifying this address until it returns false. */
export function isInvalidTerminal(invalidatedAt: Date, now: Date = new Date()): boolean {
  const days = (now.getTime() - invalidatedAt.getTime()) / 86_400_000;
  return days < INVALID_TERMINAL_DAYS;
}

/** Sendable per plan §13: verified or likely_valid send at the normal cap; catch_all sends too, but
 *  at a LOWER cap (sendCap below) — the caller (sequenceRunner, a later PR) reads sendCap, not a
 *  second boolean, to decide how aggressively to use a catch_all address. risky/invalid/unknown
 *  never send. */
export function isSendable(status: VerificationStatus): boolean {
  return status === "verified" || status === "likely_valid" || status === "catch_all";
}

export type SendCap = "normal" | "lower" | "none";

export function sendCap(status: VerificationStatus): SendCap {
  if (status === "verified" || status === "likely_valid") return "normal";
  if (status === "catch_all") return "lower";
  return "none";
}

/** A catch_all address that gets a genuine reply graduates to "verified" (plan §13: "catch_all +
 *  reply → verified") — the reply itself is the strongest signal there is. Exported for PR 16's
 *  reply classifier to call; not used within this PR. */
export function upgradeOnReply(status: VerificationStatus): VerificationStatus {
  return status === "catch_all" ? "verified" : status;
}
