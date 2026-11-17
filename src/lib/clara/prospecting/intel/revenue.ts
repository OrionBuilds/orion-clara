// intel/revenue.ts — PR 9's revenue estimator. Same pure/live split as estimator.ts: `estimateRevenue`
// is pure (takes already-resolved numeric inputs, no I/O, unit-tested directly per-estimator and in
// combination); `estimateRevenueForCompany` is the thin live wrapper that pulls those inputs off the
// OS (companiesGet/factsList) and hands them to the pure function. Keep all I/O at the edge.
//
// Four candidate estimators per the plan, each independent and each skippable when its input isn't
// available:
//   1. employees   — employees * $200k/employee. SKIPPED today: nothing in PR 7/8's extraction yet
//      produces an employee-count fact (the §9 schema has no "employees" field) — this is a known,
//      expected gap; a later PR adding employee-count extraction will start feeding this estimator
//      for free, no change needed here.
//   2. reviews      — (review_count / yearsActive) * 25 leads/review-year * $12k/job. yearsActive
//      comes from the company's `year_founded` fact (PR 8) when present; skipped otherwise (no
//      invented assumption about review-collection period — see the plan's "or ÷ some assumed
//      period" alternative, deliberately not implemented since there's no non-arbitrary number to
//      use yet).
//   3. permits      — sum(permit valuation) * 1.3, fed by THIS PR's publicdata/flPermits/* adapters
//      (via facts written as field_name "permit_value" by publicdata/index.ts).
//   4. locations    — locationsCount * $500k/location heuristic base, scaled by a years-in-business
//      multiplier (yearsInBusinessMultiplier below). Both a heuristic; documented, not derived from
//      any external source.
// Ads-active is NOT a fifth estimator — per the plan it's a flat +15% multiplier applied to the
// combined base estimate (and its low/high range) AFTER the geometric mean, never a value that
// participates in the mean/spread/confidence math itself.

import { companiesGet as companiesGetReal, factsList as factsListReal } from "../osBridge";

export const REVENUE_PER_EMPLOYEE = 200_000;
export const LEADS_PER_REVIEW_PER_YEAR = 25;
export const AVG_JOB_VALUE_USD = 12_000;
export const PERMIT_VALUATION_MULTIPLIER = 1.3;
export const ADS_ACTIVE_MULTIPLIER = 1.15;
/** Heuristic base revenue per physical location for a home-services business — not sourced from any
 *  external benchmark, a deliberately simple round number documented here so a later PR can replace
 *  it with something better-grounded without hunting for where it's buried. */
export const BASE_REVENUE_PER_LOCATION = 500_000;
/** §plan: "Range from spread (±35% if one)" — the single-estimator case. */
export const SINGLE_ESTIMATOR_RANGE_PCT = 0.35;

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** 0 years → 0.6x (brand new, likely under-trading its "on paper" size), ~15 years → 1.0x, 25+ years
 *  → clamps at 1.25x. A smooth, simple curve — documented heuristic, not a fitted model.
 *  `undefined`/invalid years is treated as neutral (1.0), not "0 years". */
export function yearsInBusinessMultiplier(years: number | undefined): number {
  if (years === undefined || !Number.isFinite(years) || years < 0) return 1;
  return clamp(0.6 + years * 0.026, 0.6, 1.25);
}

export interface RevenueInputs {
  /** Known/estimated headcount. No current fact source feeds this (see module doc) — always
   *  undefined from estimateRevenueForCompany today; kept in the pure function's shape so a later PR
   *  can wire it up without touching this file. */
  employees?: number;
  reviewCount?: number;
  /** Years the business has been reviewable/operating — derived from `year_founded` when present. */
  yearsActive?: number;
  /** Sum of this company's matched FL permit valuations (publicdata/flPermits/*), pre-multiplier. */
  permitValueSum?: number;
  /** Distinct physical locations, when known. */
  locationsCount?: number;
  /** Same meaning as yearsActive; kept separate since a future caller may have a more precise "years
   *  in business" than "years since first review" — estimateRevenueForCompany feeds both from the
   *  same year_founded fact today. */
  yearsInBusiness?: number;
  adsActive?: boolean;
}

export interface RevenueEstimatorContribution {
  name: "employees" | "reviews" | "permits" | "locations";
  value: number;
}

export interface RevenueEstimate {
  /** Dollars/year, or null when no estimator had a usable input. */
  revenue: number | null;
  low?: number;
  high?: number;
  /** 0–1. Higher with more contributing estimators that roughly agree; lower with few or disagreeing
   *  estimators. See computeRevenueConfidence for the exact formula. */
  confidence?: number;
  /** Which estimators actually contributed, and their individual (pre-ads-multiplier) dollar value —
   *  useful for tests and for a future UI breakdown. */
  estimators: RevenueEstimatorContribution[];
  adsMultiplierApplied: boolean;
  reason?: string;
}

function geometricMean(values: number[]): number {
  const logs = values.map((v) => Math.log(v));
  return Math.exp(logs.reduce((a, b) => a + b, 0) / logs.length);
}

function mean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** Population coefficient of variation (stddev / mean) across the contributing estimators — 0 when
 *  there's only one (nothing to disagree with). */
function coefficientOfVariation(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  if (m <= 0) return 0;
  const variance = mean(values.map((v) => (v - m) ** 2));
  return Math.sqrt(variance) / m;
}

