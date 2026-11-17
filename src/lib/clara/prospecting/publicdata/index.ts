// publicdata/index.ts — stage 55's `public_data` collaborator: runs the DBPR/Sunbiz/county-permit
// lookups for one company, assembles the facts they produce, and decides whether the result is
// meaningful enough to also bump fit score via a discrete signals_add score_delta (NOT via
// fitScoreRecompute — see osBridge.ts's SignalsAdd doc comment and intel/fitScore.ts's module doc for
// why these two score-writing paths stay separate).

import { normalizeName } from "../entity/normalize";
import { refreshDbprCache as refreshDbprCacheReal, lookupDbpr as lookupDbprReal, defaultDbprDeps, type DbprDeps } from "./flDbpr";
import { lookupSunbiz as lookupSunbizReal, defaultSunbizDeps, type SunbizDeps } from "./flSunbiz";
import { lookupPermits as lookupHillsboroughPermitsReal, defaultHillsboroughPermitsDeps, type HillsboroughPermitsDeps } from "./flPermits/hillsborough";
import { lookupPermits as lookupPinellasPermitsReal, defaultPinellasPermitsDeps, type PinellasPermitsDeps } from "./flPermits/pinellas";
import type { DbprRecord, PermitJurisdiction, PermitRecord, SunbizRecord } from "./types";
import type { FactInput, SignalType } from "../osBridge";

/** City -> county-jurisdiction map used to pick which (if either) county permit adapter to run —
 *  deliberately small and Tampa-Bay-focused (this plan's target vertical/geography); a city not
 *  listed here simply skips permits, which is the expected, common case for most of Florida. */
const HILLSBOROUGH_CITIES: ReadonlySet<string> = new Set([
  "tampa", "brandon", "riverview", "plant city", "valrico", "lutz", "seffner", "thonotosassa",
  "temple terrace", "ruskin", "sun city center", "apollo beach", "gibsonton", "dover",
]);
const PINELLAS_CITIES: ReadonlySet<string> = new Set([
  "st petersburg", "saint petersburg", "clearwater", "largo", "dunedin", "pinellas park",
  "seminole", "tarpon springs", "safety harbor", "oldsmar", "gulfport", "madeira beach",
  "treasure island", "indian rocks beach", "palm harbor",
]);

export function pickPermitJurisdiction(city: string | undefined): PermitJurisdiction | undefined {
  if (!city) return undefined;
  const c = city.trim().toLowerCase();
  if (HILLSBOROUGH_CITIES.has(c)) return "hillsborough";
  if (PINELLAS_CITIES.has(c)) return "pinellas";
  return undefined;
}

/** DBPR status + license-type-active threshold for the "active roofing license" bump. */
const DBPR_BUMP_SCORE_DELTA = 5;
/** 3+ permits on file is treated as "recent permit volume" worth a signal. */
const PERMIT_VOLUME_THRESHOLD = 3;
const PERMIT_VOLUME_BUMP_SCORE_DELTA = 5;

export interface PublicDataCompanyInput {
  id: string;
  name: string;
  city?: string;
  state?: string;
}

export interface RunFloridaPublicDataOpts {
  jobId?: string;
  allowLive: boolean;
}

export interface FloridaPublicDataScoreBump {
  signal_type: SignalType;
  headline: string;
  score_delta: number;
  detail?: string;
}

export interface RunFloridaPublicDataResult {
  facts: FactInput[];
  scoreBump?: FloridaPublicDataScoreBump;
  dbpr: DbprRecord[];
  sunbiz: SunbizRecord[];
  permits: PermitRecord[];
  jurisdiction?: PermitJurisdiction;
  notes: string[];
}

export interface PublicDataDeps {
  refreshDbprCache: typeof refreshDbprCacheReal;
  lookupDbpr: typeof lookupDbprReal;
  dbprDeps: DbprDeps;
  lookupSunbiz: typeof lookupSunbizReal;
  sunbizDeps: SunbizDeps;
  lookupHillsboroughPermits: typeof lookupHillsboroughPermitsReal;
  hillsboroughDeps: HillsboroughPermitsDeps;
  lookupPinellasPermits: typeof lookupPinellasPermitsReal;
  pinellasDeps: PinellasPermitsDeps;
}

export async function defaultPublicDataDeps(): Promise<PublicDataDeps> {
  return {
    refreshDbprCache: refreshDbprCacheReal,
    lookupDbpr: lookupDbprReal,
    dbprDeps: await defaultDbprDeps(),
    lookupSunbiz: lookupSunbizReal,
    sunbizDeps: defaultSunbizDeps,
    lookupHillsboroughPermits: lookupHillsboroughPermitsReal,
    hillsboroughDeps: defaultHillsboroughPermitsDeps,
    lookupPinellasPermits: lookupPinellasPermitsReal,
    pinellasDeps: defaultPinellasPermitsDeps,
  };
}

function dbprFacts(companyId: string, records: DbprRecord[]): FactInput[] {
  return records.map((r) => ({
    subject_type: "company" as const,
    subject_id: companyId,
    field_name: "dbpr_license",
    value: r.licenseNumber,
    normalized_value: r.licenseNumber.toUpperCase(),
    source_type: "dbpr" as const,
    confidence: 0.9,
    grounded: true,
    multi_valued: true,
    evidence: { licenseType: r.licenseType, status: r.status, statusActive: r.statusActive, businessName: r.businessName, licenseeName: r.licenseeName },
  }));
}

