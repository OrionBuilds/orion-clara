// intel/buyerDiscovery.ts — stage 80 (find_people, buyer.discover)'s collaborator: finds ONE
// decision maker for a qualified company and writes them to the company graph.
//
// Size bucket (employees, falling back to revenue, falling back to review count — PR 9's revenue
// estimator notes no fact source feeds `employees` yet, so this almost always falls through to
// revenue/reviews in practice, exactly as the plan's "employees fallback revenue/reviews" phrasing
// anticipates) picks which personas (title patterns + a company_people.role_type) are worth looking
// for, then a free-first source ladder tries each in turn, stopping at the first hit:
//   1. extracted owner   — the `owner` fact PR 8's extractFacts.ts already wrote off the site (free)
//   2. DBPR qualifying agent — the licensee of record on an active FL contractor license (free, PR 9)
//   3. Sunbiz officers    — the entity's registered officers (free, PR 9)
//   4. website /team page — a fresh tier-2 LLM extraction over the site's own team/about page (free)
//   5. LinkedIn via FRIDAY — postProspectLookup's prospect.linkedin_lookup (free to Clara; shares
//      FRIDAY's own Agent-Reach daily caps — see agent-core/src/interagent/prospect.ts)
//   6. Apollo              — not bought (no CLARA_APOLLO_API_KEY anywhere); always `not_configured`
//      in this deploy, wired so a future key only has to be set, not coded.
//
// A hit writes a company_people row (company_people_upsert) and, once that row has a real id, a
// `decision_maker` fact citing the source. No hit is a normal, logged outcome — stage 80 just fans
// out nothing further for this company (no email/phone search without a name to search for).

import { factsList as factsListReal, companyPeopleUpsert as companyPeopleUpsertReal, factsAdd as factsAddReal, OsProspectingUnavailableError, type FactInput, type PersonRoleType } from "../osBridge";
import { runFloridaPublicDataForCompany as runFloridaPublicDataForCompanyReal, type RunFloridaPublicDataResult } from "../publicdata";
import { pickPages as pickPagesReal } from "../crawler/pagePicker";
import { crawlPage as crawlPageReal } from "../crawler/waterfall";
import { runTier as runTierReal } from "../llm";
import { normalizeDomain } from "../entity/normalize";
import { loadConfig as loadConfigReal } from "../../config";
import { postProspectLookup as postProspectLookupReal, type ProspectLookupResponse } from "@autom8ionlab/agent-core";

export type SizeBucket = "small" | "mid" | "large";

export interface SizeInputs {
  employees?: number;
  revenueLow?: number | null;
  revenueHigh?: number | null;
  reviewCount?: number;
}

/** Pure. §19-flavored thresholds: ≤10 employees (or <$2M revenue, or <50 reviews) reads as an
 *  owner-operator shop; 11-50 (or $2-10M, or 50-200 reviews) as a small-team shop with a GM; 51+
 *  (or $10M+, or 200+ reviews) as an organization with a titled leadership layer. Falls back to
 *  "small" — the conservative default — when nothing is known at all, since an owner/founder
 *  persona is the safest guess for an under-documented company. */
export function sizeBucket(input: SizeInputs): SizeBucket {
  if (typeof input.employees === "number" && input.employees > 0) {
    if (input.employees <= 10) return "small";
    if (input.employees <= 50) return "mid";
    return "large";
  }
  const revenues = [input.revenueLow, input.revenueHigh].filter((v): v is number => typeof v === "number" && v > 0);
  if (revenues.length) {
    const mid = revenues.reduce((a, b) => a + b, 0) / revenues.length;
    if (mid < 2_000_000) return "small";
    if (mid < 10_000_000) return "mid";
    return "large";
  }
  if (typeof input.reviewCount === "number" && input.reviewCount > 0) {
    if (input.reviewCount < 50) return "small";
    if (input.reviewCount < 200) return "mid";
    return "large";
  }
  return "small";
}

export interface Persona {
  roleType: PersonRoleType;
  /** Title substrings to match against, case-insensitive, most-wanted first. */
  titles: string[];
}

export function personasForSize(bucket: SizeBucket): Persona[] {
  switch (bucket) {
    case "small":
      return [{ roleType: "owner", titles: ["Owner", "Founder", "President"] }];
    case "mid":
      return [
        { roleType: "owner", titles: ["Owner", "Founder", "President"] },
        { roleType: "gm", titles: ["General Manager", "Operations Manager", "Branch Manager"] },
      ];
    case "large":
      return [
        { roleType: "ceo", titles: ["CEO", "Chief Executive Officer", "President"] },
        { roleType: "gm", titles: ["General Manager", "VP of Operations", "VP Operations"] },
        { roleType: "sales_leader", titles: ["VP of Sales", "Sales Director", "Director of Sales"] },
      ];
  }
}