/**
 * Confidence formula (documented, heuristic, deliberately simple): a count term that grows with the
 * number of contributing estimators (+0.2 each, capped at 4 → 0.8), floored at +0.2 for having any
 * input at all, then scaled by an agreement factor (1 − coefficient of variation, floored so it's
 * never a pure zero-out). More agreeing estimators → higher confidence; the same count with wide
 * disagreement → lower confidence than fewer-but-agreeing estimators. Clamped to [0,1].
 */
export function computeRevenueConfidence(values: number[]): number {
  if (!values.length) return 0;
  const countTerm = clamp(0.2 * Math.min(values.length, 4), 0, 0.8);
  const cv = coefficientOfVariation(values);
  const agreement = clamp(1 - cv, 0, 1);
  return clamp((countTerm + 0.2) * (0.3 + 0.7 * agreement), 0, 1);
}

/** Pure revenue estimator — see module doc for the four candidate estimators and the ads multiplier. */
export function estimateRevenue(inputs: RevenueInputs): RevenueEstimate {
  const estimators: RevenueEstimatorContribution[] = [];

  if (inputs.employees !== undefined && Number.isFinite(inputs.employees) && inputs.employees > 0) {
    estimators.push({ name: "employees", value: inputs.employees * REVENUE_PER_EMPLOYEE });
  }
  if (
    inputs.reviewCount !== undefined && Number.isFinite(inputs.reviewCount) && inputs.reviewCount > 0 &&
    inputs.yearsActive !== undefined && Number.isFinite(inputs.yearsActive) && inputs.yearsActive > 0
  ) {
    const reviewsPerYear = inputs.reviewCount / inputs.yearsActive;
    estimators.push({ name: "reviews", value: reviewsPerYear * LEADS_PER_REVIEW_PER_YEAR * AVG_JOB_VALUE_USD });
  }
  if (inputs.permitValueSum !== undefined && Number.isFinite(inputs.permitValueSum) && inputs.permitValueSum > 0) {
    estimators.push({ name: "permits", value: inputs.permitValueSum * PERMIT_VALUATION_MULTIPLIER });
  }
  if (inputs.locationsCount !== undefined && Number.isFinite(inputs.locationsCount) && inputs.locationsCount > 0) {
    const mult = yearsInBusinessMultiplier(inputs.yearsInBusiness);
    estimators.push({ name: "locations", value: inputs.locationsCount * BASE_REVENUE_PER_LOCATION * mult });
  }

  if (!estimators.length) {
    return { revenue: null, estimators, adsMultiplierApplied: false, reason: "no estimator inputs available" };
  }

  const values = estimators.map((e) => e.value);
  const base = geometricMean(values);
  const confidence = computeRevenueConfidence(values);

  let low: number;
  let high: number;
  if (values.length === 1) {
    low = base * (1 - SINGLE_ESTIMATOR_RANGE_PCT);
    high = base * (1 + SINGLE_ESTIMATOR_RANGE_PCT);
  } else {
    low = Math.min(...values) * 0.9;
    high = Math.max(...values) * 1.1;
  }

  const adsMultiplierApplied = Boolean(inputs.adsActive);
  const factor = adsMultiplierApplied ? ADS_ACTIVE_MULTIPLIER : 1;

  return {
    revenue: Math.round(base * factor),
    low: Math.round(low * factor),
    high: Math.round(high * factor),
    confidence: Math.round(confidence * 100) / 100,
    estimators,
    adsMultiplierApplied,
  };
}

export interface RevenueForCompanyDeps {
  companiesGet: typeof companiesGetReal;
  factsList: typeof factsListReal;
}

export const defaultRevenueForCompanyDeps: RevenueForCompanyDeps = {
  companiesGet: companiesGetReal,
  factsList: factsListReal,
};

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** Live wrapper: pulls the company row + its current facts off the OS and resolves them into
 *  RevenueInputs, then delegates to the pure estimateRevenue. Kept deliberately thin — every actual
 *  estimation rule lives in the pure function above so it's the thing tests exercise directly. */
export async function estimateRevenueForCompany(companyId: string, deps: RevenueForCompanyDeps = defaultRevenueForCompanyDeps): Promise<RevenueEstimate> {
  const [company, facts] = await Promise.all([
    deps.companiesGet(companyId),
    deps.factsList({ subject_type: "company", subject_id: companyId }),
  ]);

  const yearFoundedFact = facts.find((f) => f.field_name === "year_founded");
  const yearFounded = yearFoundedFact ? num(yearFoundedFact.value) : undefined;
  const yearsActive = yearFounded !== undefined ? Math.max(0, new Date().getFullYear() - yearFounded) : undefined;

  const permitFacts = facts.filter((f) => f.field_name === "permit_value");
  const permitValueSum = permitFacts.length ? permitFacts.reduce((sum, f) => sum + (num(f.value) ?? 0), 0) : undefined;

  const locationsFact = facts.find((f) => f.field_name === "locations_count");
  const locationsCount = locationsFact ? num(locationsFact.value) : undefined;

  const adsActive = facts.some((f) => f.field_name === "detected_tech_ads" || f.field_name === "ads_active");

  const inputs: RevenueInputs = {
    employees: undefined, // see module doc — no fact source yet
    reviewCount: num(company.review_count),
    yearsActive,
    permitValueSum,
    locationsCount,
    yearsInBusiness: yearsActive,
    adsActive,
  };

  return estimateRevenue(inputs);
}