function sunbizFacts(companyId: string, records: SunbizRecord[]): FactInput[] {
  return records.slice(0, 1).flatMap((r): FactInput[] => [
    {
      subject_type: "company", subject_id: companyId, field_name: "sunbiz_document_number", value: r.documentNumber,
      source_type: "sunbiz", confidence: 0.75, grounded: true, evidence: { entityName: r.entityName },
    },
    {
      subject_type: "company", subject_id: companyId, field_name: "sunbiz_status", value: r.status,
      normalized_value: r.status.toLowerCase(), source_type: "sunbiz", confidence: 0.75, grounded: true,
      evidence: { statusActive: r.statusActive, registeredAgentName: r.registeredAgentName },
    },
  ]);
}

function permitFacts(companyId: string, records: PermitRecord[]): FactInput[] {
  const facts: FactInput[] = [];
  for (const p of records) {
    if (typeof p.valuation === "number" && p.valuation > 0) {
      facts.push({
        subject_type: "company", subject_id: companyId, field_name: "permit_value", value: p.valuation,
        source_type: "permit", confidence: 0.7, grounded: true, multi_valued: true,
        evidence: { permitNumber: p.permitNumber, jurisdiction: p.jurisdiction, description: p.description, issueDate: p.issueDate },
      });
    }
  }
  if (records.length) {
    facts.push({
      subject_type: "company", subject_id: companyId, field_name: "permit_count", value: records.length,
      source_type: "permit", confidence: 0.7, grounded: true,
      evidence: { jurisdiction: records[0]?.jurisdiction },
    });
  }
  return facts;
}

/**
 * Runs DBPR + Sunbiz + the matching county permit adapter (by city; skipped entirely when the
 * company's city isn't in HILLSBOROUGH_CITIES/PINELLAS_CITIES — true for most of Florida and
 * expected, not an error) for one company, and assembles the facts to write plus an optional
 * fit-score bump. At most ONE scoreBump is ever returned per run — when both an active DBPR license
 * AND permit volume qualify, permit volume (the stronger, more recent signal) wins; see the inline
 * comment at the decision point for the exact reasoning and point values.
 */
export async function runFloridaPublicData(
  company: PublicDataCompanyInput,
  opts: RunFloridaPublicDataOpts,
  deps: PublicDataDeps,
): Promise<RunFloridaPublicDataResult> {
  const notes: string[] = [];
  const name = company.name.trim();

  const refresh = await deps.refreshDbprCache(deps.dbprDeps);
  if (refresh.error) notes.push(`dbpr cache refresh: ${refresh.error}`);

  const dbpr = name ? await deps.lookupDbpr(normalizeName(name), company.state, deps.dbprDeps) : [];

  const sunbiz = name && opts.allowLive ? await deps.lookupSunbiz(name, company.id, { jobId: opts.jobId, allowLive: opts.allowLive }, deps.sunbizDeps) : [];
  if (!opts.allowLive) notes.push("shadow mode — sunbiz lookup skipped");

  const jurisdiction = pickPermitJurisdiction(company.city);
  let permits: PermitRecord[] = [];
  if (jurisdiction === "hillsborough") {
    permits = await deps.lookupHillsboroughPermits(name, deps.hillsboroughDeps);
  } else if (jurisdiction === "pinellas") {
    permits = await deps.lookupPinellasPermits(name, deps.pinellasDeps);
  } else {
    notes.push(`company city "${company.city ?? ""}" is not in a jurisdiction this PR covers — permits skipped`);
  }

  const facts: FactInput[] = [
    ...dbprFacts(company.id, dbpr),
    ...sunbizFacts(company.id, sunbiz),
    ...permitFacts(company.id, permits),
  ];

  // Fit-score bump decision: permit volume is the stronger, more recent-activity signal, so it wins
  // when both qualify (never stack both into one call — see module doc). Point values (5 each) are a
  // documented, deliberately modest heuristic: enough to matter in the ambiguous 55-65 qualify band
  // (extract/qualify.ts) without single-handedly qualifying a company that nothing else supports.
  let scoreBump: FloridaPublicDataScoreBump | undefined;
  if (permits.length >= PERMIT_VOLUME_THRESHOLD) {
    scoreBump = {
      signal_type: "permit",
      headline: `${permits.length} ${jurisdiction} permits on file`,
      score_delta: PERMIT_VOLUME_BUMP_SCORE_DELTA,
      detail: `Recent permit activity (${permits.length} records) in ${jurisdiction} suggests an active, trading contractor.`,
    };
  } else if (dbpr.some((r) => r.statusActive)) {
    const active = dbpr.find((r) => r.statusActive)!;
    scoreBump = {
      signal_type: "other",
      headline: `Active DBPR ${active.licenseType} license on file`,
      score_delta: DBPR_BUMP_SCORE_DELTA,
      detail: `License ${active.licenseNumber} is in good standing (${active.status}).`,
    };
  }

  return { facts, scoreBump, dbpr, sunbiz, permits, jurisdiction, notes };
}

/** Thin live wrapper stages.ts's stage-55 handler actually injects into StageDeps — builds the real
 *  DBPR/Sunbiz/permits deps (defaultPublicDataDeps, which lazily loads the config-derived dataDir)
 *  once per call and delegates to runFloridaPublicData above. Kept separate from that function so
 *  tests can call runFloridaPublicData directly with fully-controlled fakes without touching disk. */
export async function runFloridaPublicDataForCompany(
  company: PublicDataCompanyInput,
  opts: RunFloridaPublicDataOpts,
): Promise<RunFloridaPublicDataResult> {
  const deps = await defaultPublicDataDeps();
  return runFloridaPublicData(company, opts, deps);
}
