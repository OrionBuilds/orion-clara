// §6 — validate and normalize the planner's JSON into a JobSpec. Pure.
//
// The planner is a model; this is the contract. Anything the model got wrong (a radius of 1,000
// miles, an enrichment we don't have, a gate lowered below the floor) is corrected here rather than
// trusted, so the orchestrator never sees a spec it can't run.

import { ALL_ENRICHMENTS, type DiscoverySource, type Enrichment, type JobGates, type JobSpec } from "./types";

export const DEFAULT_RADIUS_MILES = 100;
export const MAX_RADIUS_MILES = 300;
export const DEFAULT_MAX_RECORDS = 5_000;
export const MAX_RECORDS_CEILING = 100_000;

/** §31 floors. The planner may raise these when the owner names a number; it never lowers them. */
export const DEFAULT_GATES: JobGates = {
  deep_research_min: 60,
  contact_search_min: 70,
  mobile_search_min: 80,
  allow_mobile: true,
  mobile_share_max: 0.3,
};

export const DEFAULT_QUERIES: Record<string, string[]> = {
  roofing: ["roofing contractor", "roofer", "roof repair", "roof replacement"],
  hvac: ["hvac contractor", "air conditioning repair", "ac installation", "heating and cooling"],
  "air condition": ["hvac contractor", "air conditioning repair", "ac installation", "heating and cooling"],
  plumb: ["plumber", "plumbing contractor", "drain cleaning", "water heater installation"],
  electric: ["electrician", "electrical contractor", "panel upgrade", "generator installation"],
  "garage door": ["garage door repair", "garage door installation"],
  pest: ["pest control", "exterminator", "termite control"],
  pool: ["pool service", "pool cleaning", "pool builder", "pool repair"],
  solar: ["solar installer", "solar panel installation", "solar company"],
  remodel: ["remodeling contractor", "kitchen remodeling", "bathroom remodeling"],
  restoration: ["water damage restoration", "fire damage restoration", "mold remediation"],
  "real estate": ["real estate team", "real estate brokerage", "realtor"],
  "law firm": ["law firm", "personal injury attorney", "family law attorney", "estate planning attorney"],
  attorney: ["law firm", "personal injury attorney", "family law attorney", "estate planning attorney"],
  wealth: ["financial advisor", "wealth management firm", "registered investment advisor"],
  "financial advis": ["financial advisor", "wealth management firm", "registered investment advisor"],
  staffing: ["staffing agency", "recruiting firm", "employment agency"],
  "property manage": ["property management company", "apartment management", "hoa management"],
};

const US_STATES = new Set([
  "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA","KS","KY","LA","ME","MD","MA","MI","MN","MS","MO",
  "MT","NE","NV","NH","NJ","NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT","VA","WA","WV","WI","WY","DC",
]);

const STATE_NAMES: Record<string, string> = {
  florida: "FL", georgia: "GA", texas: "TX", california: "CA", "new york": "NY", alabama: "AL", tennessee: "TN",
  "north carolina": "NC", "south carolina": "SC", ohio: "OH", illinois: "IL", arizona: "AZ", colorado: "CO",
};

export function normalizeState(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const t = raw.trim();
  if (!t) return undefined;
  const up = t.toUpperCase();
  if (US_STATES.has(up)) return up;
  return STATE_NAMES[t.toLowerCase()];
}

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Number(v) : undefined);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter(Boolean) : typeof v === "string" && v.trim() ? [v.trim()] : []);

/** Which query set fits an industry list — roofing today; the table grows with the verticals. */
export function queriesFor(industry: string[]): string[] {
  const hay = industry.join(" ").toLowerCase();
  for (const [k, qs] of Object.entries(DEFAULT_QUERIES)) if (hay.includes(k)) return qs;
  // Unknown vertical: search the industry phrases themselves.
  return industry.slice(0, 3);
}

export interface NormalizeResult { ok: boolean; spec?: JobSpec; errors: string[]; warnings: string[] }

