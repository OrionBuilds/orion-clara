// stages.ts — the orchestrator's per-task handlers, in claim order.
//
// PR 5 implemented stage 10 (discover), 20 (resolve), 30 (classify) and 99 (report), with 40-90
// registered as SKIP STUBS. PR 7 makes stage 40 (crawl) real (the http -> jina -> playwright
// waterfall in ./crawler) and replaces stage 30's inline classifier with the richer
// ./extract/classifyIndustry module (same stage, same place in STAGE_ORDER — classify still runs
// BEFORE crawl, so it still has no site text on that call; see classifyHandler below). PR 8 makes
// stage 50's two task types real: extract (tier-2 LLM fact extraction, ./extract/extractFacts.ts)
// and tech_detect (HTML/script signatures + DNS, ./tech/detect.ts) — both fan out a stage-55
// public_data task when done (still PR 9's SKIP STUB) since the orchestrator only advances a job by
// an explicit fan_out, not by any other stage-progression mechanism (see publicDataFanOut below).
// Stages 55-90 beyond that remain SKIP STUBS — PR 9+ territory.
//
// Every handler takes an explicit `deps` object (default = the real modules) rather than importing
// its collaborators directly, so tests can swap in fakes without a module-mocking mechanism — the
// convention this codebase already uses for pure-vs-injected boundaries (see jobSpec.ts/priors.ts).

import type { ClaimedTask, DiscoveredCandidate, Job, JobSpec, NewTask, StageResult, TaskType } from "./types";
import { prospectingMode } from "./types";
import { normalizeCandidate, normalizeDomain, normalizeName, isAggregatorDomain } from "./entity/normalize";
import { resolveCandidate, type ExistingEntity } from "./entity/resolve";
import { discoverCell as discoverCellReal } from "./discovery";
import { runTier as runTierReal } from "./llm";
import {
  companiesSearch as companiesSearchReal,
  companiesUpsert as companiesUpsertReal,
  companiesGet as companiesGetReal,
  factsList as factsListReal,
  factsAdd as factsAddReal,
  signalsAdd as signalsAddReal,
  signalsList as signalsListReal,
  companyTechnologiesList as companyTechnologiesListReal,
  fitScoreRecompute as fitScoreRecomputeReal,
  contactMethodsUpsert as contactMethodsUpsertReal,
  suppressionsCheck as suppressionsCheckReal,
  OsProspectingUnavailableError,
  type CompanyFactRow,
  type CompanyTechnologyRow,
  type SignalRow,
  type ContactMethodsUpsertInput,
} from "./osBridge";
import { deliverJobReport as deliverJobReportReal } from "./report/deliver";
import type { CompanyExportRow } from "./report/compose";
import { checkReserve } from "./budget";
import { pickPages as pickPagesReal } from "./crawler/pagePicker";
import { crawlSite as crawlSiteReal, type CrawlSiteResult } from "./crawler/waterfall";
import type { EvidenceRef } from "./crawler/evidence";
import { classifyIndustry as classifyIndustryReal } from "./extract/classifyIndustry";
import { extractFacts as extractFactsReal } from "./extract/extractFacts";
import { detectTech as detectTechReal } from "./tech/detect";
import { runFloridaPublicDataForCompany as runFloridaPublicDataReal } from "./publicdata";
import { computeFitScore as computeFitScoreReal, loadActiveFitScoreConfig as loadActiveFitScoreConfigReal, type FitScoreBreakdownEntry } from "./intel/fitScore";
import { estimateRevenueForCompany as estimateRevenueForCompanyReal, type RevenueEstimate } from "./intel/revenue";
import { qualifyCompany as qualifyCompanyReal } from "./extract/qualify";
import { buyerDiscover as buyerDiscoverReal, type DiscoveredPerson } from "./intel/buyerDiscovery";
import { runEmailWaterfall as runEmailWaterfallReal, runMobileWaterfall as runMobileWaterfallReal } from "./contacts/rungs";
import type { PersonContext } from "./contacts/waterfall";
import { verifyEmail as verifyEmailReal } from "./contacts/verifyEmail";
import { phoneGate as phoneGateReal } from "./contacts/phoneGate";
import type { VerificationStatus } from "./contacts/verification";
import { append as ledgerAppend } from "../ledger";
import { withSpendContext } from "./ledger";

export interface StageDef {
  stage: number;
  type: TaskType;
}

export const STAGE_ORDER: StageDef[] = [
  { stage: 10, type: "discover" },
  { stage: 20, type: "resolve" },
  { stage: 30, type: "classify" },
  { stage: 40, type: "crawl" },
  { stage: 50, type: "extract" },
  { stage: 50, type: "tech_detect" },
  { stage: 55, type: "public_data" },
  { stage: 60, type: "score" },
  { stage: 70, type: "qualify" },
  { stage: 80, type: "find_people" },
  { stage: 85, type: "find_email" },
  { stage: 87, type: "verify_email" },
  { stage: 90, type: "find_phone" },
  { stage: 99, type: "report" },
];

export const IMPLEMENTED_STAGES: ReadonlySet<TaskType> = new Set([
  "discover", "resolve", "classify", "crawl", "extract", "tech_detect", "public_data", "score", "qualify",
  "find_people", "find_email", "verify_email", "find_phone", "report",
]);

