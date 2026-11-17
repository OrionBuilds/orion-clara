// contacts/verifyEmail.ts — stage 87 (verify.email)'s I/O: the one call in the whole contact
// pipeline allowed to return "verified", because it's the only one that independently CHECKS
// deliverability rather than just finding/constructing an address. Tries Hunter's email-verifier
// first (if CLARA_HUNTER_API_KEY is set), then LeadMagic's email-validation (if
// CLARA_LEADMAGIC_API_KEY is set); with neither configured, or both unavailable, the address keeps
// whatever status stage 85's rung already gave it (the plan's "shadow for people-finding" posture —
// an unverified find still has SOME status, just not an upgraded one).
//
// Cached under cache.ts's "email" kind (180d TTL), keyed separately from the finder calls (a
// "verify" tag in the cache key) so a verify call never accidentally replays a finder's cached
// response or vice versa.

import { hunterEmailVerifier, leadmagicEmailValidate, type HunterVerdict, type LeadMagicVerdict } from "@autom8ionlab/agent-core";
import { cachedCall, cacheKey } from "../cache";
import { loadRates } from "../estimator";
import { mapVerificationStatus, type ProviderVerdict, type VerificationStatus } from "./verification";

function hunterVerdictToProviderVerdict(v: HunterVerdict, acceptAll: boolean | undefined): ProviderVerdict {
  if (acceptAll) return "catch_all";
  switch (v) {
    case "deliverable": return "deliverable";
    case "risky": return "risky";
    case "undeliverable": return "undeliverable";
    case "catch_all": return "catch_all";
    default: return "unknown";
  }
}
function leadmagicVerdictToProviderVerdict(v: LeadMagicVerdict): ProviderVerdict {
  switch (v) {
    case "deliverable": return "deliverable";
    case "catch_all": return "catch_all";
    case "undeliverable": return "undeliverable";
    case "not_found": return "not_found";
    default: return "unknown";
  }
}

export interface VerifyEmailResult {
  status: VerificationStatus;
  verifier?: "hunter" | "leadmagic";
  costUsd: number;
  /** false when neither provider was configured/available — caller keeps the rung's prior status. */
  attempted: boolean;
}

export interface VerifyEmailDeps {
  hunterEmailVerifier: typeof hunterEmailVerifier;
  leadmagicEmailValidate: typeof leadmagicEmailValidate;
  loadRates: typeof loadRates;
  cachedCall: typeof cachedCall;
  cacheKey: typeof cacheKey;
}

export const defaultVerifyEmailDeps: VerifyEmailDeps = { hunterEmailVerifier, leadmagicEmailValidate, loadRates, cachedCall, cacheKey };

export interface VerifyEmailContext {
  allowLive: boolean;
  jobId?: string;
  companyId?: string;
  /** Stage 85's initial status — returned unchanged when no verify call could run. */
  fallbackStatus: VerificationStatus;
}

export async function verifyEmail(email: string, ctx: VerifyEmailContext, deps: VerifyEmailDeps = defaultVerifyEmailDeps): Promise<VerifyEmailResult> {
  const hunterKey = process.env.CLARA_HUNTER_API_KEY?.trim();
  const leadmagicKey = process.env.CLARA_LEADMAGIC_API_KEY?.trim();
  const rates = await deps.loadRates();

  if (hunterKey) {
    const cached = await deps.cachedCall({
      provider: "hunter",
      kind: "email",
      key: deps.cacheKey(["hunter_verify", email]),
      jobId: ctx.jobId,
      companyId: ctx.companyId,
      costUsd: rates.hunter_verify,
      allowLive: ctx.allowLive,
      fn: async () => {
        const r = await deps.hunterEmailVerifier.call({ email }, { key: hunterKey });
        if (!r.ok) return { error: r.error };
        return r.data;
      },
    });
    if (!cached.skipped) {
      const data = cached.value as { verdict?: HunterVerdict; acceptAll?: boolean } | undefined;
      if (data?.verdict) {
        return {
          status: mapVerificationStatus({ provider: "hunter", verdict: hunterVerdictToProviderVerdict(data.verdict, data.acceptAll), isFinderOnly: false }),
          verifier: "hunter",
          costUsd: cached.costUsd,
          attempted: true,
        };
      }
    }
  }

  if (leadmagicKey) {
    const cached = await deps.cachedCall({
      provider: "leadmagic",
      kind: "email",
      key: deps.cacheKey(["leadmagic_validate", email]),
      jobId: ctx.jobId,
      companyId: ctx.companyId,
      costUsd: rates.leadmagic_email,
      allowLive: ctx.allowLive,
      fn: async () => {
        const r = await deps.leadmagicEmailValidate.call({ email }, { key: leadmagicKey });
        if (!r.ok) return { error: r.error };
        return r.data;
      },
    });
    if (!cached.skipped) {
      const data = cached.value as { verdict?: LeadMagicVerdict } | undefined;
      if (data?.verdict) {
        return {
          status: mapVerificationStatus({ provider: "leadmagic", verdict: leadmagicVerdictToProviderVerdict(data.verdict), isFinderOnly: false }),
          verifier: "leadmagic",
          costUsd: cached.costUsd,
          attempted: true,
        };
      }
    }
  }

  return { status: ctx.fallbackStatus, costUsd: 0, attempted: false };
}
