// contacts/rungs/hunterFinder.ts — email rung 4: Hunter's dedicated email-finder (first name + last
// name + domain -> one specific address), tried AFTER leadmagic (rung 3) per the plan's stated
// order. Still a finder, not a verifier — same "likely_valid" ceiling as hunter_pattern, see
// contacts/verification.ts. A finder verdict of "undeliverable" is treated as a miss outright
// (never write an address Hunter itself flagged as bad); "risky"/"unknown" still return a hit, at
// low confidence, for stage 87 to resolve with a real verify call.

import { hunterEmailFinder } from "@autom8ionlab/agent-core";
import { cachedCall, cacheKey } from "../../cache";
import { loadRates } from "../../estimator";
import { mapVerificationStatus } from "../verification";
import type { Rung, RungCallResult, RungContext } from "../waterfall";

export interface HunterFinderDeps {
  hunterEmailFinder: typeof hunterEmailFinder;
  loadRates: typeof loadRates;
  cachedCall: typeof cachedCall;
  cacheKey: typeof cacheKey;
}

export const defaultHunterFinderDeps: HunterFinderDeps = { hunterEmailFinder, loadRates, cachedCall, cacheKey };

export function hunterFinderEnabled(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.CLARA_HUNTER_API_KEY?.trim());
}

function nameParts(person: { fullName: string; firstName?: string; lastName?: string }): { firstName: string; lastName: string } | undefined {
  if (person.firstName && person.lastName) return { firstName: person.firstName, lastName: person.lastName };
  const parts = person.fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return undefined;
  return { firstName: parts[0], lastName: parts[parts.length - 1] };
}

export async function callHunterFinder(ctx: RungContext, deps: HunterFinderDeps = defaultHunterFinderDeps): Promise<RungCallResult> {
  const key = process.env.CLARA_HUNTER_API_KEY?.trim();
  if (!key) return { hit: false, costUsd: 0, reason: "not_configured" };
  if (!ctx.domain) return { hit: false, costUsd: 0, reason: "no domain" };
  const name = ctx.person && nameParts(ctx.person);
  if (!name) return { hit: false, costUsd: 0, reason: "no usable first/last name for target person" };

  const rates = await deps.loadRates();
  const cached = await deps.cachedCall({
    provider: "hunter",
    kind: "email",
    key: deps.cacheKey(["hunter_email_finder", ctx.domain, name.firstName, name.lastName]),
    jobId: ctx.jobId,
    companyId: ctx.companyId,
    costUsd: rates.hunter_find,
    allowLive: ctx.allowLive,
    fn: async () => {
      const r = await deps.hunterEmailFinder.call({ domain: ctx.domain!, firstName: name.firstName, lastName: name.lastName }, { key });
      if (!r.ok) return { error: r.error };
      return r.data;
    },
  });
  if (cached.skipped) return { hit: false, costUsd: 0, reason: "shadow mode" };
  const data = cached.value as { email?: string; score?: number; verdict?: string; sources?: { uri: string }[] } | undefined;
  if (!data?.email) return { hit: false, costUsd: cached.costUsd, reason: "hunter email-finder found nothing" };
  if (data.verdict === "undeliverable") return { hit: false, costUsd: cached.costUsd, reason: "hunter flagged the found address undeliverable" };

  return {
    hit: true,
    kind: "email",
    value: data.email,
    provider: "hunter",
    confidence: (data.score ?? 40) / 100,
    verificationStatus: mapVerificationStatus({
      provider: "hunter",
      verdict: data.verdict === "risky" ? "risky" : data.verdict === "catch_all" ? "catch_all" : "deliverable",
      isFinderOnly: true,
    }),
    sourceUrl: data.sources?.[0]?.uri,
    costUsd: cached.costUsd,
    raw: data,
  };
}

export const hunterFinderRung: Rung = {
  id: "hunter_finder",
  enabled: hunterFinderEnabled,
  gate: (ctx) => Boolean(ctx.domain && ctx.person),
  costUnits: 1,
  call: (ctx) => callHunterFinder(ctx),
};