export interface StageDeps {
  discoverCell: typeof discoverCellReal;
  companiesSearch: typeof companiesSearchReal;
  companiesUpsert: typeof companiesUpsertReal;
  runTier: typeof runTierReal;
  deliverJobReport: typeof deliverJobReportReal;
  /** Stage 30 — replaces the old inline `buildClassifyPrompt`/parse-in-handler with the richer
   *  extract/classifyIndustry module (§ the file doc comment above). */
  classifyIndustry: typeof classifyIndustryReal;
  /** Stage 40 — pure page-URL picker (crawler/pagePicker.ts). */
  pickPages: typeof pickPagesReal;
  /** Stage 40 — the http->jina->playwright waterfall entrypoint (crawler/waterfall.ts); owns
   *  robots/aggregator gating, the playwright cap, and evidence writing internally, so this is the
   *  only crawl collaborator stages.ts itself needs to inject/fake. */
  crawlSite: typeof crawlSiteReal;
  /** Stage 50 — tier-2 LLM fact extraction off the crawled evidence (extract/extractFacts.ts). */
  extractFacts: typeof extractFactsReal;
  /** Stage 50 — HTML/script signature scan + DNS mail-provider inference (tech/detect.ts). */
  detectTech: typeof detectTechReal;
  /** Stage 55 — DBPR/Sunbiz/county-permit orchestration (publicdata/index.ts). */
  runFloridaPublicData: typeof runFloridaPublicDataReal;
  /** Stage 55/60/70 — company row / current facts (osBridge.ts). */
  companiesGet: typeof companiesGetReal;
  factsList: typeof factsListReal;
  /** Stage 55 — writes publicdata/index.ts's assembled facts. */
  factsAdd: typeof factsAddReal;
  /** Stage 55 — the ONLY way to write a company_score_events row (score_delta) — see osBridge.ts's
   *  doc comment on why this is a separate path from fitScoreRecompute below. */
  signalsAdd: typeof signalsAddReal;
  /** Stage 60 (fit-score matcher fix, after PR 9) — the company's current technologies/signals, fed
   *  into computeFitScore so a fit_score_configs rule's `tech_category`/`signal` predicates can
   *  actually resolve (intel/fitScore.ts's buildFitContext). */
  companyTechnologiesList: typeof companyTechnologiesListReal;
  signalsList: typeof signalsListReal;
  /** Stage 60 — the active fit_score_configs row + the pure scorer (intel/fitScore.ts). */
  loadActiveFitScoreConfig: typeof loadActiveFitScoreConfigReal;
  computeFitScore: typeof computeFitScoreReal;
  /** Stage 60 — persists computeFitScore's result as the authoritative companies.fit_score. */
  fitScoreRecompute: typeof fitScoreRecomputeReal;
  /** Stage 70 — revenue estimate fed into the qualify prompt (intel/revenue.ts). */
  estimateRevenueForCompany: typeof estimateRevenueForCompanyReal;
  /** Stage 70 — tier-2/tier-3 AI qualification verdict (extract/qualify.ts). */
  qualifyCompany: typeof qualifyCompanyReal;
  /** Stage 80 (find_people, buyer.discover) — the size-bucket -> persona -> source-ladder engine
   *  (intel/buyerDiscovery.ts), including its own company_people_upsert/facts_add writes. */
  buyerDiscover: typeof buyerDiscoverReal;
  /** Stage 85 (find_email, contact.email) — the 5-rung email waterfall, in order (contacts/rungs). */
  runEmailWaterfall: typeof runEmailWaterfallReal;
  /** Stage 90 (find_phone, contact.phone) — the 4-rung mobile/office-phone waterfall, in order. */
  runMobileWaterfall: typeof runMobileWaterfallReal;
  /** Stages 85/87/90 — contact_methods_upsert (writes the finder's initial guess, then the
   *  verifier's authoritative status, then any phone/mobile hit). */
  contactMethodsUpsert: typeof contactMethodsUpsertReal;
  /** Stages 85/90 — suppressions_check, called before EVERY contact_methods write. */
  suppressionsCheck: typeof suppressionsCheckReal;
  /** Stage 87 (verify_email, verify.email) — the independent Hunter/LeadMagic verify call. */
  verifyEmail: typeof verifyEmailReal;
}

export const defaultStageDeps: StageDeps = {
  discoverCell: discoverCellReal,
  companiesSearch: companiesSearchReal,
  companiesUpsert: companiesUpsertReal,
  runTier: runTierReal,
  deliverJobReport: deliverJobReportReal,
  classifyIndustry: classifyIndustryReal,
  pickPages: pickPagesReal,
  crawlSite: crawlSiteReal,
  extractFacts: extractFactsReal,
  detectTech: detectTechReal,
  runFloridaPublicData: runFloridaPublicDataReal,
  companiesGet: companiesGetReal,
  factsList: factsListReal,
  factsAdd: factsAddReal,
  signalsAdd: signalsAddReal,
  companyTechnologiesList: companyTechnologiesListReal,
  signalsList: signalsListReal,
  loadActiveFitScoreConfig: loadActiveFitScoreConfigReal,
  computeFitScore: computeFitScoreReal,
  fitScoreRecompute: fitScoreRecomputeReal,
  estimateRevenueForCompany: estimateRevenueForCompanyReal,
  qualifyCompany: qualifyCompanyReal,
  buyerDiscover: buyerDiscoverReal,
  runEmailWaterfall: runEmailWaterfallReal,
  runMobileWaterfall: runMobileWaterfallReal,
  contactMethodsUpsert: contactMethodsUpsertReal,
  suppressionsCheck: suppressionsCheckReal,
  verifyEmail: verifyEmailReal,
};

type Handler = (task: ClaimedTask, job: Job, deps: StageDeps) => Promise<StageResult>;

function toExistingEntities(raw: unknown): ExistingEntity[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((r) => {
      const x = r as Record<string, unknown>;
      const name = typeof x.name === "string" ? x.name : "";
      return {
        id: typeof x.id === "string" ? x.id : "",
        name,
        normalizedName: normalizeName(name),
        domain: typeof x.normalized_domain === "string" ? x.normalized_domain : normalizeDomain(x.website_url as string | undefined),
        phoneKey: typeof x.normalized_phone === "string" ? x.normalized_phone : undefined,
        placeId: typeof x.google_place_id === "string" ? x.google_place_id : undefined,
        addressKey: typeof x.normalized_address === "string" ? x.normalized_address : undefined,
      };
    })
    .filter((e) => e.id);
}

