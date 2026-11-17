// osBridge.ts — typed wrappers over a dedicated OsMcpClient for the prospect_* OS tools.
//
// Mirrors deals.ts's pattern exactly (its own CLARA_OS_TOOLS + extension client) rather than
// waiting on agent-core PR "providers: shared Places/Brave/Hunter/LeadMagic clients + typed prospect
// lookups" (open as of this writing): once CLARA_OS_TOOLS itself grows the prospect surface,
// PROSPECT_TOOL_EXTENSION becomes redundant and can be folded away, same as DEAL_TOOL_EXTENSION's
// own PENDING note.
//
// NONE of these tools exist on the OS yet either — orion's prospect_core/research_jobs/lists
// migrations and mcp-server/src/tools/prospects.ts are separate, not-yet-applied PRs (Part 1-3 of
// the plan). Every call here can legitimately fail with "unknown tool" until then. Every exported
// function wraps that as `OsProspectingUnavailableError` so callers (stages.ts, the orchestrator,
// intentTools.ts, the /api/prospects/* routes) can treat "OS prospecting surface not live yet" as a
// soft, logged, user-visible-but-non-crashing state rather than an unhandled rejection.

import { OsMcpClient, allowExact, CLARA_OS_TOOLS } from "@autom8ionlab/agent-core";
import { osAuth } from "../osClient";
import type { ClaimedTask, FunnelCounts, Job, JobSpec, StageResult } from "./types";

/** Exact tool names mirrored from the plan's Part 2 (`orion/mcp-server/src/tools/prospects.ts`,
 *  not yet built). Kept broad (every tool PR 5 or a near-term PR could plausibly reach) rather than
 *  pared to exactly what's called today — adding a tool name here costs nothing until it exists. */
export const PROSPECT_TOOL_EXTENSION: readonly string[] = [
  "research_job_create", "research_job_get", "research_job_list", "research_job_update",
  "research_job_cancel", "research_job_bump", "research_job_reconcile",
  "research_tasks_claim", "research_tasks_report", "research_tasks_add", "research_task_sweep",
  "companies_search", "companies_get", "companies_upsert", "companies_merge", "companies_timeline",
  "companies_promote",
  "company_people_upsert", "company_people_list",
  "contact_methods_upsert", "contact_methods_list",
  "company_technologies_upsert",
  "facts_add", "facts_list",
  "signals_add", "signals_list",
  "sources_add",
  "prospect_lists_create", "prospect_lists_list", "prospect_lists_get", "prospect_lists_update",
  "prospect_lists_add_members", "prospect_lists_remove_members", "prospect_lists_export",
  "suppressions_check", "suppressions_add", "suppressions_list",
  "fit_score_config_get", "fit_score_config_set", "fit_score_recompute",
  "provider_requests_add", "provider_requests_stats",
  "prospect_settings_get", "prospect_settings_set", "prospect_daily_stats",
  // PR 11 — buyer discovery / contact waterfalls / compliance logging
  "outreach_events_add",
  // PR 13 — per-step unsubscribe link slugs
  "tracked_links_create",
  // PR 14 — sequence enrollment + the runner's due-enrollment feed
  "sequence_enroll", "sequence_enrollments_due",
  // PR 16 — reply detection + daily/weekly reporting
  "outreach_events_lookup", "prospect_daily_stats",
];

const prospectClient = new OsMcpClient({
  auth: osAuth,
  url: process.env.ORION_MCP_URL,
  allow: allowExact([...CLARA_OS_TOOLS, ...PROSPECT_TOOL_EXTENSION]),
  clientName: "clara-osmcp-prospecting",
});

function unwrap(content: unknown): unknown {
  if (Array.isArray(content)) {
    const first = content.find((c) => c && typeof c === "object" && "text" in (c as object));
    if (first && typeof (first as { text?: unknown }).text === "string") {
      try {
        return JSON.parse((first as { text: string }).text);
      } catch {
        return (first as { text: string }).text;
      }
    }
  }
  return content;
}

export async function prospectCallTool(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
  return unwrap(await prospectClient.callTool(name, args));
}

