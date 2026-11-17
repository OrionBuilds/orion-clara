// contacts/rungs/leadmagicMobile.ts — mobile-waterfall rung 4 (last): LeadMagic's mobile-finder,
// the only rung in either waterfall that can produce a TRUE personal mobile number — hence no
// "→office" annotation in the plan, and hence why this is the one rung phoneGate.ts exists to gate:
// it's the only one that costs money (rates.json leadmagic_mobile, $0.20/hit) or risks dialing a
// real person's cell. Needs an email or a LinkedIn profile URL to look up from — this rung reads
// `ctx.email` (the verified/likely_valid address the email waterfall + stage 87 already found) or
// `ctx.person.linkedinUrl` (set by buyerDiscovery.ts's LinkedIn rung, when that's where the person
// came from).

import { leadmagicMobileFinder } from "@autom8ionlab/agent-core";
import { cachedCall, cacheKey } from "../../cache";
import { loadRates } from "../../estimator";
import type { Rung, RungCallResult, RungContext } from "../waterfall";

export interface LeadmagicMobileDeps {
  leadmagicMobileFinder: typeof leadmagicMobileFinder;
  loadRates: typeof loadRates;
  cachedCall: typeof cachedCall;
  cacheKey: typeof cacheKey;
}

export const defaultLeadmagicMobileDeps: LeadmagicMobileDeps = { leadmagicMobileFinder, loadRates, cachedCall, cacheKey };

export function leadmagicMobileEnabled(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.CLARA_LEADMAGIC_API_KEY?.trim());
}

export async function callLeadmagicMobile(ctx: RungContext, deps: LeadmagicMobileDeps = defaultLeadmagicMobileDeps): Promise<RungCallResult> {
  const key = process.env.CLARA_LEADMAGIC_API_KEY?.trim();
  if (!key) return { hit: false, costUsd: 0, reason: "not_configured" };
  const profileUrl = ctx.person?.linkedinUrl;
  if (!ctx.email && !profileUrl) return { hit: false, costUsd: 0, reason: "no email or LinkedIn profile to look up a mobile from" };

  const rates = await deps.loadRates();
  const cached = await deps.cachedCall({
    provider: "leadmagic",
    kind: "mobile",
    key: deps.cacheKey(["leadmagic_mobile_finder", ctx.email, profileUrl]),
    jobId: ctx.jobId,
    companyId: ctx.companyId,
    costUsd: rates.leadmagic_mobile,
    allowLive: ctx.allowLive,
    fn: async () => {
      const r = await deps.leadmagicMobileFinder.call({ workEmail: ctx.email, profileUrl }, { key });
      if (!r.ok) return { error: r.error };
      return r.data;
    },
  });
  if (cached.skipped) return { hit: false, costUsd: 0, reason: "shadow mode" };
  const data = cached.value as { mobile?: string } | undefined;
  if (!data?.mobile) return { hit: false, costUsd: cached.costUsd, reason: "leadmagic found no mobile" };

  return {
    hit: true,
    kind: "mobile",
    value: data.mobile,
    provider: "leadmagic",
    confidence: 0.65,
    // A found mobile number isn't run through a separate verify step the way email is (no §13
    // phone-verification provider exists) — "likely_valid" reflects "a real provider matched this
    // to the person", the honest ceiling without a dedicated verify call.
    verificationStatus: "likely_valid",
    costUsd: cached.costUsd,
    raw: data,
  };
}

export const leadmagicMobileRung: Rung = {
  id: "leadmagic_mobile",
  enabled: leadmagicMobileEnabled,
  gate: (ctx) => Boolean(ctx.email || ctx.person?.linkedinUrl),
  costUnits: 4,
  call: (ctx) => callLeadmagicMobile(ctx),
};