export function toExportRows(raw: unknown): CompanyExportRow[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((r) => {
    const x = r as Record<string, unknown>;
    return {
      name: typeof x.name === "string" ? x.name : "unknown",
      website: typeof x.website_url === "string" ? x.website_url : undefined,
      city: typeof x.city === "string" ? x.city : undefined,
      state: typeof x.state === "string" ? x.state : undefined,
      industry: Array.isArray(x.industry) ? (x.industry as string[]).join("/") : undefined,
      rating: typeof x.rating === "number" ? x.rating : undefined,
      reviews: typeof x.review_count === "number" ? x.review_count : undefined,
      fitScore: typeof x.fit_score === "number" ? x.fit_score : undefined,
      email: typeof x.primary_email === "string" ? x.primary_email : undefined,
      phone: typeof x.phone === "string" ? x.phone : undefined,
    };
  });
}

async function adjudicatePossibleDuplicate(candidate: DiscoveredCandidate, existing: ExistingEntity, deps: StageDeps): Promise<boolean | null> {
  const prompt = `Are these records the same real-world business? Answer ONLY {"same": true} or {"same": false}.\nA: ${JSON.stringify(candidate)}\nB: ${JSON.stringify(existing)}`;
  const r = await deps.runTier(3, prompt, { purpose: "prospect:adjudicate", json: true, maxTokens: 30 });
  if (!r.ok || !r.text) return null;
  try {
    return Boolean((JSON.parse(r.text) as { same?: unknown }).same);
  } catch {
    return null;
  }
}

const discoverHandler: Handler = async (task, job, deps) => {
  const spec = job.plan as JobSpec;
  const cell = task.input as { lat: number; lng: number; radiusMiles: number; cellId?: string };
  const allowLive = prospectingMode() === "active";
  const r = await deps.discoverCell({ lat: cell.lat, lng: cell.lng, radiusMiles: cell.radiusMiles }, spec, { allowLive, jobId: job.id });
  const fan_out: NewTask[] = r.candidates.map((c) => ({
    task_type: "resolve",
    stage: 20,
    idempotency_key: `${job.id}:resolve:${c.google_place_id ?? normalizeDomain(c.website_url) ?? normalizeName(c.name)}`,
    input: { candidate: c },
  }));
  return {
    status: "completed",
    cost_usd: r.costUsd,
    fan_out,
    bump: r.candidates.map(() => "discovered" as const),
    output: { found: r.candidates.length, notes: r.notes },
  };
};

const resolveHandler: Handler = async (task, job, deps) => {
  const { candidate } = task.input as { candidate: DiscoveredCandidate };
  const normalized = normalizeCandidate(candidate);
  let existing: ExistingEntity[] = [];
  try {
    existing = toExistingEntities(
      await deps.companiesSearch({ domain: normalized.domain, phone: normalized.phoneKey, q: normalized.normalizedName, limit: 5 }),
    );
  } catch (e) {
    if (!(e instanceof OsProspectingUnavailableError)) throw e;
    // OS prospect tables not live yet — resolve against an empty pool; every candidate is "new".
  }
  const resolved = resolveCandidate(candidate, existing);
  let action = resolved.action;
  if (action === "possible" && resolved.best && prospectingMode() === "active" && job.budget_usd - job.spend_usd > 0.05) {
    const verdict = await adjudicatePossibleDuplicate(candidate, resolved.best.entity, deps).catch(() => null);
    if (verdict !== null) action = verdict ? "merge" : "new";
  }

  let companyId: string | undefined;
  try {
    const up = (await deps.companiesUpsert({
      name: candidate.name,
      website_url: candidate.website_url,
      phone: candidate.phone,
      google_place_id: candidate.google_place_id,
      address: candidate.address,
      industry: (job.plan as JobSpec).industry,
      source: candidate.source,
      research_job_id: job.id,
      possible_duplicate_of: action === "possible" ? resolved.best?.entity.id : undefined,
    })) as { company?: { id?: string } };
    companyId = up.company?.id;
  } catch (e) {
    if (!(e instanceof OsProspectingUnavailableError)) throw e;
  }

  const fan_out: NewTask[] = [];
  if (action !== "possible") {
    fan_out.push({
      task_type: "classify",
      stage: 30,
      company_id: companyId,
      idempotency_key: `${job.id}:classify:${companyId ?? normalized.domain ?? normalized.normalizedName}`,
      input: { candidate, companyId },
    });
  }
  return { status: "completed", fan_out, output: { action, companyId, matchedOn: resolved.best?.matchedOn, score: resolved.best?.score } };
};

// Stage 30 runs BEFORE stage 40 (crawl) — see STAGE_ORDER — so `crawledText` is always undefined
// here; extract/classifyIndustry.ts is written to work either way and is reusable by a later PR
// that wants a post-crawl re-classify with real page text.
const classifyHandler: Handler = async (task, job, deps) => {
  const { candidate } = task.input as { candidate: DiscoveredCandidate; companyId?: string };
  const spec = job.plan as JobSpec;
  const result = await deps.classifyIndustry(candidate, spec.industry, undefined);
  // No model answered: fail so the task retries with backoff, instead of recording a guessed
  // "not in industry" and dropping the company for good.
  if (result.callFailed) {
    return { status: "failed", error: `classify: no model answered (${result.parseError ?? "unknown"})` };
  }
  const fan_out: NewTask[] = [];
  if (result.inIndustry && candidate.website_url) {
    fan_out.push({
      task_type: "crawl",
      stage: 40,
      company_id: task.company_id ?? undefined,
      idempotency_key: `${job.id}:crawl:${normalizeDomain(candidate.website_url) ?? candidate.website_url}`,
      input: { candidate },
    });
  }
  return {
    status: "completed",
    bump: result.inIndustry ? ["in_industry"] : [],
    fan_out,
    output: {
      probability: result.probability,
      inIndustry: result.inIndustry,
      residentialCommercial: result.residentialCommercial,
      engine: result.engine,
      parseError: result.parseError,
    },
  };
};