export class OsProspectingUnavailableError extends Error {
  constructor(cause: unknown) {
    super(`OS prospecting tools not available yet: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "OsProspectingUnavailableError";
  }
}

async function call(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
  try {
    return await prospectCallTool(name, args);
  } catch (e) {
    throw new OsProspectingUnavailableError(e);
  }
}

export function prospectOsEnabled(): boolean {
  return osAuth.osConfigured();
}

// ── Jobs ──────────────────────────────────────────────────────────────────────────────────────
export interface CreateJobInput {
  title: string;
  request_text: string;
  plan: JobSpec;
  budget_usd: number;
  max_records: number;
  requested_via: string;
  dry_run?: boolean;
  estimate?: unknown;
}
export interface CreateJobResult {
  job: Job;
  needs_approval: boolean;
  approval_reason?: string;
}
export async function createResearchJob(input: CreateJobInput): Promise<CreateJobResult> {
  return call("research_job_create", input as unknown as Record<string, unknown>) as Promise<CreateJobResult>;
}
/** `research_job_get`/`_update`/`_cancel` all wrap their row as `{ job: {...} }` (confirmed live,
 *  2026-10-01, via the /api/prospects/research/run smoke test — the unwrapped cast below was
 *  reading `job.plan`/etc. off the envelope object itself and getting `undefined`, which crashed
 *  `/run` with "Cannot read properties of undefined (reading 'location')"). Defensive about both the
 *  envelope and a bare-row response, same pattern as companiesGet's doc comment above. */
function unwrapJob(raw: unknown): Job {
  if (raw && typeof raw === "object" && "job" in (raw as Record<string, unknown>)) {
    const j = (raw as { job?: unknown }).job;
    if (j && typeof j === "object") return j as Job;
  }
  return raw as Job;
}
export async function getResearchJob(id: string): Promise<Job> {
  return unwrapJob(await call("research_job_get", { id }));
}
export async function listResearchJobs(args: { status?: string; limit?: number } = {}): Promise<Job[]> {
  const r = await call("research_job_list", args);
  return Array.isArray(r) ? (r as Job[]) : [];
}
export async function updateResearchJob(id: string, patch: Record<string, unknown>): Promise<Job> {
  return unwrapJob(await call("research_job_update", { id, ...patch }));
}
export async function cancelResearchJob(id: string): Promise<Job> {
  return unwrapJob(await call("research_job_cancel", { id }));
}
/** The bump tool takes one `{job_id, counter, delta}` per call. */
export async function bumpFunnel(id: string, keys: (keyof FunnelCounts)[]): Promise<void> {
  const counts = new Map<string, number>();
  for (const k of keys) counts.set(k, (counts.get(k) ?? 0) + 1);
  for (const [counter, delta] of counts) await call("research_job_bump", { job_id: id, counter, delta });
}

// ── Tasks ─────────────────────────────────────────────────────────────────────────────────────
/** The claim tool returns `{ tasks: [...], server_time, swept }` (the RPC's jsonb plus the sweep
 *  result). Reading it as a bare array — the original code — saw zero tasks on every tick while
 *  the server had already leased them, so every task in the Oct 1 job expired twice and failed. */
export function claimedTasksFrom(r: unknown): ClaimedTask[] {
  if (Array.isArray(r)) return r as ClaimedTask[];
  const t = r && typeof r === "object" ? (r as { tasks?: unknown }).tasks : undefined;
  return Array.isArray(t) ? (t as ClaimedTask[]) : [];
}
export async function claimTasks(jobId: string | undefined, limit: number): Promise<ClaimedTask[]> {
  return claimedTasksFrom(await call("research_tasks_claim", { job_id: jobId, limit, worker: "clara" }));
}
/** The report tool's schema is `{task_id, status, output, error, cost_usd}`; backoff is computed
 *  server-side, so `not_before` and the fan_out/bump bookkeeping are not sent. */
export function reportArgs(taskId: string, result: StageResult & { not_before?: string }): Record<string, unknown> {
  const a: Record<string, unknown> = { task_id: taskId, status: result.status };
  if (result.output) a.output = result.output;
  if (result.error) a.error = result.error.slice(0, 2000);
  if (typeof result.cost_usd === "number" && result.cost_usd > 0) a.cost_usd = result.cost_usd;
  return a;
}
export async function reportTask(taskId: string, result: StageResult & { not_before?: string }): Promise<void> {
  await call("research_tasks_report", reportArgs(taskId, result));
}
export async function addTasks(jobId: string, tasks: Record<string, unknown>[]): Promise<void> {
  if (tasks.length) await call("research_tasks_add", { job_id: jobId, tasks });
}
export async function sweepTasks(): Promise<void> {
  await call("research_task_sweep", {});
}

// ── Companies / facts / lists / compliance / config ──────────────────────────────────────────
export async function companiesSearch(args: Record<string, unknown>): Promise<unknown> {
  return call("companies_search", args);
}
export async function companiesUpsert(args: Record<string, unknown>): Promise<unknown> {
  return call("companies_upsert", args);
}
/** PR 9: `companies_get` — the single current company row (name/website/address/city/state/rating/
 *  review_count/fit_score/…) for intel/revenue.ts, intel/fitScore.ts, extract/qualify.ts and
 *  publicdata/index.ts, all of which need the current row rather than companiesSearch's list shape.
 *  Defensive about the OS's exact envelope (`{company: {...}}` vs. the row directly) since that
 *  detail isn't pinned down anywhere PR 9 could confirm it against a running OS. */
export async function companiesGet(id: string): Promise<Record<string, unknown>> {
  const r = await call("companies_get", { id });
  if (r && typeof r === "object" && "company" in (r as Record<string, unknown>)) {
    const c = (r as { company?: unknown }).company;
    if (c && typeof c === "object") return c as Record<string, unknown>;
  }
  return r && typeof r === "object" ? (r as Record<string, unknown>) : {};
}

// ── Promotion (PR 12) ────────────────────────────────────────────────────────────────────────
/** `companies_get`'s FULL envelope — company + people + contact_methods + technologies + facts +
 *  signals + enrollments in one round trip (see the OS tool's own doc comment). `companiesGet`
 *  above deliberately discards everything but `.company` for its many PR 8/9 callers that only
 *  need the row; promote.ts wants the whole thing (the research doc's sections map 1:1 onto these
 *  keys) so it gets its own wrapper rather than widening companiesGet's return type for everyone. */
export interface CompanyFullRow {
  company: Record<string, unknown>;
  people: Array<Record<string, unknown>>;
  contact_methods: Array<Record<string, unknown>>;
  technologies: Array<Record<string, unknown>>;
  facts: CompanyFactRow[];
  signals: Array<Record<string, unknown>>;
  enrollments: Array<Record<string, unknown>>;
}
function emptyFullRow(): CompanyFullRow {
  return { company: {}, people: [], contact_methods: [], technologies: [], facts: [], signals: [], enrollments: [] };
}
export async function companiesGetFull(id: string): Promise<CompanyFullRow> {
  const r = await call("companies_get", { id });
  if (!r || typeof r !== "object") return emptyFullRow();
  const o = r as Record<string, unknown>;
  const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
  return {
    company: o.company && typeof o.company === "object" ? (o.company as Record<string, unknown>) : {},
    people: arr(o.people),
    contact_methods: arr(o.contact_methods),
    technologies: arr(o.technologies),
    facts: arr<CompanyFactRow>(o.facts),
    signals: arr(o.signals),
    enrollments: arr(o.enrollments),
  };
}

export interface CompanyTimelineRow {
  id?: string;
  event_type?: string;
  summary?: string;
  occurred_at: string;
  payload?: Record<string, unknown>;
}
/** `companies_timeline` — the company_timeline view (§23): signals, fact supersede pairs, outreach,
 *  research milestones, promotion, and CRM/deal events once promoted. Newest-first. */
export async function companiesTimeline(args: { company_id: string; limit?: number; since?: string }): Promise<CompanyTimelineRow[]> {
  const r = await call("companies_timeline", args);
  return Array.isArray(r) ? (r as CompanyTimelineRow[]) : [];
}

export interface CompaniesPromoteInput {
  company_id: string;
  person_id?: string;
  pipeline?: string;
  stage?: string;
  value_amount?: number;
  assigned_user_id?: string;
  reason?: string;
}
export interface CompaniesPromoteResult {
  contact_id: string;
  opportunity_id: string;
  created: { contact?: boolean; opportunity?: boolean };
  lead_score?: number;
  person_id?: string;
  pipeline_id?: string;
  stage_id?: string;
}
/** `companies_promote` (→ RPC `prospect_promote`, §25) — idempotent: re-promoting a company that
 *  already has `companies.contact_id` set just returns the existing contact/opportunity ids rather
 *  than creating duplicates (the SQL function's own `COALESCE(c.contact_id, p.contact_id)` /
 *  `v_opp := c.opportunity_id` checks). Pipeline/stage default to the org's
 *  `prospect_settings.default_pipeline_name` ("Sales / Prospecting") when omitted. */
export async function companiesPromote(args: CompaniesPromoteInput): Promise<CompaniesPromoteResult> {
  return call("companies_promote", args as unknown as Record<string, unknown>) as Promise<CompaniesPromoteResult>;
}

/** PR 9: `facts_list` — a company's current facts (one row per field_name, or several for a
 *  multi-valued field — see FactInput's multi_valued doc). Used wherever a PR 9 module needs to read
 *  back what extract/tech_detect (PR 8) or this PR's own public_data stage wrote. */
export interface CompanyFactRow {
  id: string;
  field_name: string;
  value: unknown;
  confidence?: number;
  grounded?: boolean;
  source_type?: string;
  /** Present on the underlying company_facts row (FactInput writes it) even though prior readers of
   *  this type never needed it; PR 15's preview endpoint resolves a citation's `fact:<id>` back to a
   *  clickable source link the same way SignalRow.source_url already does. */
  source_url?: string;
  /** Present on every row; only actually useful to callers once `include_history` is passed (PR
   *  17's cadence gating and review_velocity's 30d/90d snapshot lookups read this). */
  observed_at?: string;
  valid_until?: string | null;
}
export async function factsList(args: {
  subject_type?: "company" | "person";
  subject_id: string;
  field_name?: string;
  /** PR 17: pulls prior (superseded) rows too, newest-first per field — needed for
   *  review_velocity's "closest to 30/90 days ago" snapshot lookup. Omitted (the PR 8/9 default)
   *  returns only each field's current row. */
  include_history?: boolean;
  limit?: number;
}): Promise<CompanyFactRow[]> {
  const r = await call("facts_list", args);
  return Array.isArray(r) ? (r as CompanyFactRow[]) : [];
}
// facts_add's `field_name`/`source_type`/etc. shapes, mirrored from orion/mcp-server/src/tools/
// prospects.ts (PR 8's brief) — kept here, alongside SourcesAddInput, as the OS-schema source of
// truth every PR 8+ caller (extract/extractFacts.ts, tech/detect.ts) imports rather than re-typing.
export interface FactInput {
  subject_type: "company" | "person";
  subject_id: string;
  company_id?: string;
  /** /^[a-z0-9_.]{1,64}$/ — the OS CHECK constraint. */
  field_name: string;
  value: unknown;
  normalized_value?: string;
  source_type:
    | "website_page" | "website_script" | "dns" | "http_header" | "places" | "serper" | "brave"
    | "linkedin" | "job_post" | "dbpr" | "sunbiz" | "permit" | "provider" | "llm_extraction"
    | "derived" | "manual" | "import";
  source_url?: string;
  source_id?: string;
  provider?: string;
  provider_request_id?: string;
  confidence?: number;
  grounded?: boolean;
  evidence?: Record<string, unknown>;
  observed_at?: string;
  extraction_model?: string;
  multi_valued?: boolean;
}
export interface FactsAddInput {
  research_job_id?: string;
  research_task_id?: string;
  /** Max 500 per call. */
  facts: FactInput[];
  organization_id?: string;
}
export interface FactsAddResult {
  inserted: { id: string; field_name: string; superseded_fact_id?: string; unchanged?: boolean }[];
  signals_emitted: unknown[];
}
/** `facts_add` already handles single-valued-field supersede and auto-emits `company_signals` rows
 *  for the known tech/leadership/ads fields — see PR 8's brief for the exact list. Callers here
 *  never reimplement either; they just pick the right `field_name`. */
export async function factsAdd(args: FactsAddInput): Promise<FactsAddResult> {
  return call("facts_add", args as unknown as Record<string, unknown>) as Promise<FactsAddResult>;
}

// ── Technologies (tech_detect, PR 8) ─────────────────────────────────────────────────────────
export type TechCategory =
  | "crm" | "website_builder" | "ads" | "chat" | "booking" | "phone" | "ai_receptionist"
  | "financing" | "analytics" | "payments" | "email_platform" | "other";
export type TechDetectedVia = "script" | "dns" | "html" | "cookie" | "header" | "job_post" | "provider" | "manual";
export interface CompanyTechnologyInput {
  category: TechCategory;
  name: string;
  vendor?: string;
  detected_via?: TechDetectedVia;
  evidence_url?: string;
  confidence?: number;
  fact_id?: string;
}
export interface CompanyTechnologiesUpsertInput {
  company_id: string;
  technologies: CompanyTechnologyInput[];
  /** true closes/valid_untils any current tech NOT in this call's list — pass true only when every
   *  category was scanned this run (tech_detect's case), never from a partial re-scan. */
  replace?: boolean;
  organization_id?: string;
}
export interface CompanyTechnologiesUpsertResult {
  added: unknown[];
  refreshed: number;
  closed: number;
}
export async function companyTechnologiesUpsert(args: CompanyTechnologiesUpsertInput): Promise<CompanyTechnologiesUpsertResult> {
  return call("company_technologies_upsert", args as unknown as Record<string, unknown>) as Promise<CompanyTechnologiesUpsertResult>;
}

/** FOLLOW-UP (fit-score matcher fix, after PR 9): a company_technologies row as `companies_get`
 *  returns it (mcp-server/src/tools/prospects.ts's companies_get handler joins current —
 *  valid_until IS NULL — company_technologies rows in under its `technologies` key). */
export interface CompanyTechnologyRow {
  id?: string;
  category: TechCategory | string;
  name: string;
  vendor?: string;
  confidence?: number;
  fact_id?: string;
  valid_until?: string | null;
}
/** `companies_get`'s envelope already includes a `technologies` slice alongside `company` — see
 *  companiesGet's doc comment above, which discards everything except `.company` for its many
 *  existing callers. This is a second, narrow wrapper around the SAME tool that keeps just the
 *  technologies slice: stage 60's score.fit handler needs it to resolve a fit_score_configs rule's
 *  `tech_category` predicates (intel/fitScore.ts's buildFitContext). Costs one extra companies_get
 *  round trip — there is no standalone company_technologies_list OS tool (yet). */
export async function companyTechnologiesList(companyId: string): Promise<CompanyTechnologyRow[]> {
  const r = await call("companies_get", { id: companyId });
  const obj = r && typeof r === "object" ? (r as Record<string, unknown>) : {};
  return Array.isArray(obj.technologies) ? (obj.technologies as CompanyTechnologyRow[]) : [];
}

// ── People / contact methods (PR 11 — buyer discovery + email/phone waterfalls) ────────────────
export type PersonRoleType = "owner" | "ceo" | "gm" | "sales_leader" | "ops" | "marketing" | "other";
export interface CompanyPeopleUpsertInput {
  company_id: string;
  full_name: string;
  first_name?: string;
  last_name?: string;
  title?: string;
  role_type?: PersonRoleType;
  is_decision_maker?: boolean;
  linkedin_url?: string;
  source?: string;
  source_url?: string;
  confidence?: number;
  status?: "active" | "left" | "unknown";
  organization_id?: string;
}
export interface CompanyPeopleUpsertResult {
  person: { id: string; full_name: string } & Record<string, unknown>;
  action: "inserted" | "updated";
}
/** `company_people_upsert` — unique on (company_id, lower(full_name)) until promoted; the OS closes
 *  the gap between buyerDiscovery finding the same owner twice (once per job, say) by updating
 *  rather than duplicating. */
export async function companyPeopleUpsert(args: CompanyPeopleUpsertInput): Promise<CompanyPeopleUpsertResult> {
  return call("company_people_upsert", args as unknown as Record<string, unknown>) as Promise<CompanyPeopleUpsertResult>;
}
export interface CompanyPersonRow {
  id: string;
  company_id: string;
  full_name: string;
  title?: string;
  role_type?: PersonRoleType;
  is_decision_maker?: boolean;
  linkedin_url?: string;
  confidence?: number;
}
export async function companyPeopleList(args: { company_id: string }): Promise<CompanyPersonRow[]> {
  const r = await call("company_people_list", args);
  return Array.isArray(r) ? (r as CompanyPersonRow[]) : [];
}

export type ContactMethodKind = "email" | "phone" | "mobile";
export type ContactMethodVerificationStatus = "verified" | "likely_valid" | "catch_all" | "risky" | "invalid" | "unknown";
export interface ContactMethodsUpsertInput {
  company_id: string;
  person_id?: string;
  kind: ContactMethodKind;
  value: string;
  provider?: "leadmagic" | "findymail" | "prospeo" | "wiza" | "pdl" | "hunter" | "apollo" | "website" | "places" | "dbpr" | "sunbiz" | "linkedin" | "manual" | "import";
  verification_status?: ContactMethodVerificationStatus;
  verifier?: string;
  confidence?: number;
  source_url?: string;
  is_primary?: boolean;
  provider_request_id?: string;
  organization_id?: string;
}
export interface ContactMethodsUpsertResult {
  method: { id: string; value: string; verification_status: ContactMethodVerificationStatus } & Record<string, unknown>;
  action: "inserted" | "unchanged" | "transitioned";
  previous_status?: ContactMethodVerificationStatus;
}
/** `contact_methods_upsert` — a verification-status CHANGE closes the old row (valid_until) and
 *  inserts a new one (the OS's own audit trail of every status transition); an unchanged status just
 *  bumps confidence. Stage 85 (find_email) calls this with the rung's INITIAL guess; stage 87
 *  (verify_email) calls it again with the authoritative verify-call result — two calls, same
 *  contact_methods row, exactly the transition the OS tool is built for. */
export async function contactMethodsUpsert(args: ContactMethodsUpsertInput): Promise<ContactMethodsUpsertResult> {
  return call("contact_methods_upsert", args as unknown as Record<string, unknown>) as Promise<ContactMethodsUpsertResult>;
}
export interface ContactMethodRow {
  id: string;
  company_id: string;
  person_id?: string;
  kind: ContactMethodKind;
  value: string;
  provider?: string;
  verification_status: ContactMethodVerificationStatus;
  confidence?: number;
  is_primary?: boolean;
}
export async function contactMethodsList(args: { company_id: string; person_id?: string; include_history?: boolean }): Promise<ContactMethodRow[]> {
  const r = await call("contact_methods_list", args);
  return Array.isArray(r) ? (r as ContactMethodRow[]) : [];
}

// ── Outreach events (PR 11 — "blocked" suppression logging; the sequence runner (PR 14) reuses
// this same wrapper for its own send/skip events) ────────────────────────────────────────────
export interface OutreachEventsAddInput {
  enrollment_id: string;
  event_type:
    | "queued" | "rendered" | "approved" | "sent" | "delivered" | "opened" | "clicked" | "replied"
    | "bounced" | "complained" | "failed" | "suppressed" | "blocked" | "skipped" | "task_created"
    | "call_placed" | "call_completed" | "unsubscribed" | "stopped";
  channel?: "email" | "sms" | "call" | "task" | "linkedin_task" | "system";
  step_id?: string;
  payload?: Record<string, unknown>;
  provider?: string;
  provider_message_id?: string;
  next_run_at?: string;
  message_id?: string;
  tracked_link_id?: string;
}
/** `outreach_events_add` requires a real `enrollment_id` (sequence_enrollments row) — PR 11 has no
 *  enrollment yet (that's PR 14's sequenceRunner), so a suppression hit found during contact
 *  discovery is logged via ledger.ts locally instead; this wrapper exists now so PR 14 doesn't have
 *  to add it later. Exported, not wired into stages.ts's find_email/find_phone handlers. */
export async function outreachEventsAdd(args: OutreachEventsAddInput): Promise<unknown> {
  return call("outreach_events_add", args as unknown as Record<string, unknown>);
}

// ── Tracked links (PR 13 — per-step unsubscribe slugs) ──────────────────────────────────────
export interface TrackedLinksCreateInput {
  /** The table requires a destination_url even for an unsubscribe-only link — the email-
   *  unsubscribe edge fn ignores it entirely (it acts on `metadata`, never redirects). See
   *  compliance.ts's buildUnsubscribeLink for the harmless-placeholder value it passes. */
  destination_url: string;
  name?: string;
  contact_id?: string;
  metadata?: Record<string, unknown>;
  expires_at?: string;
  organization_id?: string;
}
export interface TrackedLinksCreateResult {
  link: { id: string } & Record<string, unknown>;
  slug: string;
}
export async function trackedLinksCreate(args: TrackedLinksCreateInput): Promise<TrackedLinksCreateResult> {
  return call("tracked_links_create", args as unknown as Record<string, unknown>) as Promise<TrackedLinksCreateResult>;
}

export async function suppressionsCheck(args: Record<string, unknown>): Promise<{ blocked: boolean; hits: unknown[] }> {
  const r = (await call("suppressions_check", args)) as { blocked?: boolean; hits?: unknown[] } | undefined;
  return { blocked: Boolean(r?.blocked), hits: Array.isArray(r?.hits) ? (r!.hits as unknown[]) : [] };
}
export async function suppressionsAdd(args: Record<string, unknown>): Promise<unknown> {
  return call("suppressions_add", args);
}
export async function fitScoreConfigGet(): Promise<unknown> {
  return call("fit_score_config_get", {});
}
export async function fitScoreConfigSet(args: Record<string, unknown>): Promise<unknown> {
  return call("fit_score_config_set", args);
}
export async function fitScoreRecompute(args: Record<string, unknown> = {}): Promise<unknown> {
  return call("fit_score_recompute", args);
}

// ── Signals (PR 9) ───────────────────────────────────────────────────────────────────────────
// `signals_add` is the ONLY way to write a company_score_events row — pass `score_delta` and the OS
// writes it internally (there is no direct company_score_events MCP tool). This is a SEPARATE
// scoring path from fit_score_recompute above: fit_score_recompute SETS the authoritative
// companies.fit_score (score.fit's stage-60 handler, every run); signals_add's score_delta ADDS a
// discrete bump on top of whatever's there (publicdata/index.ts's DBPR/permit bump — PR 9's Task 5).
// Never double-count the same reasoning down both paths in one handler.
export type SignalType =
  | "hiring" | "tech_added" | "tech_removed" | "new_location" | "review_velocity" | "ad_started"
  | "ad_stopped" | "website_change" | "leadership_change" | "permit" | "financing_added"
  | "reviews_milestone" | "other";
export interface SignalsAddInput {
  company_id: string;
  signal_type: SignalType;
  /** Max 120 chars — the OS CHECK constraint. */
  headline: string;
  detail?: string;
  interpretation?: string;
  strength?: "low" | "medium" | "high";
  observed_at?: string;
  source_url?: string;
  fact_id?: string;
  prior_fact_id?: string;
  research_job_id?: string;
  score_delta?: number;
  organization_id?: string;
}
export interface SignalsAddResult {
  signal: unknown;
  score?: { before: number; after: number };
}
export async function signalsAdd(args: SignalsAddInput): Promise<SignalsAddResult> {
  return call("signals_add", args as unknown as Record<string, unknown>) as Promise<SignalsAddResult>;
}

/** PR 17: `signals_list` — a company's (or the org's) company_signals rows, newest-first. Used by
 *  signals/onlyIfSignal.ts (the `only_if_signal` stub) and nowhere else yet. Not wrapped in any
 *  envelope on the OS side (`return toolResult(await restGet(...))` — a bare array), unlike
 *  `companies_get`'s `{company: ...}` shape, so no unwrap defense is needed here. */
export interface SignalRow {
  id: string;
  company_id: string;
  signal_type: SignalType | string;
  headline: string;
  detail?: string;
  strength?: "low" | "medium" | "high";
  observed_at: string;
  source_url?: string;
}
export async function signalsList(args: {
  company_id?: string;
  signal_type?: string;
  since?: string;
  strength?: string;
  limit?: number;
  organization_id?: string;
}): Promise<SignalRow[]> {
  const r = await call("signals_list", args);
  return Array.isArray(r) ? (r as SignalRow[]) : [];
}

/** PR 17: `prospect_settings_get` — the org's prospect_settings singleton row (crm_threshold,
 *  signal_budget_cents_per_company, prospect_day_max_usd, …). Returns the row directly on the OS
 *  side (`toolResult(one(...))`, not `{settings: ...}`), but this stays defensive about that the
 *  same way companiesGet is about companies_get's envelope, since nothing pins the exact shape down
 *  outside reading the OS source. */
export interface ProspectSettings {
  org_id: string;
  crm_threshold: number;
  auto_approve_usd: number;
  global_email_per_day: number;
  global_sms_per_day: number;
  signal_budget_cents_per_company: number;
  prospect_day_max_usd: number;
  clara_calls_enabled: boolean;
  physical_address?: string | null;
  reply_to_email?: string | null;
  default_pipeline_name: string;
}
export async function prospectSettingsGet(args: { organization_id?: string } = {}): Promise<ProspectSettings | undefined> {
  const r = await call("prospect_settings_get", args);
  if (r && typeof r === "object" && "settings" in (r as Record<string, unknown>)) {
    const s = (r as { settings?: unknown }).settings;
    if (s && typeof s === "object") return s as ProspectSettings;
  }
  return r && typeof r === "object" && Object.keys(r as object).length ? (r as ProspectSettings) : undefined;
}
export async function prospectListsCreate(args: Record<string, unknown>): Promise<unknown> {
  return call("prospect_lists_create", args);
}
export async function prospectListsList(args: Record<string, unknown> = {}): Promise<unknown> {
  return call("prospect_lists_list", args);
}
export async function prospectListsExport(args: Record<string, unknown>): Promise<unknown> {
  return call("prospect_lists_export", args);
}

/** Spend mirror used by ledger.ts. Never throws (a bookkeeping failure must not break a provider
 *  call), but logs rejections — this used to swallow them silently, which hid a schema mismatch
 *  that kept every job's spend_usd at $0 and the OS budget trigger blind. */
let providerRequestWarned = 0;
export async function providerRequestAdd(args: Record<string, unknown>): Promise<unknown> {
  return prospectCallTool("provider_requests_add", args).catch((e) => {
    if (providerRequestWarned++ < 5) {
      console.warn(`[prospecting] provider_requests_add rejected: ${e instanceof Error ? e.message : String(e)}`.slice(0, 600));
    }
    return undefined;
  });
}

// ── Sources (crawl evidence) ─────────────────────────────────────────────────────────────────
export interface SourcesAddInput {
  company_id: string;
  url: string;
  source_type?:
    | "homepage" | "about" | "services" | "careers" | "contact" | "financing" | "team" | "reviews"
    | "job_board" | "social" | "provider_payload" | "public_record" | "other";
  fetch_method?: "http" | "jina" | "playwright" | "provider";
  http_status?: number;
  content_hash?: string;
  /** Capped at 200,000 chars by the OS tool — see crawler/evidence.ts's MAX_INLINE_TEXT_BYTES. */
  content_text?: string;
  content_ref?: string;
  title?: string;
  provider_request_id?: string;
  research_job_id?: string;
  organization_id?: string;
}
export interface SourcesAddResult {
  source_id: string;
  action: "inserted" | "unchanged";
}
/** Records a fetched page for a company (company_sources row). */
export async function sourcesAdd(args: SourcesAddInput): Promise<SourcesAddResult> {
  return call("sources_add", args as unknown as Record<string, unknown>) as Promise<SourcesAddResult>;
}

// ── Sequences (PR 14 — enrollment + the runner's due-enrollment feed) ──────────────────────────
export interface SequenceEnrollInput {
  sequence_id: string;
  members?: { company_id: string; person_id?: string; contact_method_id?: string }[];
  list_id?: string;
  start_at?: string;
  enrolled_via?: "office" | "clara" | "rule";
}
export interface SequenceEnrollResult {
  enrolled: unknown[];
  skipped: { company_id: string; person_id?: string; reason: string }[];
  needs_approval?: boolean;
  approval_reason?: string;
}
/** `sequence_enroll` — suppression_check runs per-member on the OS side before each is enrolled
 *  (blocked members come back in `skipped`, never silently enrolled). The Office's "Launch
 *  campaign" button (POST /api/prospects/lists/[id]/launch) is this wrapper's only caller today. */
export async function sequenceEnroll(args: SequenceEnrollInput): Promise<SequenceEnrollResult> {
  return call("sequence_enroll", args as unknown as Record<string, unknown>) as Promise<SequenceEnrollResult>;
}

// ── Reply resolution + reporting (PR 16) ────────────────────────────────────────────────────────
export interface OutreachEventsLookupResult {
  match: "provider_message_id" | "email" | "phone" | null;
  enrollment: {
    enrollment_id: string;
    sequence_id: string;
    step_id?: string;
    company_id: string;
    person_id?: string | null;
    contact_id?: string | null;
    channel?: string;
    status?: string;
  } | null;
}
/** Resolves an inbound reply (Gmail or SMS) back to the sequence enrollment it belongs to — see
 *  the OS tool's own doc comment for the two match paths. A `match: null` result is the ordinary,
 *  expected case for the overwhelming majority of inbound mail (most isn't a prospecting reply at
 *  all), never an error. */
export async function outreachEventsLookup(args: { provider_message_id?: string; email?: string; phone?: string }): Promise<OutreachEventsLookupResult> {
  return call("outreach_events_lookup", args) as Promise<OutreachEventsLookupResult>;
}

export interface ProspectDailyStats {
  since: string;
  companies_total: number;
  match_icp: number;
  strong_signals_30d: number;
  new_companies: number;
  new_signals: number;
  sent: number;
  replies: number;
  replies_interested: number;
  booked: number;
  unsubscribed: number;
  bounced: number;
  active_enrollments: number;
  jobs_running: number;
  jobs_paused_budget: number;
  spend_since: number;
}
export async function prospectDailyStats(sinceIso?: string): Promise<ProspectDailyStats | undefined> {
  const r = await call("prospect_daily_stats", sinceIso ? { since: sinceIso } : {});
  return r && typeof r === "object" ? (r as ProspectDailyStats) : undefined;
}

// ── Sequences CRUD (PR 15 — the Office's sequence builder: create/list/get/update a sequence,
// replace its step list, list/stop its enrollments) ──────────────────────────────────────────
// All six tool names below (`sequences_create/get/list/update`, `sequence_steps_set`,
// `sequence_enrollments_list`, `sequence_unenroll`) are already present in agent-core's
// CLARA_OS_TOOLS allowlist (osmcp/allowlists.ts) — PR 14 only unstubbed sequence_enroll/
// sequence_enrollments_due for the runner; these are the writes PR 14 never needed and PR 15's
// Office builder cannot work without.

export type SequenceStatus = "draft" | "active" | "paused" | "archived";
export interface SendWindow {
  days?: string[];
  start?: string;
  end?: string;
  tz?: string;
}
export interface Throttle {
  per_day?: number;
  per_hour?: number;
  min_gap_minutes?: number;
}
export interface Sequence {
  id: string;
  name: string;
  description?: string | null;
  status: SequenceStatus;
  send_window?: SendWindow | null;
  throttle?: Throttle | null;
  from_identity?: { domain?: string; email?: string } | null;
  stop_on_reply?: boolean;
  stop_on_meeting_booked?: boolean;
  sms_requires_launch_approval?: boolean;
  tracked_links?: boolean;
  exit_on?: string[];
  max_touches_per_company_per_week?: number;
  allow_role_addresses?: boolean;
  created_at?: string;
  updated_at?: string;
  /** Only present on `sequences_list` rows (sequence_steps(count)/sequence_enrollments(count)
   *  embeds) — absent on create/get/update's bare row. */
  steps?: Array<{ count: number }>;
  enrollments?: Array<{ count: number }>;
}

export type StepChannel = "email" | "sms" | "call" | "task" | "linkedin_task";
export type DelayUnit = "hours" | "days" | "business_days";
export interface StepDelay {
  value: number;
  unit: DelayUnit;
}
export interface SubjectVariant {
  key: string;
  text: string;
}
export interface StepTemplate {
  subject?: string;
  subject_variants?: SubjectVariant[];
  body: string;
  /** Task steps only — the contact_tasks title. */
  task_title?: string;
}
/** The OS's base ai_slots shape (`{name,max_words,must_cite}`); `fallback` is additive — see
 *  personalize.ts's AiSlotSpec doc comment, which names this sequence builder as the one expected
 *  to populate it. */
export interface SequenceAiSlot {
  name: string;
  max_words?: number;
  must_cite?: boolean;
  fallback?: string;
}
export type ConsentChannel = "sms" | "voice";
export interface StepConditions {
  skip_if?: string[];
}
export interface SequenceStep {
  id?: string;
  sequence_id?: string;
  position: number;
  channel: StepChannel;
  delay?: StepDelay;
  /** "HH:MM", 24h. */
  send_at_time?: string;
  template: StepTemplate;
  ai_slots?: SequenceAiSlot[];
  personalization?: unknown;
  conditions?: StepConditions;
  only_if_signal?: string[];
  requires_consent?: ConsentChannel | null;
  task_assignee?: string | null;
  requires_approval?: boolean;
  is_active?: boolean;
}

export interface SequencesCreateInput {
  name: string;
  description?: string;
  send_window?: SendWindow;
  throttle?: Throttle;
  from_identity?: { domain?: string; email?: string };
  stop_on_reply?: boolean;
  stop_on_meeting_booked?: boolean;
  sms_requires_launch_approval?: boolean;
  tracked_links?: boolean;
  exit_on?: string[];
  max_touches_per_company_per_week?: number;
  allow_role_addresses?: boolean;
  steps?: SequenceStep[];
  organization_id?: string;
}
export interface SequencesCreateResult {
  sequence: Sequence;
  steps: SequenceStep[];
}
/** `sequences_create` — a new draft sequence; `steps` is optional (the Office's "New Sequence"
 *  modal never sends any — the builder adds them via `sequenceStepsSet` right after). */
export async function sequencesCreate(args: SequencesCreateInput): Promise<SequencesCreateResult> {
  const r = (await call("sequences_create", args as unknown as Record<string, unknown>)) as { sequence?: Sequence; steps?: unknown } | undefined;
  return { sequence: r?.sequence as Sequence, steps: Array.isArray(r?.steps) ? (r!.steps as SequenceStep[]) : [] };
}

export interface SequencesGetResult {
  /** `one(...)` on the OS side — `null` for a missing id, unlike `companies_get`'s 404. Callers
   *  (the /api/prospects/sequences/[id] route) must check this before reading `.name`/etc. */
  sequence: Sequence | null;
  steps: SequenceStep[];
  enrollment_counts: Record<string, number>;
}
export async function sequencesGet(id: string): Promise<SequencesGetResult> {
  const r = (await call("sequences_get", { id })) as Partial<SequencesGetResult> | undefined;
  return {
    sequence: r && "sequence" in r ? ((r.sequence as Sequence | null) ?? null) : null,
    steps: Array.isArray(r?.steps) ? (r!.steps as SequenceStep[]) : [],
    enrollment_counts: r?.enrollment_counts && typeof r.enrollment_counts === "object" ? r.enrollment_counts : {},
  };
}

export async function sequencesList(args: { status?: string; limit?: number; offset?: number; organization_id?: string } = {}): Promise<Sequence[]> {
  const r = await call("sequences_list", args);
  return Array.isArray(r) ? (r as Sequence[]) : [];
}

export interface SequencesUpdateResult {
  sequence: Sequence | null;
}
/** `sequences_update` — settings or status (draft → active → paused → archived); the OS returns
 *  the bare patched row (`one(...)`, same as sequences_get's inner field) rather than an envelope —
 *  this wrapper normalizes it to `{sequence}` so every sequences_* caller here has the same shape. */
export async function sequencesUpdate(id: string, patch: Record<string, unknown>): Promise<SequencesUpdateResult> {
  const r = await call("sequences_update", { id, ...patch });
  return { sequence: r && typeof r === "object" ? (r as Sequence) : null };
}

export interface SequenceStepsSetResult {
  steps: SequenceStep[];
}
/** `sequence_steps_set` — replaces the WHOLE ordered step list (positions must be 1..n, no gaps;
 *  the OS tool itself rejects anything else before touching the table). */
export async function sequenceStepsSet(sequenceId: string, steps: SequenceStep[]): Promise<SequenceStepsSetResult> {
  const r = (await call("sequence_steps_set", { sequence_id: sequenceId, steps: steps as unknown as Record<string, unknown>[] })) as { steps?: unknown } | undefined;
  return { steps: Array.isArray(r?.steps) ? (r!.steps as SequenceStep[]) : [] };
}

export interface Enrollment {
  id: string;
  sequence_id: string;
  company_id?: string;
  person_id?: string | null;
  status: string;
  current_step_no?: number | null;
  next_run_at?: string | null;
  last_event_at?: string | null;
  stop_reason?: string | null;
  created_at?: string;
  sequence?: { id: string; name?: string } | null;
  company?: { id: string; name?: string; fit_score?: number | null } | null;
  person?: { id: string; full_name?: string; title?: string } | null;
}
export interface SequenceEnrollmentsListResult {
  enrollments: Enrollment[];
}
export async function sequenceEnrollmentsList(args: { sequence_id?: string; company_id?: string; status?: string; limit?: number; offset?: number }): Promise<SequenceEnrollmentsListResult> {
  const r = await call("sequence_enrollments_list", args);
  return { enrollments: Array.isArray(r) ? (r as Enrollment[]) : [] };
}

export interface SequenceUnenrollInput {
  enrollment_id: string;
  reason?: string;
}
export interface SequenceUnenrollResult {
  ok: true;
  stopped: number;
}
/** `sequence_unenroll` — the OS tool is keyed on `enrollment_ids` (plural array; it also accepts a
 *  whole `sequence_id`/`company_id` instead) since it was built for the runner's own compliance
 *  stop path (PR 11); this wrapper narrows it to the single-enrollment-id shape the Office's
 *  PATCH /api/prospects/enrollments/[id] action needs. */
export async function sequenceUnenroll(args: SequenceUnenrollInput): Promise<SequenceUnenrollResult> {
  const r = (await call("sequence_unenroll", { enrollment_ids: [args.enrollment_id], reason: args.reason })) as { stopped?: number } | undefined;
  return { ok: true, stopped: typeof r?.stopped === "number" ? r.stopped : 0 };
}

// 2026-10-07 — job finalization (jobFinalize.ts).
export async function prospectListsAddMembers(args: { list_id: string; members: Array<{ company_id: string; person_id?: string; added_reason?: string }> }): Promise<unknown> {
  return call("prospect_lists_add_members", args);
}
export interface ReconcileResult { job_id: string; status: string; open_tasks: number; spend_usd: number; counts: Record<string, number> }
/** research_job_reconcile recomputes counts/spend and flips a `running` job with no open tasks to `completed`. */
export async function researchJobReconcile(jobId: string): Promise<ReconcileResult> {
  return call("research_job_reconcile", { job_id: jobId }) as Promise<ReconcileResult>;
}