const TITLE_ROLE_PATTERNS: readonly [RegExp, PersonRoleType][] = [
  [/owner|founder|principal/i, "owner"],
  [/chief executive|^ceo\b|\bceo\b/i, "ceo"],
  [/general manager|^gm\b|\bgm\b|operations manager|branch manager/i, "gm"],
  [/sales|business development/i, "sales_leader"],
  [/operations|\bops\b|^coo\b/i, "ops"],
  [/marketing/i, "marketing"],
];

/** Pure: a free-text title to the closest company_people.role_type, "other" when nothing matches. */
export function titleToRole(title: string | undefined): PersonRoleType {
  if (!title) return "other";
  for (const [re, role] of TITLE_ROLE_PATTERNS) if (re.test(title)) return role;
  return "other";
}

/** Pure: from a list of named-and-titled candidates (Sunbiz officers, a team-page extraction),
 *  picks the one whose title best matches `personas`' preference order; falls back to any candidate
 *  whose title resolves to a recognized role, then to the first candidate at all. Shared by the
 *  Sunbiz-officers and website-team rungs below so "which of several named people is the right
 *  persona" logic lives in exactly one place. */
export function pickBestNamedTitle<T extends { title?: string }>(items: readonly T[], personas: readonly Persona[]): T | undefined {
  if (!items.length) return undefined;
  for (const persona of personas) {
    const m = items.find((i) => i.title && persona.titles.some((t) => i.title!.toLowerCase().includes(t.toLowerCase())));
    if (m) return m;
  }
  return items.find((i) => titleToRole(i.title) !== "other") ?? items[0];
}

export type DiscoverySource = "extracted_owner" | "dbpr" | "sunbiz" | "website_team" | "linkedin" | "apollo";

export interface DiscoveredPerson {
  fullName: string;
  firstName?: string;
  lastName?: string;
  title?: string;
  roleType: PersonRoleType;
  linkedinUrl?: string;
  confidence: number;
  sourceUrl?: string;
  source: DiscoverySource;
}

export interface LadderLogEntry {
  source: DiscoverySource;
  outcome: "hit" | "miss" | "skipped";
  reason?: string;
}

export interface BuyerDiscoveryCompany {
  id: string;
  name: string;
  website_url?: string;
  city?: string;
  state?: string;
  employees_estimate?: number;
  revenue_low?: number | null;
  revenue_high?: number | null;
  review_count?: number;
}

export interface BuyerDiscoveryOpts {
  jobId?: string;
  allowLive: boolean;
}

// ── Apollo (ladder step 6) — self-contained; see module doc. Separate from contacts/rungs/
// apollo.ts's people/match call (that one needs a name already; this needs a TITLE-based search to
// find out who the name even is), so it gets its own tiny client here rather than importing one
// shaped for the wrong question. ─────────────────────────────────────────────────────────────────
const APOLLO_SEARCH_URL = "https://api.apollo.io/v1/mixed_people/search";
export const APOLLO_SEARCH_COST_USD = 0.1; // undocumented in rates.json — Apollo isn't bought; see module doc.

export interface ApolloCandidate {
  name: string;
  title?: string;
  linkedinUrl?: string;
}