// Stage 40 — the real crawl handler (PR 7). Picks ≤6 candidate pages off the candidate's
// website_url, runs each through the http->jina->playwright waterfall (which itself gates on
// robots.txt, the aggregator-domain denylist, and the 15% playwright cap), and on at least one
// successful page fans out to stage 50 (extract/tech_detect — real as of PR 8, see extractHandler/
// techDetectHandler below) carrying the evidence refs forward so that stage doesn't need to re-crawl.
const crawlHandler: Handler = async (task, job, deps) => {
  const { candidate } = task.input as { candidate: DiscoveredCandidate };
  if (!candidate?.website_url) {
    return { status: "skipped", output: { reason: "no website_url to crawl" } };
  }

  const domain = normalizeDomain(candidate.website_url);
  if (isAggregatorDomain(domain)) {
    return { status: "skipped", output: { reason: "aggregator-domain", domain } };
  }

  // rates.json's crawl-rung costs are all $0 today (http/jina/playwright), so this is a no-op in
  // practice — kept so a future rate change is enforced here without touching this handler again.
  const reserve = checkReserve(job, 0);
  if (!reserve.ok) {
    return { status: "skipped", output: { reason: "budget_exhausted" } };
  }

  const pages = deps.pickPages(candidate.website_url);
  const companyId = task.company_id ?? undefined;
  const result: CrawlSiteResult = await deps.crawlSite(pages, { jobId: job.id, companyId, researchJobId: job.id });

  const succeeded = result.pages.filter((p) => p.ok);
  const evidence: EvidenceRef[] = succeeded.map((p) => p.evidence).filter((e): e is EvidenceRef => Boolean(e));

  const fan_out: NewTask[] = [];
  if (succeeded.length && companyId) {
    for (const taskType of ["extract", "tech_detect"] as const) {
      fan_out.push({
        task_type: taskType,
        stage: 50,
        company_id: companyId,
        idempotency_key: `${job.id}:${taskType}:${companyId}`,
        input: { candidate, evidence },
      });
    }
  }

  return {
    status: succeeded.length ? "completed" : "skipped",
    cost_usd: result.costUsd,
    fan_out,
    bump: succeeded.length ? ["active_website"] : [],
    output: {
      attempted: pages.length,
      succeeded: succeeded.length,
      pages: result.pages.map((p) => ({ url: p.url, ok: p.ok, method: p.method, reason: p.reason, error: p.error })),
    },
  };
};

// Stage 55 (public_data) is PR 9's territory and is still a skipStub — but the orchestrator only
// advances a job by an explicit fan_out NewTask (orchestrator.ts's handleOne calls
// deps.addTasks(job.id, result.fan_out) off whatever a stage's result carries; there's no separate
// "advance to the next stage" mechanism outside of that). So both extract and tech_detect below fan
// out a public_data task even though PR 9 hasn't built its real handler yet — it'll just hit
// skipStub harmlessly, exactly like crawl's extract/tech_detect fan-out did against THIS PR's stubs
// before now. Both handlers fan out the SAME idempotency_key (`${jobId}:public_data:${companyId}`),
// trusting research_tasks_add's own idempotency-key dedupe (the same mechanism resolve/classify/
// crawl already rely on for their own fan-outs) to collapse the two calls into one task.
function publicDataFanOut(jobId: string, companyId: string): NewTask[] {
  return [
    {
      task_type: "public_data",
      stage: 55,
      company_id: companyId,
      idempotency_key: `${jobId}:public_data:${companyId}`,
      input: { companyId },
    },
  ];
}

// Stage 50 — tier-2 LLM fact extraction (extract/extractFacts.ts) off the evidence stage 40's crawl
// handler fanned out (task.input = {candidate, evidence}, same shape tech_detect below reads). Writes
// facts straight to the OS inside extractFacts itself; this handler just reports the summary and
// advances the pipeline to stage 55.
const extractHandler: Handler = async (task, job, deps) => {
  const { candidate, evidence } = task.input as { candidate: DiscoveredCandidate; evidence: EvidenceRef[] };
  const companyId = task.company_id ?? undefined;
  if (!companyId) {
    return { status: "skipped", output: { reason: "no company_id on extract task" } };
  }
  const result = await deps.extractFacts({ companyId, candidate, evidence: evidence ?? [], researchJobId: job.id });
  return {
    status: "completed",
    fan_out: publicDataFanOut(job.id, companyId),
    output: {
      factsBuilt: result.factsBuilt,
      factsWritten: result.factsWritten,
      grounded: result.groundedCount,
      ungrounded: result.ungroundedCount,
      engine: result.engine,
      parseError: result.parseError,
      notes: result.notes,
    },
  };
};

// Stage 50 — HTML/script signature scan + DNS mail-provider inference (tech/detect.ts) off the same
// evidence crawlHandler fanned out. A separate task_type from extract, same stage (STAGE_ORDER), run
// independently by the orchestrator — see crawlHandler's two-task fan-out above.
const techDetectHandler: Handler = async (task, job, deps) => {
  const { candidate, evidence } = task.input as { candidate: DiscoveredCandidate; evidence: EvidenceRef[] };
  const companyId = task.company_id ?? undefined;
  if (!companyId) {
    return { status: "skipped", output: { reason: "no company_id on tech_detect task" } };
  }
  const allowLive = prospectingMode() === "active";
  const result = await deps.detectTech({ companyId, candidate, evidence: evidence ?? [], researchJobId: job.id, jobId: job.id, allowLive });
  return {
    status: "completed",
    fan_out: publicDataFanOut(job.id, companyId),
    output: {
      detected: result.detected.map((d) => ({ category: d.category, name: d.name, via: d.detectedVia })),
      factsWritten: result.factsWritten,
      mxProvider: result.mxProvider,
      spfIncludes: result.spfIncludes,
      notes: result.notes,
    },
  };
};