export function normalizeJobSpec(raw: unknown): NormalizeResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;

  const industry = strList(r.industry).map((s) => s.toLowerCase());
  if (!industry.length) errors.push("industry is required (e.g. \"roofing contractor\")");

  const loc = (r.location && typeof r.location === "object" ? r.location : {}) as Record<string, unknown>;
  const label = typeof loc.label === "string" && loc.label.trim() ? loc.label.trim()
    : [loc.city, loc.state].filter((x) => typeof x === "string" && x).join(", ");
  if (!label) errors.push("location is required (a city, region or state)");
  let radius = num(loc.radius_miles) ?? DEFAULT_RADIUS_MILES;
  if (radius > MAX_RADIUS_MILES) { warnings.push(`radius ${radius} mi capped at ${MAX_RADIUS_MILES}`); radius = MAX_RADIUS_MILES; }
  radius = clamp(Math.round(radius), 1, MAX_RADIUS_MILES);
  const lat = num(loc.lat), lng = num(loc.lng);

  const req = (r.requirements && typeof r.requirements === "object" ? r.requirements : {}) as Record<string, unknown>;
  const requirements = {
    estimated_revenue_min: num(req.estimated_revenue_min),
    estimated_revenue_max: num(req.estimated_revenue_max),
    min_rating: num(req.min_rating) !== undefined ? clamp(num(req.min_rating)!, 0, 5) : undefined,
    min_reviews: num(req.min_reviews),
    min_employees: num(req.min_employees),
    max_employees: num(req.max_employees),
  };
  for (const k of Object.keys(requirements) as (keyof typeof requirements)[]) if (requirements[k] === undefined) delete requirements[k];
  if (requirements.estimated_revenue_min !== undefined && requirements.estimated_revenue_max !== undefined && requirements.estimated_revenue_min > requirements.estimated_revenue_max) {
    [requirements.estimated_revenue_min, requirements.estimated_revenue_max] = [requirements.estimated_revenue_max, requirements.estimated_revenue_min];
    warnings.push("revenue range was reversed; swapped");
  }

  const wanted = strList(r.enrichments).map((e) => e.toLowerCase().replace(/[\s-]+/g, "_"));
  const enrichments: Enrichment[] = [];
  for (const e of wanted) {
    const hit = (ALL_ENRICHMENTS as readonly string[]).includes(e) ? (e as Enrichment)
      : e === "phone" || e === "cell" || e === "mobile_number" ? "mobile"
      : e === "rating" ? "google_rating" : e === "reviews" ? "review_count"
      : e === "decision_maker" || e === "ceo" ? "owner" : e === "tech" || e === "crm" ? "technology" : e === "ads" ? "advertising" : null;
    if (hit && !enrichments.includes(hit)) enrichments.push(hit);
    else if (!hit) warnings.push(`unknown enrichment "${e}" dropped`);
  }
  if (!enrichments.length) enrichments.push("website", "google_rating", "review_count", "employees", "technology");
  // Emails need an owner; mobiles need an email first (§14). Add the prerequisites quietly.
  if (enrichments.includes("mobile") && !enrichments.includes("email")) enrichments.push("email");
  if (enrichments.includes("email") && !enrichments.includes("owner")) enrichments.push("owner");

  const srcRaw = strList(r.sources).map((s) => s.toLowerCase());
  const sources = srcRaw.filter((s): s is DiscoverySource => s === "places" || s === "brave" || s === "exa");
  if (!sources.length) sources.push("places", "brave");

  let max_records = num(r.max_records) ?? DEFAULT_MAX_RECORDS;
  max_records = clamp(Math.round(max_records), 1, MAX_RECORDS_CEILING);

  const g = (r.gates && typeof r.gates === "object" ? r.gates : {}) as Record<string, unknown>;
  const gates: JobGates = {
    deep_research_min: Math.max(DEFAULT_GATES.deep_research_min, clamp(num(g.deep_research_min) ?? DEFAULT_GATES.deep_research_min, 0, 100)),
    contact_search_min: Math.max(DEFAULT_GATES.contact_search_min, clamp(num(g.contact_search_min) ?? DEFAULT_GATES.contact_search_min, 0, 100)),
    mobile_search_min: Math.max(DEFAULT_GATES.mobile_search_min, clamp(num(g.mobile_search_min) ?? DEFAULT_GATES.mobile_search_min, 0, 100)),
    allow_mobile: typeof g.allow_mobile === "boolean" ? g.allow_mobile : enrichments.includes("mobile"),
    mobile_share_max: clamp(num(g.mobile_share_max) ?? DEFAULT_GATES.mobile_share_max, 0, 1),
  };
  if (num(g.deep_research_min) !== undefined && num(g.deep_research_min)! < DEFAULT_GATES.deep_research_min) warnings.push("deep_research_min raised to the floor of 60");

  const queries = strList(r.queries).length ? strList(r.queries) : queriesFor(industry);
  const title = typeof r.title === "string" && r.title.trim()
    ? r.title.trim().slice(0, 120)
    : `${industry[0] ?? "companies"} within ${radius} mi of ${label}`;

  if (errors.length) return { ok: false, errors, warnings };
  return {
    ok: true, errors, warnings,
    spec: {
      entity: "company", title, industry,
      location: { label, city: typeof loc.city === "string" ? loc.city.trim() || undefined : undefined, state: normalizeState(loc.state), lat, lng, radius_miles: radius },
      requirements, enrichments, sources, max_records, gates, queries,
    },
  };
}

/** One paragraph of what the job will do, for the plan reply and the Office card. */
export function describeSpec(spec: JobSpec): string {
  const bits: string[] = [];
  bits.push(`${spec.industry.join(" / ")} within ${spec.location.radius_miles} miles of ${spec.location.label}`);
  const r = spec.requirements;
  if (r.estimated_revenue_min !== undefined || r.estimated_revenue_max !== undefined) {
    const lo = r.estimated_revenue_min !== undefined ? `$${(r.estimated_revenue_min / 1e6).toFixed(r.estimated_revenue_min % 1e6 ? 1 : 0)}M` : "";
    const hi = r.estimated_revenue_max !== undefined ? `$${(r.estimated_revenue_max / 1e6).toFixed(r.estimated_revenue_max % 1e6 ? 1 : 0)}M` : "";
    bits.push(lo && hi ? `revenue ${lo}–${hi}` : lo ? `revenue above ${lo}` : `revenue below ${hi}`);
  }
  if (r.min_rating !== undefined) bits.push(`${r.min_rating}+ Google rating`);
  if (r.min_reviews !== undefined) bits.push(`${r.min_reviews}+ reviews`);
  if (r.min_employees !== undefined || r.max_employees !== undefined) bits.push(`${r.min_employees ?? "any"}–${r.max_employees ?? "any"} employees`);
  const enr = spec.enrichments.filter((e) => e !== "website").map((e) => e.replace("_", " "));
  if (enr.length) bits.push(`then find: ${enr.join(", ")}`);
  return bits.join("; ") + `. Up to ${spec.max_records.toLocaleString()} companies.`;
}
