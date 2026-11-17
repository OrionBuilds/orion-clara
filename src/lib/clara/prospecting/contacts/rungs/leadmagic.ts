// contacts/rungs/leadmagic.ts — email rung 3: LeadMagic's email-finder (name + domain/company ->
// one address), tried after the two free Hunter rungs (site_mailto, hunter_pattern) and before
// hunter_finder — the plan's stated order is [site_mailto, hunter_pattern, leadmagic, hunter_finder,
// apollo_match]. Still a finder, same "likely_valid" ceiling — see contacts/verification.ts.
//
// agent-core's own doc comment on leadmagicEmailFinder flags LeadMagic's fair-use rule: a sustained
// hit rate under 10% can get the key throttled. This rung only ever runs after qualifyHandler has
// already gated the company (fit ≥ 70, AI-qualified) AND buyerDiscovery found a real decision maker
// — it is never called speculatively against an unqualified list, which is what keeps the hit rate
// in range.

import { leadmagicEmailFinder } from "@autom8ionlab/agent-core";
import { cachedCall, cacheKey } from "../../cache";
import { loadRates } from "../../estimator";
import { mapVerificationStatus } from "../verification";
import type { Rung, RungCallResult, RungContext } from "../waterfall";

export interface LeadmagicEmailDeps {
  leadmagicEmailFinder: typeof leadmagicEmailFinder;
  loadRates: typeof loadRates;
  cachedCall: typeof cachedCall;
  cacheKey: typeof cacheKey;
}

export const defaultLeadmagicEmailDeps: LeadmagicEmailDeps = { leadmagicEmailFinder, loadRates, cachedCall, cacheKey };

export function leadmagicEmailEnabled(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.CLARA_LEADMAGIC_API_KEY?.trim());
}

export async function callLeadmagicEmail(ctx: RungContext, deps: LeadmagicEmailDeps = defaultLeadmagicEmailDeps): Promise<RungCallResult> {
  const key = process.env.CLARA_LEADMAGIC_API_KEY?.trim();
  if (!key) return { hit: false, costUsd: 0, reason: "not_configured" };
  if (!ctx.person) return { hit: false, costUsd: 0, reason: "no target person" };
  if (!ctx.domain && !ctx.companyName) return { hit: false, costUsd: 0, reason: "no domain or company name" };

  const rates = await deps.loadRates();
  const cached = await deps.cachedCall({
    provider: "leadmagic",
    kind: "email",
    key: deps.cacheKey(["leadmagic_email_finder", ctx.domain ?? ctx.companyName, ctx.person.fullName]),
    jobId: ctx.jobId,
    companyId: ctx.companyId,
    costUsd: rates.leadmagic_email,
    allowLive: ctx.allowLive,
    fn: async () => {
      const r = await deps.leadmagicEmailFinder.call(
        { fullName: ctx.person!.fullName, firstName: ctx.person!.firstName, lastName: ctx.person!.lastName, domain: ctx.domain, companyName: ctx.companyName },
        { key },
      );
      if (!r.ok) return { error: r.error };
      return r.data;
    },
  });
  if (cached.skipped) return { hit: false, costUsd: 0, reason: "shadow mode" };
  const data = cached.value as { email?: string; verdict?: string; domainMismatch?: boolean } | undefined;
  if (!data?.email) return { hit: false, costUsd: cached.costUsd, reason: "leadmagic found nothing" };
  if (data.domainMismatch) return { hit: false, costUsd: cached.costUsd, reason: "leadmagic flagged a domain mismatch" };
  if (data.verdict === "undeliverable") return { hit: false, costUsd: cached.costUsd, reason: "leadmagic flagged the found address undeliverable" };

  return {
    hit: true,
    kind: "email",
    value: data.email,
    provider: "leadmagic",
    confidence: data.verdict === "deliverable" ? 0.7 : 0.4,
    verificationStatus: mapVerificationStatus({
      provider: "leadmagic",
      verdict: data.verdict === "catch_all" ? "catch_all" : data.verdict === "not_found" ? "not_found" : "deliverable",
      isFinderOnly: true,
    }),
    costUsd: cached.costUsd,
    raw: data,
  };
}

export const leadmagicEmailRung: Rung = {
  id: "leadmagic",
  enabled: leadmagicEmailEnabled,
  gate: (ctx) => Boolean(ctx.person && (ctx.domain || ctx.companyName)),
  costUnits: 1,
  call: (ctx) => callLeadmagicEmail(ctx),
};