// Stage 55 — real handler (PR 9). Pulls the company row, runs publicdata/index.ts's DBPR/Sunbiz/
// county-permit orchestration, writes its assembled facts via factsAdd, and — when it found a
// signal-worthy reason (an active DBPR license, meaningful permit activity) — calls signalsAdd with
// a score_delta (see osBridge.ts's SignalsAdd doc: this ADDS on top of whatever fitScoreRecompute
// last set; stage 60 below never duplicates this reasoning as a fitScore.ts rule). Always fans out to
// stage 60 regardless of what it found — "no FL public data matched this company" is a normal,
// expected outcome (most discovered companies won't have a Hillsborough/Pinellas permit, say), not a
// reason to stop the pipeline.
function scoreFanOut(jobId: string, companyId: string): NewTask[] {
  return [{ task_type: "score", stage: 60, company_id: companyId, idempotency_key: `${jobId}:score:${companyId}`, input: { companyId } }];
}

const publicDataHandler: Handler = async (task, job, deps) => {
  const input = task.input as { companyId?: string };
  const companyId = task.company_id ?? input.companyId;
  if (!companyId) {
    return { status: "skipped", output: { reason: "no company_id on public_data task" } };
  }

  let company: Record<string, unknown> | undefined;
  try {
    company = await deps.companiesGet(companyId);
  } catch (e) {
    if (!(e instanceof OsProspectingUnavailableError)) throw e;
  }
  if (!company || typeof company.name !== "string" || !company.name) {
    // Can't run name-keyed lookups without a company row — still advance the pipeline rather than
    // stall it; score/qualify downstream handle a company with no public_data facts gracefully.
    return { status: "skipped", fan_out: scoreFanOut(job.id, companyId), output: { reason: "company row unavailable — public_data skipped" } };
  }

  const allowLive = prospectingMode() === "active";
  const result = await deps.runFloridaPublicData(
    { id: companyId, name: company.name, city: typeof company.city === "string" ? company.city : undefined, state: typeof company.state === "string" ? company.state : undefined },
    { jobId: job.id, allowLive },
  );

  if (result.facts.length) {
    try {
      await deps.factsAdd({ research_job_id: job.id, facts: result.facts });
    } catch (e) {
      if (!(e instanceof OsProspectingUnavailableError)) throw e;
    }
  }
  if (result.scoreBump) {
    try {
      await deps.signalsAdd({
        company_id: companyId,
        signal_type: result.scoreBump.signal_type,
        headline: result.scoreBump.headline,
        detail: result.scoreBump.detail,
        score_delta: result.scoreBump.score_delta,
        research_job_id: job.id,
      });
    } catch (e) {
      if (!(e instanceof OsProspectingUnavailableError)) throw e;
    }
  }

  return {
    status: "completed",
    fan_out: scoreFanOut(job.id, companyId),
    output: {
      dbprMatches: result.dbpr.length,
      sunbizMatches: result.sunbiz.length,
      permitMatches: result.permits.length,
      jurisdiction: result.jurisdiction,
      factsWritten: result.facts.length,
      scoreBump: result.scoreBump,
      notes: result.notes,
    },
  };
};

// Stage 60 — real handler (PR 9). computeFitScore (intel/fitScore.ts) is pure; this handler is the
// only place that touches the OS — reads the active config, persists the score via fitScoreRecompute
// (the AUTHORITATIVE companies.fit_score writer — see osBridge.ts's SignalsAdd doc comment for why
// stage 55's signals_add score_delta is a SEPARATE, additive path this handler never touches), then
// fans out stage 70, carrying the just-computed score/breakdown forward in the task's `input` so
// qualify doesn't need to re-fetch the config or recompute the breakdown off a possibly-stale
// companies.fit_score read.
const scoreHandler: Handler = async (task, job, deps) => {
  const input = task.input as { companyId?: string };
  const companyId = task.company_id ?? input.companyId;
  if (!companyId) {
    return { status: "skipped", output: { reason: "no company_id on score task" } };
  }

  let company: Record<string, unknown> = {};
  let facts: CompanyFactRow[] = [];
  let technologies: CompanyTechnologyRow[] = [];
  let signals: SignalRow[] = [];
  try {
    [company, facts, technologies, signals] = await Promise.all([
      deps.companiesGet(companyId),
      deps.factsList({ subject_type: "company", subject_id: companyId }),
      deps.companyTechnologiesList(companyId),
      deps.signalsList({ company_id: companyId }),
    ]);
  } catch (e) {
    if (!(e instanceof OsProspectingUnavailableError)) throw e;
  }

  let config: Awaited<ReturnType<typeof deps.loadActiveFitScoreConfig>> = null;
  try {
    config = await deps.loadActiveFitScoreConfig();
  } catch (e) {
    if (!(e instanceof OsProspectingUnavailableError)) throw e;
  }

  const { score, breakdown } = deps.computeFitScore({ id: companyId, ...company }, facts, config, technologies, signals);

  try {
    await deps.fitScoreRecompute({ scores: [{ company_id: companyId, score, breakdown }], config_id: config?.id });
  } catch (e) {
    if (!(e instanceof OsProspectingUnavailableError)) throw e;
  }

  return {
    status: "completed",
    fan_out: [
      {
        task_type: "qualify",
        stage: 70,
        company_id: companyId,
        idempotency_key: `${job.id}:qualify:${companyId}`,
        input: { companyId, fitScore: score, fitBreakdown: breakdown },
      },
    ],
    output: { score, breakdown, configId: config?.id, rulesApplied: breakdown.length },
  };
};

