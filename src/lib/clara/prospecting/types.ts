// Clara — Prospect Intelligence Engine: shared types.
//
// The engine turns a natural-language ask ("roofing companies within 100 miles of Tampa, owner
// emails") into a research job that the OS holds (research_jobs / research_tasks / provider_requests
// tables) and Clara's scheduler works through, stage by stage, cheapest first. Everything here is
// plain data; the OS MCP tools in orion/mcp-server/src/tools/prospects.ts are the source of truth
// for the column shapes these mirror.

export type ProspectingMode = "off" | "shadow" | "active";

/**
 * off    — the scheduler job is a no-op.
 * shadow — plans, estimates and free/cached discovery only: no paid provider calls, no delivery.
 *          The default until the owner flips it, so a fresh deploy can never spend.
 * active — the real thing.
 */
export function prospectingMode(env: NodeJS.ProcessEnv = process.env): ProspectingMode {
  const v = (env.CLARA_PROSPECTING ?? "shadow").trim().toLowerCase();
  return v === "off" || v === "active" ? v : "shadow";
}

export type DiscoverySource = "places" | "brave" | "exa";

export type Enrichment =
  | "website" | "google_rating" | "review_count" | "owner" | "email" | "mobile"
  | "employees" | "technology" | "advertising" | "hiring" | "revenue";

export const ALL_ENRICHMENTS: readonly Enrichment[] = [
  "website", "google_rating", "review_count", "owner", "email", "mobile",
  "employees", "technology", "advertising", "hiring", "revenue",
];

export interface JobLocation {
  /** What the owner said: "Tampa", "Tampa, FL", "the Tampa Bay area". */
  label: string;
  city?: string;
  /** Two-letter state. */
  state?: string;
  lat?: number;
  lng?: number;
  radius_miles: number;
}

export interface JobRequirements {
  estimated_revenue_min?: number;
  estimated_revenue_max?: number;
  min_rating?: number;
  min_reviews?: number;
  min_employees?: number;
  max_employees?: number;
}

/** The enrichment-funnel gates (§20/§31). Fit-score thresholds; the planner never lowers them. */
export interface JobGates {
  deep_research_min: number;
  contact_search_min: number;
  mobile_search_min: number;
  allow_mobile: boolean;
  /** Mobiles requested as a share of qualified companies (cost control). */
  mobile_share_max: number;
}

/** §6 — the query planner's output; the machine-executable definition of a research job. */
export interface JobSpec {
  entity: "company";
  title: string;
  industry: string[];
  location: JobLocation;
  requirements: JobRequirements;
  enrichments: Enrichment[];
  sources: DiscoverySource[];
  max_records: number;
  gates: JobGates;
  /** Discovery query templates ("roofing contractor", "roofer", "roof repair"). */
  queries: string[];
}

/** §20 — one count per funnel step; the OS keeps the live version on research_jobs.funnel. */
export interface FunnelCounts {
  discovered: number;
  in_industry: number;
  active_website: number;
  pass_icp: number;
  ai_qualified: number;
  dm_found: number;
  email_found: number;
  mobile_requested: number;
  mobile_found: number;
}

/** §31 — the cost table shown before anything runs. Dollars, rounded to cents. */
export interface Estimate {
  discovery: number;
  web_research: number;
  ai: number;
  email_lookup: number;
  mobile_lookup: number;
  total: number;
  eta_hours: number;
  assumptions: {
    cells: number;
    expected: FunnelCounts;
    tier2_engine: "lmstudio" | "haiku";
    local_calls: number;
  };
}

// Mirrors the research_tasks.task_type CHECK in the OS.
export type TaskType =
  | "discover" | "resolve" | "classify" | "crawl" | "extract" | "tech_detect" | "public_data"
  | "score" | "qualify" | "find_people" | "find_email" | "verify_email" | "find_phone"
  | "signal_scan" | "personalize" | "report";

export type JobStatus =
  | "draft" | "estimated" | "awaiting_approval" | "queued" | "running" | "paused"
  | "completed" | "failed" | "cancelled";

export interface Job {
  id: string;
  title: string;
  request_text: string;
  plan: JobSpec | Record<string, unknown>;
  status: JobStatus;
  paused_reason?: string | null;
  budget_usd: number;
  max_records: number;
  gates: Partial<JobGates>;
  estimate: Partial<Estimate>;
  spend_usd: number;
  ai_spend_usd?: number;
  funnel: Partial<FunnelCounts>;
  counts?: Record<string, number>;
  list_id?: string | null;
  report_url?: string | null;
  requested_via?: string;
  started_at?: string | null;
  finished_at?: string | null;
  error?: string | null;
  created_at: string;
}

/** What claim_research_tasks hands back per row. */
export interface ClaimedTask {
  id: string;
  job_id: string;
  task_type: TaskType;
  stage: number;
  company_id?: string | null;
  person_id?: string | null;
  attempt: number;
  input: Record<string, unknown>;
  idempotency_key: string;
  lease_expires_at?: string;
}

/** A task a stage wants queued next (research_tasks_add row, minus org/job). */
export interface NewTask {
  task_type: TaskType;
  stage?: number;
  company_id?: string;
  person_id?: string;
  priority?: number;
  idempotency_key: string;
  input?: Record<string, unknown>;
  depends_on?: string[];
  not_before?: string;
}

export interface StageResult {
  status: "completed" | "failed" | "skipped";
  output?: Record<string, unknown>;
  error?: string;
  cost_usd?: number;
  fan_out?: NewTask[];
  /** Funnel counters to bump by one each (research_job_bump). */
  bump?: (keyof FunnelCounts)[];
}

// Mirrors the provider_requests.provider CHECK in the OS (the subset Clara uses).
export type Provider =
  | "places" | "brave" | "exa" | "jina" | "http" | "dns" | "playwright"
  | "hunter" | "leadmagic" | "linkedin" | "dbpr" | "sunbiz" | "permits"
  | "llm_t1" | "llm_t2" | "llm_t3" | "other";

/** One company as discovery found it, before entity resolution. */
export interface DiscoveredCandidate {
  name: string;
  source: "places" | "brave" | "exa";
  website_url?: string;
  phone?: string;
  google_place_id?: string;
  address?: { line1?: string; city?: string; state?: string; postal_code?: string; country?: string };
  lat?: number;
  lng?: number;
  rating?: number;
  review_count?: number;
  business_status?: string;
  /** Places' primary type / Brave's title context — the classifier's first hint. */
  category_hint?: string;
  source_url?: string;
}

export class ProviderError extends Error {
  constructor(public provider: Provider, public status: number | undefined, message: string) {
    super(message);
    this.name = "ProviderError";
  }
  /** 402 (out of credit), 429 (rate limit) and 5xx open the per-provider breaker. */
  get opensBreaker(): boolean {
    return this.status === 402 || this.status === 429 || (this.status !== undefined && this.status >= 500);
  }
}
