// contacts/rungs/apollo.ts — email rung 5 (last resort): Apollo's people-match endpoint.
//
// Apollo is explicitly NOT on the plan's buy list (Part 5: "Apollo / PDL: Agent-Reach LinkedIn via
// FRIDAY delegation — partial, no emails" / "not bought"), and no CLARA_APOLLO_API_KEY exists
// anywhere in this deploy. This rung exists because the PR brief names it as the waterfall's last
// rung and the stage must "run cleanly" with it in place — in practice, with no key configured, it
// always reports `not_configured` and the waterfall falls through with nothing found, exactly like
// hunter/leadmagic do when THEIR keys are unset. If the owner ever buys Apollo, setting
// CLARA_APOLLO_API_KEY is the only change needed; the call shape below matches Apollo's public
// `POST /v1/people/match` contract (api key header, name + domain/org, reveal_personal_emails
// false — this rung never asks Apollo to unlock a gated personal address, only whatever's already
// on the free match response).
//
// Self-contained (not an agent-core provider client) because agent-core's provider surface only
// ships hunter/leadmagic/googlePlaces/brave today (PR 6) — adding a speculative Apollo client there
// for a rung nothing will ever call would be scope the plan didn't ask for. A later PR can promote
// this into agent-core/src/providers/apollo.ts verbatim if Apollo is ever actually bought.

import { cachedCall, cacheKey } from "../../cache";
import { mapVerificationStatus } from "../verification";
import type { Rung, RungCallResult, RungContext } from "../waterfall";

const APOLLO_MATCH_URL = "https://api.apollo.io/v1/people/match";
/** Not in rates.json (Apollo isn't bought, so the estimator never needs a real number) — a
 *  documented placeholder only used if a key is ever actually configured. */
export const APOLLO_MATCH_COST_USD = 0.1;

export interface ApolloMatchData {
  email?: string;
  emailStatus?: string;
}

export interface ApolloCallOpts {
  key: string;
  fetchImpl?: typeof fetch;
}

/** Minimal people/match call — never throws; a non-2xx or network error returns `{error}`, matching
 *  the `cachedCall` soft-failure convention every other rung already uses. */
export async function apolloPeopleMatch(
  input: { firstName?: string; lastName?: string; fullName?: string; domain?: string; organizationName?: string },
  opts: ApolloCallOpts,
): Promise<{ error: string } | ApolloMatchData> {
  try {
    const fetchImpl = opts.fetchImpl ?? fetch;
    const r = await fetchImpl(APOLLO_MATCH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Api-Key": opts.key },
      body: JSON.stringify({
        first_name: input.firstName,
        last_name: input.lastName,
        name: input.fullName,
        domain: input.domain,
        organization_name: input.organizationName,
        reveal_personal_emails: false,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) return { error: `apollo ${r.status}` };
    const j = (await r.json().catch(() => null)) as { person?: { email?: string; email_status?: string } } | null;
    if (!j?.person) return { error: "apollo: no person in response" };
    return { email: j.person.email, emailStatus: j.person.email_status };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

export interface ApolloDeps {
  apolloPeopleMatch: typeof apolloPeopleMatch;
  cachedCall: typeof cachedCall;
  cacheKey: typeof cacheKey;
}

export const defaultApolloDeps: ApolloDeps = { apolloPeopleMatch, cachedCall, cacheKey };

export function apolloEnabled(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.CLARA_APOLLO_API_KEY?.trim());
}

export async function callApollo(ctx: RungContext, deps: ApolloDeps = defaultApolloDeps): Promise<RungCallResult> {
  const key = process.env.CLARA_APOLLO_API_KEY?.trim();
  if (!key) return { hit: false, costUsd: 0, reason: "not_configured" };
  if (!ctx.person) return { hit: false, costUsd: 0, reason: "no target person" };
  if (!ctx.domain && !ctx.companyName) return { hit: false, costUsd: 0, reason: "no domain or company name" };

  const cached = await deps.cachedCall({
    provider: "apollo",
    kind: "email",
    key: deps.cacheKey(["apollo_people_match", ctx.domain ?? ctx.companyName, ctx.person.fullName]),
    jobId: ctx.jobId,
    companyId: ctx.companyId,
    costUsd: APOLLO_MATCH_COST_USD,
    allowLive: ctx.allowLive,
    fn: () => deps.apolloPeopleMatch(
      { firstName: ctx.person!.firstName, lastName: ctx.person!.lastName, fullName: ctx.person!.fullName, domain: ctx.domain, organizationName: ctx.companyName },
      { key },
    ),
  });
  if (cached.skipped) return { hit: false, costUsd: 0, reason: "shadow mode" };
  const data = cached.value as ApolloMatchData | undefined;
  if (!data?.email) return { hit: false, costUsd: cached.costUsd, reason: "apollo found nothing" };

  return {
    hit: true,
    kind: "email",
    value: data.email,
    provider: "apollo",
    confidence: data.emailStatus === "verified" ? 0.6 : 0.4,
    verificationStatus: mapVerificationStatus({ provider: "apollo", verdict: "deliverable", isFinderOnly: true }),
    costUsd: cached.costUsd,
    raw: data,
  };
}

export const apolloRung: Rung = {
  id: "apollo_match",
  enabled: apolloEnabled,
  gate: (ctx) => Boolean(ctx.person && (ctx.domain || ctx.companyName)),
  costUnits: 2,
  call: (ctx) => callApollo(ctx),
};