// Stage 70 — real handler (PR 9). extract/qualify.ts's tier-2/tier-3 verdict, fed the revenue
// estimate (intel/revenue.ts) and the fit-score breakdown stage 60 computed and threaded through this
// task's input (falls back to recomputing off the company's current companies.fit_score/facts when
// the task was queued some other way, e.g. a future manual re-qualify). `allow_mobile` is READ off
// the job's gates and THREADED into the stage-80 fan-out's `input` — this handler implements no
// mobile-search logic itself (that's a later PR's find_phone, stage 90); it only makes sure the gate
// survives the handoff so that handler can honor it without re-deriving it from the job spec. Only
// qualified:true companies advance past this stage — an unqualified company's pipeline stops here, no
// further enrichment spend on a company AI qualification rejected.
const qualifyHandler: Handler = async (task, job, deps) => {
  const input = task.input as { companyId?: string; fitScore?: number; fitBreakdown?: FitScoreBreakdownEntry[] };
  const companyId = task.company_id ?? input.companyId;
  if (!companyId) {
    return { status: "skipped", output: { reason: "no company_id on qualify task" } };
  }
  const spec = job.plan as JobSpec;

  let company: Record<string, unknown> = {};
  let facts: CompanyFactRow[] = [];
  try {
    [company, facts] = await Promise.all([
      deps.companiesGet(companyId),
      deps.factsList({ subject_type: "company", subject_id: companyId }),
    ]);
  } catch (e) {
    if (!(e instanceof OsProspectingUnavailableError)) throw e;
  }

  const fitScore = input.fitScore ?? (typeof company.fit_score === "number" ? company.fit_score : 0);
  let fitBreakdown = input.fitBreakdown;
  if (!fitBreakdown) {
    let config: Awaited<ReturnType<typeof deps.loadActiveFitScoreConfig>> = null;
    try {
      config = await deps.loadActiveFitScoreConfig();
    } catch (e) {
      if (!(e instanceof OsProspectingUnavailableError)) throw e;
    }
    fitBreakdown = deps.computeFitScore({ id: companyId, ...company }, facts, config).breakdown;
  }

  let revenue: RevenueEstimate;
  try {
    revenue = await deps.estimateRevenueForCompany(companyId);
  } catch {
    revenue = { revenue: null, estimators: [], adsMultiplierApplied: false, reason: "revenue estimate unavailable" };
  }

  const verdict = await deps.qualifyCompany({
    companyId,
    companyName: typeof company.name === "string" ? company.name : "",
    industry: spec.industry,
    fitScore,
    fitBreakdown,
    revenue,
    facts: facts.map((f) => ({ field_name: f.field_name, value: f.value, confidence: f.confidence })),
  });

  if (verdict.qualified) {
    // Lazy import: jobFinalize imports this module.
    const { addToJobList } = await import("./jobFinalize");
    await addToJobList(job, companyId, `qualified (fit ${fitScore ?? "?"}, ${verdict.tier ?? "tier ?"})`);
  }
  const fan_out: NewTask[] = verdict.qualified
    ? [{
        task_type: "find_people",
        stage: 80,
        company_id: companyId,
        idempotency_key: `${job.id}:find_people:${companyId}`,
        input: { companyId, allow_mobile: spec.gates.allow_mobile },
      }]
    : [];

  return {
    status: "completed",
    fan_out,
    bump: verdict.qualified ? ["ai_qualified"] : [],
    output: {
      qualified: verdict.qualified,
      reasons: verdict.reasons,
      tier: verdict.tier,
      escalated: verdict.escalated,
      aggregateConfidence: verdict.aggregateConfidence,
      fitScore,
      revenue: revenue.revenue,
    },
  };
};

// ── Stages 80/85/87/90 — buyer discovery + email/phone waterfalls (PR 11) ───────────────────────
//
// Chain: find_people (80) -> find_email (85) -> verify_email (87) -> [phoneGate] -> find_phone (90).
// Each stage fans out exactly the next one, carrying forward whatever the next stage needs in its
// task `input` (the person found, the company/fit context) so no stage re-fetches what the previous
// one already knew. A miss at any point (no decision maker, no email, phoneGate refusing) ends the
// chain for that company with a `status:"completed"` (not "failed" — "we looked and didn't find one"
// is an ordinary, expected outcome for a research pipeline, never an error) and no further fan-out.

interface ChainPersonInput {
  fullName: string;
  firstName?: string;
  lastName?: string;
  title?: string;
  linkedinUrl?: string;
}

function personToRungContext(p: ChainPersonInput): PersonContext {
  return { fullName: p.fullName, firstName: p.firstName, lastName: p.lastName, title: p.title, linkedinUrl: p.linkedinUrl };
}