export async function apolloOrgPeopleSearch(
  input: { domain?: string; organizationName?: string; titles: string[] },
  opts: { key: string; fetchImpl?: typeof fetch },
): Promise<{ error: string } | { people: ApolloCandidate[] }> {
  try {
    const fetchImpl = opts.fetchImpl ?? fetch;
    const r = await fetchImpl(APOLLO_SEARCH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Api-Key": opts.key },
      body: JSON.stringify({ q_organization_domains: input.domain, organization_name: input.organizationName, person_titles: input.titles, page: 1, per_page: 3 }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) return { error: `apollo ${r.status}` };
    const j = (await r.json().catch(() => null)) as { people?: { name?: unknown; title?: unknown; linkedin_url?: unknown }[] } | null;
    const people = (j?.people ?? [])
      .filter((p): p is { name: string; title?: string; linkedin_url?: string } => typeof p.name === "string")
      .map((p) => ({ name: p.name, title: typeof p.title === "string" ? p.title : undefined, linkedinUrl: typeof p.linkedin_url === "string" ? p.linkedin_url : undefined }));
    return { people };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

// ── Team-page extraction (ladder step 4) ────────────────────────────────────────────────────────
export function buildTeamPagePrompt(text: string, personas: readonly Persona[]): string {
  const titles = personas.flatMap((p) => p.titles).join(", ");
  return [
    `From this company "team"/"about" page text, list the NAMED people and their titles.`,
    `Prefer someone whose title matches one of: ${titles}.`,
    `Reply ONLY JSON: {"people":[{"name":"...", "title":"..."}]}. If no named person with a title appears, reply {"people":[]}.`,
    "",
    "PAGE TEXT:",
    text,
  ].join("\n");
}

export interface BuyerDiscoveryDeps {
  factsList: typeof factsListReal;
  runFloridaPublicDataForCompany: typeof runFloridaPublicDataForCompanyReal;
  pickPages: typeof pickPagesReal;
  crawlPage: typeof crawlPageReal;
  readFile: (path: string) => Promise<string>;
  runTier: typeof runTierReal;
  postProspectLookup: typeof postProspectLookupReal;
  loadConfig: typeof loadConfigReal;
  apolloOrgPeopleSearch: typeof apolloOrgPeopleSearch;
  companyPeopleUpsert: typeof companyPeopleUpsertReal;
  factsAdd: typeof factsAddReal;
}

async function defaultReadFile(path: string): Promise<string> {
  const { promises: fs } = await import("node:fs");
  return fs.readFile(path, "utf8");
}

export const defaultBuyerDiscoveryDeps: BuyerDiscoveryDeps = {
  factsList: factsListReal,
  runFloridaPublicDataForCompany: runFloridaPublicDataForCompanyReal,
  pickPages: pickPagesReal,
  crawlPage: crawlPageReal,
  readFile: defaultReadFile,
  runTier: runTierReal,
  postProspectLookup: postProspectLookupReal,
  loadConfig: loadConfigReal,
  apolloOrgPeopleSearch,
  companyPeopleUpsert: companyPeopleUpsertReal,
  factsAdd: factsAddReal,
};

async function fromExtractedOwner(company: BuyerDiscoveryCompany, deps: BuyerDiscoveryDeps): Promise<DiscoveredPerson | undefined> {
  const facts = await deps.factsList({ subject_type: "company", subject_id: company.id, field_name: "owner" }).catch(() => []);
  const fact = facts.find((f) => typeof f.value === "string" && (f.value as string).trim());
  if (!fact) return undefined;
  return { fullName: (fact.value as string).trim(), roleType: "owner", confidence: fact.confidence ?? 0.6, source: "extracted_owner" };
}

function fromPublicData(pub: RunFloridaPublicDataResult, personas: readonly Persona[]): { dbpr?: DiscoveredPerson; sunbiz?: DiscoveredPerson } {
  const activeDbpr = pub.dbpr.find((r) => r.statusActive) ?? pub.dbpr[0];
  const dbpr = activeDbpr?.licenseeName
    ? { fullName: activeDbpr.licenseeName, roleType: "owner" as const, confidence: 0.55, source: "dbpr" as const }
    : undefined;

  const officers = pub.sunbiz.flatMap((r) => r.officers ?? []);
  const officer = pickBestNamedTitle(officers, personas);
  const sunbiz = officer
    ? { fullName: officer.name, title: officer.title, roleType: titleToRole(officer.title), confidence: 0.5, source: "sunbiz" as const }
    : undefined;

  return { dbpr, sunbiz };
}

async function fromTeamPage(company: BuyerDiscoveryCompany, personas: readonly Persona[], deps: BuyerDiscoveryDeps): Promise<{ person?: DiscoveredPerson; reason?: string }> {
  if (!company.website_url) return { reason: "no website_url" };
  const pages = deps.pickPages(company.website_url);
  const teamUrl = pages.find((u) => /team/i.test(u)) ?? `${company.website_url.replace(/\/$/, "")}/team`;
  const page = await deps.crawlPage(teamUrl, { companyId: company.id }).catch(() => null);
  if (!page?.ok || !page.evidence) return { reason: page?.reason ?? page?.error ?? "team page not reachable" };
  const text = await deps.readFile(page.evidence.txtPath).catch(() => "");
  if (!text.trim()) return { reason: "team page empty" };

  const r = await deps.runTier(2, buildTeamPagePrompt(text.slice(0, 6000), personas), { purpose: "prospect:buyer_discovery", json: true, maxTokens: 300 });
  if (!r.ok || !r.text) return { reason: "team-page extraction failed" };
  let people: { name?: unknown; title?: unknown }[] = [];
  try {
    people = (JSON.parse(r.text) as { people?: { name?: unknown; title?: unknown }[] }).people ?? [];
  } catch {
    return { reason: "unparseable team-page extraction" };
  }
  const named = people.filter((p): p is { name: string; title?: string } => typeof p.name === "string" && p.name.trim().length > 0);
  const best = pickBestNamedTitle(named, personas);
  if (!best) return { reason: "no named person on team page" };
  return { person: { fullName: best.name, title: best.title, roleType: titleToRole(best.title), confidence: 0.5, source: "website_team", sourceUrl: teamUrl } };
}

async function fromLinkedIn(company: BuyerDiscoveryCompany, personas: readonly Persona[], opts: BuyerDiscoveryOpts, deps: BuyerDiscoveryDeps): Promise<{ person?: DiscoveredPerson; reason?: string; skipped?: boolean }> {
  if (!opts.allowLive) return { skipped: true, reason: "shadow mode" };
  const cfg = await deps.loadConfig();
  if (!cfg.fridayBaseUrl) return { skipped: true, reason: "FRIDAY base url not configured" };

  const res: ProspectLookupResponse = await deps.postProspectLookup(cfg.fridayBaseUrl, {
    from: "clara",
    kind: "prospect.linkedin_lookup",
    input: {
      company: { name: company.name, domain: company.website_url ? normalizeDomain(company.website_url) : undefined, city: company.city, state: company.state },
      personas: personas.flatMap((p) => p.titles).slice(0, 5),
      max_profiles: 2,
    },
  });
  if (!res.ok) return { reason: res.error, skipped: res.refused || res.not_logged_in || res.locked };
  if (res.kind !== "prospect.linkedin_lookup") return { reason: "unexpected lookup kind in response" };
  const best = res.people[0];
  if (!best) return { reason: res.skipped_reason ?? "no LinkedIn profiles found" };
  return { person: { fullName: best.full_name, title: best.title, roleType: titleToRole(best.title), confidence: best.confidence, source: "linkedin", sourceUrl: best.linkedin_url, linkedinUrl: best.linkedin_url } };
}

async function fromApollo(company: BuyerDiscoveryCompany, personas: readonly Persona[], opts: BuyerDiscoveryOpts, deps: BuyerDiscoveryDeps): Promise<{ person?: DiscoveredPerson; costUsd: number; reason?: string; skipped?: boolean }> {
  const key = process.env.CLARA_APOLLO_API_KEY?.trim();
  if (!key) return { costUsd: 0, skipped: true, reason: "not_configured" };
  if (!opts.allowLive) return { costUsd: 0, skipped: true, reason: "shadow mode" };
  const domain = company.website_url ? normalizeDomain(company.website_url) : undefined;
  if (!domain && !company.name) return { costUsd: 0, skipped: true, reason: "no domain or name" };

  const res = await deps.apolloOrgPeopleSearch({ domain, organizationName: company.name, titles: personas.flatMap((p) => p.titles).slice(0, 8) }, { key });
  if ("error" in res) return { costUsd: APOLLO_SEARCH_COST_USD, reason: res.error };
  const best = pickBestNamedTitle(res.people, personas);
  if (!best) return { costUsd: APOLLO_SEARCH_COST_USD, reason: "no matching person" };
  return { costUsd: APOLLO_SEARCH_COST_USD, person: { fullName: best.name, title: best.title, roleType: titleToRole(best.title), confidence: 0.5, source: "apollo", linkedinUrl: best.linkedinUrl } };
}

export interface LadderResult {
  person?: DiscoveredPerson;
  log: LadderLogEntry[];
  costUsd: number;
}

/** The source ladder, no OS writes — pure orchestration over injected deps, directly unit-testable
 *  against fakes. buyerDiscover() below adds the company_people_upsert/facts_add write. */
export async function discoverBuyer(company: BuyerDiscoveryCompany, opts: BuyerDiscoveryOpts, deps: BuyerDiscoveryDeps = defaultBuyerDiscoveryDeps): Promise<LadderResult> {
  const bucket = sizeBucket({ employees: company.employees_estimate, revenueLow: company.revenue_low, revenueHigh: company.revenue_high, reviewCount: company.review_count });
  const personas = personasForSize(bucket);
  const log: LadderLogEntry[] = [];
  let costUsd = 0;

  const owner = await fromExtractedOwner(company, deps);
  if (owner) { log.push({ source: "extracted_owner", outcome: "hit" }); return { person: owner, log, costUsd }; }
  log.push({ source: "extracted_owner", outcome: "miss", reason: "no owner fact" });

  const pub = await deps.runFloridaPublicDataForCompany({ id: company.id, name: company.name, city: company.city, state: company.state }, { jobId: opts.jobId, allowLive: opts.allowLive });
  const { dbpr, sunbiz } = fromPublicData(pub, personas);
  if (dbpr) { log.push({ source: "dbpr", outcome: "hit" }); return { person: dbpr, log, costUsd }; }
  log.push({ source: "dbpr", outcome: "miss", reason: pub.dbpr.length ? "no licensee name on an active license" : "no DBPR match" });

  if (sunbiz) { log.push({ source: "sunbiz", outcome: "hit" }); return { person: sunbiz, log, costUsd }; }
  log.push({ source: "sunbiz", outcome: "miss", reason: pub.sunbiz.length ? "no matching officer" : "no Sunbiz match" });

  const team = await fromTeamPage(company, personas, deps);
  if (team.person) { log.push({ source: "website_team", outcome: "hit" }); return { person: team.person, log, costUsd }; }
  log.push({ source: "website_team", outcome: company.website_url ? "miss" : "skipped", reason: team.reason });

  const linkedin = await fromLinkedIn(company, personas, opts, deps);
  if (linkedin.person) { log.push({ source: "linkedin", outcome: "hit" }); return { person: linkedin.person, log, costUsd }; }
  log.push({ source: "linkedin", outcome: linkedin.skipped ? "skipped" : "miss", reason: linkedin.reason });

  const apollo = await fromApollo(company, personas, opts, deps);
  costUsd += apollo.costUsd;
  if (apollo.person) { log.push({ source: "apollo", outcome: "hit" }); return { person: apollo.person, log, costUsd }; }
  log.push({ source: "apollo", outcome: apollo.skipped ? "skipped" : "miss", reason: apollo.reason });

  return { person: undefined, log, costUsd };
}

const SOURCE_TO_FACT_SOURCE_TYPE: Record<DiscoverySource, FactInput["source_type"]> = {
  extracted_owner: "derived",
  dbpr: "dbpr",
  sunbiz: "sunbiz",
  website_team: "website_page",
  linkedin: "linkedin",
  apollo: "provider",
};

export interface BuyerDiscoverResult extends LadderResult {
  personId?: string;
}

/**
 * Runs the ladder, and on a hit writes the company_people row (company_people_upsert — idempotent
 * on company+name) and, once that write returns a real id, a `decision_maker` fact citing the
 * source. Both writes are best-effort against OsProspectingUnavailableError (swallowed, same
 * convention every other PR 9/stages.ts write already follows) — a found person with no OS write is
 * still reported back to the caller (stages.ts's find_people handler) so the job can keep moving in
 * shadow mode or against a not-yet-live OS.
 */
export async function buyerDiscover(company: BuyerDiscoveryCompany, opts: BuyerDiscoveryOpts, deps: BuyerDiscoveryDeps = defaultBuyerDiscoveryDeps): Promise<BuyerDiscoverResult> {
  const ladder = await discoverBuyer(company, opts, deps);
  if (!ladder.person) return ladder;

  let personId: string | undefined;
  try {
    const up = await deps.companyPeopleUpsert({
      company_id: company.id,
      full_name: ladder.person.fullName,
      first_name: ladder.person.firstName,
      last_name: ladder.person.lastName,
      title: ladder.person.title,
      role_type: ladder.person.roleType,
      is_decision_maker: true,
      linkedin_url: ladder.person.linkedinUrl,
      source: ladder.person.source,
      source_url: ladder.person.sourceUrl,
      confidence: ladder.person.confidence,
    });
    personId = up.person?.id;
  } catch (e) {
    if (!(e instanceof OsProspectingUnavailableError)) throw e;
  }

  if (personId) {
    try {
      await deps.factsAdd({
        research_job_id: opts.jobId,
        facts: [{
          subject_type: "person",
          subject_id: personId,
          company_id: company.id,
          field_name: "decision_maker",
          value: { name: ladder.person.fullName, title: ladder.person.title, role_type: ladder.person.roleType },
          source_type: SOURCE_TO_FACT_SOURCE_TYPE[ladder.person.source],
          source_url: ladder.person.sourceUrl,
          confidence: ladder.person.confidence,
        }],
      });
    } catch (e) {
      if (!(e instanceof OsProspectingUnavailableError)) throw e;
    }
  }

  return { ...ladder, personId };
}
