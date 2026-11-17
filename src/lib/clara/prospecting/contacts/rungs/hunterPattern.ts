// contacts/rungs/hunterPattern.ts — email rung 2: Hunter's domain-search, used two ways. If the
// target person is already one of the people Hunter's crawl found on this domain, their email is a
// DIRECT hit. Otherwise, Hunter's domain-search response carries the domain's inferred address
// PATTERN (e.g. "{first}.{last}") — when at least 2 people confirm that pattern (the plan's "≥2
// confirmations"), this rung constructs the target person's address from it. Either way this is
// still a FINDER call (Hunter's domain-search doesn't verify anything), so the resulting status
// never exceeds "likely_valid" — see contacts/verification.ts.
//
// Cached under cache.ts's "email" kind (180d TTL) keyed on the domain alone (not the person) — one
// domain-search answers every person at that company, so the SECOND decision maker at the same
// domain costs $0.

import { hunterDomainSearch, type HunterPerson } from "@autom8ionlab/agent-core";
import { cachedCall, cacheKey } from "../../cache";
import { loadRates } from "../../estimator";
import { mapVerificationStatus } from "../verification";
import type { Rung, RungCallResult, RungContext } from "../waterfall";

/** Hunter's own pattern tokens ({first}, {last}, {f}, {l}) applied to the target person. Returns
 *  undefined when the pattern uses a token this function doesn't recognize, or the person has no
 *  usable first/last name — better to miss than to guess wrong. */
export function applyHunterPattern(pattern: string, person: { fullName: string; firstName?: string; lastName?: string }, domain: string): string | undefined {
  const parts = person.fullName.trim().split(/\s+/).filter(Boolean);
  const firstRaw = person.firstName || parts[0] || "";
  const lastRaw = person.lastName || (parts.length > 1 ? parts[parts.length - 1] : "");
  const first = firstRaw.toLowerCase().replace(/[^a-z]/g, "");
  const last = lastRaw.toLowerCase().replace(/[^a-z]/g, "");
  if (!first || !last) return undefined;

  const local = pattern
    .replace(/\{first\}/gi, first)
    .replace(/\{last\}/gi, last)
    .replace(/\{f\}/gi, first[0] ?? "")
    .replace(/\{l\}/gi, last[0] ?? "");
  if (/\{[a-z_]+\}/i.test(local)) return undefined; // unrecognized token — don't guess
  return `${local}@${domain}`;
}

/** True when `person`'s name clearly matches one of Hunter's domain-search people entries. */
export function findDirectMatch(people: HunterPerson[], person: { fullName: string; firstName?: string; lastName?: string }): HunterPerson | undefined {
  const target = (person.fullName || `${person.firstName ?? ""} ${person.lastName ?? ""}`).trim().toLowerCase();
  if (!target) return undefined;
  return people.find((p) => {
    const name = `${p.firstName ?? ""} ${p.lastName ?? ""}`.trim().toLowerCase();
    return name.length > 0 && (name === target || target.includes(name) || name.includes(target));
  });
}

export const HUNTER_PATTERN_MIN_CONFIRMATIONS = 2;

export interface HunterPatternDeps {
  hunterDomainSearch: typeof hunterDomainSearch;
  loadRates: typeof loadRates;
  cachedCall: typeof cachedCall;
  cacheKey: typeof cacheKey;
}

export const defaultHunterPatternDeps: HunterPatternDeps = { hunterDomainSearch, loadRates, cachedCall, cacheKey };

export function hunterPatternEnabled(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.CLARA_HUNTER_API_KEY?.trim());
}

export async function callHunterPattern(ctx: RungContext, deps: HunterPatternDeps = defaultHunterPatternDeps): Promise<RungCallResult> {
  const key = process.env.CLARA_HUNTER_API_KEY?.trim();
  if (!key) return { hit: false, costUsd: 0, reason: "not_configured" };
  if (!ctx.domain) return { hit: false, costUsd: 0, reason: "no domain" };
  if (!ctx.person) return { hit: false, costUsd: 0, reason: "no target person" };

  const rates = await deps.loadRates();
  const cached = await deps.cachedCall({
    provider: "hunter",
    kind: "email",
    key: deps.cacheKey(["hunter_domain_search", ctx.domain]),
    jobId: ctx.jobId,
    companyId: ctx.companyId,
    costUsd: rates.hunter_find,
    allowLive: ctx.allowLive,
    fn: async () => {
      const r = await deps.hunterDomainSearch.call({ domain: ctx.domain!, limit: 50 }, { key });
      if (!r.ok) return { error: r.error };
      return r.data;
    },
  });
  if (cached.skipped) return { hit: false, costUsd: 0, reason: "shadow mode" };
  const data = cached.value as { organization?: string; pattern?: string; people?: HunterPerson[]; total?: number } | undefined;
  if (!data || !Array.isArray(data.people)) return { hit: false, costUsd: cached.costUsd, reason: "hunter domain-search unavailable" };

  const direct = findDirectMatch(data.people, ctx.person);
  if (direct?.email) {
    return {
      hit: true,
      kind: "email",
      value: direct.email,
      provider: "hunter",
      confidence: (direct.confidence ?? 60) / 100,
      verificationStatus: mapVerificationStatus({ provider: "hunter", verdict: "deliverable", isFinderOnly: true }),
      sourceUrl: direct.sources[0]?.uri,
      costUsd: cached.costUsd,
      raw: direct,
    };
  }

  if (data.pattern && data.people.length >= HUNTER_PATTERN_MIN_CONFIRMATIONS) {
    const email = applyHunterPattern(data.pattern, ctx.person, ctx.domain);
    if (email) {
      return {
        hit: true,
        kind: "email",
        value: email,
        provider: "hunter",
        confidence: 0.55,
        verificationStatus: mapVerificationStatus({ provider: "hunter", verdict: "deliverable", isFinderOnly: true }),
        costUsd: cached.costUsd,
        raw: { pattern: data.pattern, confirmations: data.people.length },
      };
    }
  }

  return { hit: false, costUsd: cached.costUsd, reason: `no direct match and ${data.pattern ? "pattern unusable" : "no confirmed pattern"}` };
}

export const hunterPatternRung: Rung = {
  id: "hunter_pattern",
  enabled: hunterPatternEnabled,
  gate: (ctx) => Boolean(ctx.domain && ctx.person),
  costUnits: 1,
  call: (ctx) => callHunterPattern(ctx),
};