function discoveredPersonToChainInput(p: DiscoveredPerson): ChainPersonInput {
  return { fullName: p.fullName, firstName: p.firstName, lastName: p.lastName, title: p.title, linkedinUrl: p.linkedinUrl };
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
function str(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}

const findPeopleHandler: Handler = async (task, job, deps) => {
  const input = task.input as { companyId?: string; allow_mobile?: boolean };
  const companyId = task.company_id ?? input.companyId;
  if (!companyId) return { status: "skipped", output: { reason: "no company_id on find_people task" } };

  let company: Record<string, unknown> = {};
  try {
    company = await deps.companiesGet(companyId);
  } catch (e) {
    if (!(e instanceof OsProspectingUnavailableError)) throw e;
  }

  const allowLive = prospectingMode() === "active";
  const result = await deps.buyerDiscover(
    {
      id: companyId,
      name: str(company.name) ?? "",
      website_url: str(company.website_url),
      city: str(company.city),
      state: str(company.state),
      employees_estimate: num(company.employees_estimate),
      revenue_low: num(company.revenue_low),
      revenue_high: num(company.revenue_high),
      review_count: num(company.review_count),
    },
    { jobId: job.id, allowLive },
  );

  const fan_out: NewTask[] = [];
  if (result.person) {
    fan_out.push({
      task_type: "find_email",
      stage: 85,
      company_id: companyId,
      idempotency_key: `${job.id}:find_email:${companyId}`,
      input: { companyId, personId: result.personId, person: discoveredPersonToChainInput(result.person), allow_mobile: input.allow_mobile },
    });
  }

  return {
    status: "completed",
    cost_usd: result.costUsd,
    bump: result.person ? ["dm_found"] : [],
    fan_out,
    output: { found: Boolean(result.person), source: result.person?.source, title: result.person?.title, log: result.log },
  };
};

/** Shared by find_email/find_phone — the company row + target person reduced to the one shape
 *  contacts/waterfall.ts's rungs actually read. `extra.email` is only set for the phone waterfall
 *  (leadmagic_mobile's work-email input — see contacts/rungs/leadmagicMobile.ts). */
function buildRungContext(
  companyId: string,
  company: Record<string, unknown>,
  person: PersonContext | undefined,
  fitScore: number,
  allowLive: boolean,
  jobId: string,
  extra: { email?: string } = {},
): import("./contacts/waterfall").RungContext {
  const websiteUrl = str(company.website_url);
  return {
    companyId,
    companyName: str(company.name) ?? "",
    domain: websiteUrl ? normalizeDomain(websiteUrl) : undefined,
    websiteUrl,
    city: str(company.city),
    state: str(company.state),
    officePhone: str(company.phone),
    person,
    fitScore,
    allowLive,
    jobId,
    email: extra.email,
  };
}

const findEmailHandler: Handler = async (task, job, deps) => {
  const input = task.input as { companyId?: string; personId?: string; person?: ChainPersonInput; allow_mobile?: boolean };
  const companyId = task.company_id ?? input.companyId;
  if (!companyId || !input.person) return { status: "skipped", output: { reason: "no company_id or person on find_email task" } };

  let company: Record<string, unknown> = {};
  try {
    company = await deps.companiesGet(companyId);
  } catch (e) {
    if (!(e instanceof OsProspectingUnavailableError)) throw e;
  }

  const allowLive = prospectingMode() === "active";
  const fitScore = num(company.fit_score) ?? 0;
  const ctx = buildRungContext(companyId, company, personToRungContext(input.person), fitScore, allowLive, job.id);

  const wf = await deps.runEmailWaterfall(ctx);
  if (!wf.result) {
    return { status: "completed", cost_usd: wf.totalCostUsd, output: { found: false, log: wf.log } };
  }

  // Suppression check before every write (plan: "before every write" — never just before a send).
  try {
    const check = await deps.suppressionsCheck({ channel: "email", email: wf.result.value, company_id: companyId });
    if (check.blocked) {
      // outreach_events_add requires a real sequence_enrollments row (PR 14's sequenceRunner) —
      // none exists yet at discovery time, so the audit trail for a blocked FIND lives in the local
      // ledger instead (same best-effort, never-throws convention as every other ledger write in
      // this codebase). See osBridge.ts's OutreachEventsAddInput doc comment for the full reasoning.
      await ledgerAppend({
        kind: "action", actor: "clara",
        what: `prospecting: blocked email write for company ${companyId} (${wf.result.provider}) — ${JSON.stringify(check.hits)}`,
        meta: { companyId, jobId: job.id, kind: "contact.blocked", channel: "email" },
      }).catch(() => {});
      return { status: "completed", cost_usd: wf.totalCostUsd, output: { found: false, blocked: true, reasons: check.hits, log: wf.log } };
    }
  } catch (e) {
    if (!(e instanceof OsProspectingUnavailableError)) throw e;
  }

  let methodId: string | undefined;
  try {
    const up = await deps.contactMethodsUpsert({
      company_id: companyId,
      person_id: input.personId,
      kind: "email",
      value: wf.result.value,
      provider: wf.result.provider as ContactMethodsUpsertInput["provider"],
      verification_status: wf.result.verificationStatus,
      confidence: wf.result.confidence,
      source_url: wf.result.sourceUrl,
      is_primary: true,
    });
    methodId = up.method?.id;
  } catch (e) {
    if (!(e instanceof OsProspectingUnavailableError)) throw e;
  }

  const fan_out: NewTask[] = [{
    task_type: "verify_email",
    stage: 87,
    company_id: companyId,
    idempotency_key: `${job.id}:verify_email:${companyId}`,
    input: {
      companyId, personId: input.personId, methodId, email: wf.result.value, provider: wf.result.provider,
      initialStatus: wf.result.verificationStatus, person: input.person, allow_mobile: input.allow_mobile,
    },
  }];

  return {
    status: "completed",
    cost_usd: wf.totalCostUsd,
    bump: ["email_found"],
    fan_out,
    output: { found: true, provider: wf.result.provider, verificationStatus: wf.result.verificationStatus, log: wf.log },
  };
};

const verifyEmailHandler: Handler = async (task, job, deps) => {
  const input = task.input as {
    companyId?: string; personId?: string; methodId?: string; email?: string; provider?: string;
    initialStatus?: VerificationStatus; person?: ChainPersonInput; allow_mobile?: boolean;
  };
  const companyId = task.company_id ?? input.companyId;
  if (!companyId || !input.email) return { status: "skipped", output: { reason: "no company_id or email on verify_email task" } };

  const allowLive = prospectingMode() === "active";
  const fallbackStatus: VerificationStatus = input.initialStatus ?? "unknown";
  const verdict = await deps.verifyEmail(input.email, { allowLive, jobId: job.id, companyId, fallbackStatus });

  try {
    await deps.contactMethodsUpsert({
      company_id: companyId,
      person_id: input.personId,
      kind: "email",
      value: input.email,
      provider: (input.provider as ContactMethodsUpsertInput["provider"]) ?? "manual",
      verification_status: verdict.status,
      verifier: verdict.verifier,
      is_primary: true,
    });
  } catch (e) {
    if (!(e instanceof OsProspectingUnavailableError)) throw e;
  }

  let company: Record<string, unknown> = {};
  try {
    company = await deps.companiesGet(companyId);
  } catch (e) {
    if (!(e instanceof OsProspectingUnavailableError)) throw e;
  }
  const fitScore = num(company.fit_score) ?? 0;
  const funnel = (job.funnel ?? {}) as Partial<import("./types").FunnelCounts>;
  const spec = job.plan as JobSpec;
  const gate = phoneGateReal({
    fitScore,
    decisionMakerFound: Boolean(input.person),
    emailStatus: verdict.status,
    allowMobile: input.allow_mobile ?? spec.gates?.allow_mobile ?? false,
    mobileRequested: funnel.mobile_requested ?? 0,
    qualifiedCount: funnel.ai_qualified ?? 0,
    mobileShareMax: spec.gates?.mobile_share_max,
  });

  const fan_out: NewTask[] = gate.allow
    ? [{
        task_type: "find_phone",
        stage: 90,
        company_id: companyId,
        idempotency_key: `${job.id}:find_phone:${companyId}`,
        input: { companyId, personId: input.personId, person: input.person, email: input.email },
      }]
    : [];

  return {
    status: "completed",
    cost_usd: verdict.costUsd,
    fan_out,
    output: { status: verdict.status, verifier: verdict.verifier, attempted: verdict.attempted, phoneGate: gate },
  };
};

const findPhoneHandler: Handler = async (task, job, deps) => {
  const input = task.input as { companyId?: string; personId?: string; person?: ChainPersonInput; email?: string };
  const companyId = task.company_id ?? input.companyId;
  if (!companyId) return { status: "skipped", output: { reason: "no company_id on find_phone task" } };

  let company: Record<string, unknown> = {};
  try {
    company = await deps.companiesGet(companyId);
  } catch (e) {
    if (!(e instanceof OsProspectingUnavailableError)) throw e;
  }

  const allowLive = prospectingMode() === "active";
  const fitScore = num(company.fit_score) ?? 0;
  const ctx = buildRungContext(companyId, company, input.person ? personToRungContext(input.person) : undefined, fitScore, allowLive, job.id, { email: input.email });

  const wf = await deps.runMobileWaterfall(ctx);
  if (!wf.result) {
    return { status: "completed", cost_usd: wf.totalCostUsd, bump: ["mobile_requested"], output: { found: false, log: wf.log } };
  }

  try {
    const check = await deps.suppressionsCheck({
      channel: wf.result.kind === "mobile" ? "sms" : "voice",
      phone: wf.result.value,
      company_id: companyId,
    });
    if (check.blocked) {
      // See find_email's identical note: no enrollment exists yet to write outreach_events against.
      await ledgerAppend({
        kind: "action", actor: "clara",
        what: `prospecting: blocked ${wf.result.kind} write for company ${companyId} (${wf.result.provider}) — ${JSON.stringify(check.hits)}`,
        meta: { companyId, jobId: job.id, kind: "contact.blocked", channel: wf.result.kind },
      }).catch(() => {});
      return { status: "completed", cost_usd: wf.totalCostUsd, bump: ["mobile_requested"], output: { found: false, blocked: true, reasons: check.hits, log: wf.log } };
    }
  } catch (e) {
    if (!(e instanceof OsProspectingUnavailableError)) throw e;
  }

  try {
    await deps.contactMethodsUpsert({
      company_id: companyId,
      person_id: input.personId,
      kind: wf.result.kind as "phone" | "mobile",
      value: wf.result.value,
      provider: wf.result.provider as ContactMethodsUpsertInput["provider"],
      verification_status: wf.result.verificationStatus,
      confidence: wf.result.confidence,
      source_url: wf.result.sourceUrl,
      is_primary: wf.result.kind === "mobile",
    });
  } catch (e) {
    if (!(e instanceof OsProspectingUnavailableError)) throw e;
  }

  return {
    status: "completed",
    cost_usd: wf.totalCostUsd,
    bump: wf.result.kind === "mobile" ? ["mobile_requested", "mobile_found"] : ["mobile_requested"],
    output: { found: true, kind: wf.result.kind, provider: wf.result.provider, log: wf.log },
  };
};

const reportHandler: Handler = async (_task, job, deps) => {
  let companies: CompanyExportRow[] = [];
  try {
    companies = toExportRows(await deps.companiesSearch({ research_job_id: job.id, limit: 500 }));
  } catch (e) {
    if (!(e instanceof OsProspectingUnavailableError)) throw e;
  }
  const res = await deps.deliverJobReport(job, companies);
  return { status: res.ok ? "completed" : "failed", error: res.ok ? undefined : res.error, output: { docUrl: res.docUrl, sheetUrl: res.sheetUrl, companies: companies.length } };
};

const skipStub: Handler = async () => ({ status: "skipped", output: { reason: "stage not implemented until a later PR" } });

// signal_scan (PR 17) — DELIBERATELY left as a skipStub, not wired to a real handler. The plan's own
// phrasing ("signals/refresh.ts as the scheduler job, every 60 min") and the OS seed comment on
// `clara.prospect_signal_scan` ("re-check companies on ACTIVE PROSPECT LISTS") both describe a
// company-level recurring scan, not a per-job pipeline stage — a research_task only exists in the
// context of ONE research_job's funnel, whereas a signal check cares about a company that may not
// even have an open job any more (most won't, once qualified/promoted). So the real mechanism is
// prospecting/signals/refresh.ts's standalone `signalRefreshTick`, wired straight into
// scheduler.ts's JOBS array as `prospect-signal-scan` — see that file's own header comment. Making
// THIS stage real too (an on-demand, single-company signal check inside a job) would mean either
// re-deriving refresh.ts's cadence/budget/sequencing logic here or threading a `SignalDef` down into
// a handler that has no natural per-company cadence state to check against (a research_task has no
// "last checked" of its own — that state lives on the company's facts, which refresh.ts already
// reads). That's real scope for a future PR if one ever wants ad-hoc "check signals for this ONE
// company as part of this job" — not something worth adding speculatively here.
export const HANDLERS: Record<TaskType, Handler> = {
  discover: discoverHandler,
  resolve: resolveHandler,
  classify: classifyHandler,
  crawl: crawlHandler,
  extract: extractHandler,
  tech_detect: techDetectHandler,
  public_data: publicDataHandler,
  score: scoreHandler,
  qualify: qualifyHandler,
  find_people: findPeopleHandler,
  find_email: findEmailHandler,
  verify_email: verifyEmailHandler,
  find_phone: findPhoneHandler,
  signal_scan: skipStub,
  personalize: skipStub,
  report: reportHandler,
};

export async function runStage(task: ClaimedTask, job: Job, deps: StageDeps = defaultStageDeps): Promise<StageResult> {
  const handler = HANDLERS[task.task_type];
  if (!handler) return { status: "failed", error: `no handler for task_type ${task.task_type}` };
  return withSpendContext({ jobId: job.id, companyId: task.company_id ?? undefined }, () => handler(task, job, deps));
}
