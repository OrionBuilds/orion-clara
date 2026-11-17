// extract/qualify.ts — stage 70's `qualify` collaborator: a tier-2 LLM verdict on whether a company
// is a real sales-worthy prospect, escalated to tier-3 only for the ambiguous cases (see
// decideEscalation below), with tier-3's verdict OVERRIDING tier-2's when it runs — the more
// expensive, more trustworthy adjudicator wins the ambiguous middle, never averages with tier-2.

import { runTier as runTierReal, type RunTierResult } from "../llm";
import type { FitScoreBreakdownEntry } from "../intel/fitScore";
import type { RevenueEstimate } from "../intel/revenue";
import { BUSINESS_NAME, BUSINESS_PITCH } from "../branding";

/** fit scores in this band (inclusive both ends) are ambiguous enough to escalate regardless of
 *  extraction confidence — neither clearly "yes" nor clearly "no" under the active fit_score_config. */
export const ESCALATION_FIT_BAND: readonly [number, number] = [55, 65];
/** Below this aggregate extraction confidence, escalate regardless of fit score — the facts tier-2
 *  qualify would reason over are themselves too shaky to trust a tier-2-only verdict. */
export const ESCALATION_CONFIDENCE_FLOOR = 0.6;

export interface QualifyFactLike {
  field_name: string;
  value: unknown;
  confidence?: number;
}

/** Mean of every fact's `confidence` that carries one; facts with no confidence field don't count
 *  against or for the average. No qualifying facts at all → 1 (nothing to be unsure about) —
 *  documented default, not a claim of actual confidence; see qualify.test.ts for the behavior this
 *  produces (an empty facts list never escalates on confidence alone). */
export function computeAggregateConfidence(facts: QualifyFactLike[]): number {
  const withConfidence = facts.filter((f) => typeof f.confidence === "number" && Number.isFinite(f.confidence));
  if (!withConfidence.length) return 1;
  return withConfidence.reduce((sum, f) => sum + (f.confidence as number), 0) / withConfidence.length;
}

/** Pure: whether the ambiguous-middle tier-3 adjudicator should run. */
export function decideEscalation(fitScore: number, aggregateConfidence: number): boolean {
  const [lo, hi] = ESCALATION_FIT_BAND;
  const inBand = fitScore >= lo && fitScore <= hi;
  return inBand || aggregateConfidence < ESCALATION_CONFIDENCE_FLOOR;
}

export interface QualifyVerdict {
  qualified: boolean;
  reasons: string[];
}

/** Parses a tier verdict's JSON text into `{qualified, reasons}`. Returns null (never throws) on any
 *  parse/shape failure — callers degrade to a documented default rather than crashing stage 70. */
export function parseQualifyVerdict(text: string): QualifyVerdict | null {
  try {
    const parsed = JSON.parse(text) as { qualified?: unknown; reasons?: unknown };
    if (typeof parsed.qualified !== "boolean") return null;
    const reasons = Array.isArray(parsed.reasons) ? parsed.reasons.filter((r): r is string => typeof r === "string") : [];
    return { qualified: parsed.qualified, reasons };
  } catch {
    return null;
  }
}

export interface QualifyPromptInput {
  companyName: string;
  industry?: string[];
  fitScore: number;
  fitBreakdown: FitScoreBreakdownEntry[];
  revenue: RevenueEstimate;
  facts: QualifyFactLike[];
}

/** Builds the qualify prompt for either tier — pure, shared by both the tier-2 and (on escalation)
 *  tier-3 calls so the adjudicator sees exactly the same evidence tier-2 did. */
export function buildQualifyPrompt(input: QualifyPromptInput): string {
  const factLines = input.facts
    .slice(0, 40)
    .map((f) => `- ${f.field_name}: ${JSON.stringify(f.value)}${typeof f.confidence === "number" ? ` (confidence ${f.confidence})` : ""}`)
    .join("\n");
  const breakdownLines = input.fitBreakdown.map((b) => `- ${b.label} (${b.key}): ${b.points > 0 ? "+" : ""}${b.points}`).join("\n");
  return [
    `Decide whether "${input.companyName}"${input.industry?.length ? ` (${input.industry.join("/")})` : ""} is a real, sales-worthy prospect for ${BUSINESS_NAME} outreach (${BUSINESS_PITCH}).`,
    `Reply with ONLY strict JSON: {"qualified": true|false, "reasons": ["short reason", ...]}.`,
    ``,
    `Fit score: ${input.fitScore}/100`,
    breakdownLines ? `Fit score breakdown:\n${breakdownLines}` : `Fit score breakdown: (no rules fired)`,
    ``,
    input.revenue.revenue !== null ? `Estimated revenue: $${input.revenue.revenue.toLocaleString()} (confidence ${input.revenue.confidence ?? "n/a"})` : `Estimated revenue: unknown`,
    ``,
    factLines ? `Known facts:\n${factLines}` : `Known facts: none`,
    ``,
    `Rules: qualify only companies that look like a real, currently-operating business with plausible fit for ${BUSINESS_NAME} outreach (${BUSINESS_PITCH}). Reasons must be short (a few words each) and grounded in the fit score / facts above — do not invent facts not listed.`,
  ].join("\n");
}

export interface QualifyInput {
  companyId: string;
  companyName: string;
  industry?: string[];
  fitScore: number;
  fitBreakdown: FitScoreBreakdownEntry[];
  revenue: RevenueEstimate;
  facts: QualifyFactLike[];
}

export interface QualifyDeps {
  runTier: typeof runTierReal;
}

export const defaultQualifyDeps: QualifyDeps = { runTier: runTierReal };

export interface QualifyResult {
  companyId: string;
  qualified: boolean;
  reasons: string[];
  /** Which tier actually produced the final verdict — 3 only when escalation ran AND tier-3's call
   *  itself parsed successfully (a failed tier-3 call falls back to tier-2's verdict, still tagged
   *  "escalated" for observability, but `tier` reports 2 since that's whose verdict actually won). */
  tier: 2 | 3;
  escalated: boolean;
  aggregateConfidence: number;
  tier2Engine?: string;
  tier3Engine?: string;
  parseError?: string;
}

/**
 * Stage 70's qualify collaborator. Always runs tier 2 first; escalates to tier 3 only inside the
 * ambiguous fit-score band or under the extraction-confidence floor (decideEscalation). Tier 3's
 * verdict — when it runs and parses — overrides tier 2's outright; it never blends with or defers to
 * tier 2. A tier-2 JSON parse failure degrades to `{qualified: false, reasons: [...]}` rather than
 * throwing, so a bad model response can't crash the qualify stage — see qualify.test.ts.
 */
export async function qualifyCompany(input: QualifyInput, deps: QualifyDeps = defaultQualifyDeps): Promise<QualifyResult> {
  const aggregateConfidence = computeAggregateConfidence(input.facts);
  const prompt = buildQualifyPrompt(input);

  const tier2: RunTierResult = await deps.runTier(2, prompt, { purpose: "prospect:qualify", json: true, maxTokens: 400 });
  const tier2Verdict = tier2.ok && tier2.text ? parseQualifyVerdict(tier2.text) : null;
  const tier2ParseError = tier2.ok && tier2.text && !tier2Verdict ? "tier-2 response did not parse as {qualified, reasons}" : tier2.error;

  let qualified = tier2Verdict?.qualified ?? false;
  let reasons = tier2Verdict?.reasons ?? (tier2ParseError ? [tier2ParseError] : ["tier-2 produced no verdict"]);
  let tier: 2 | 3 = 2;
  let tier3Engine: string | undefined;

  const escalated = decideEscalation(input.fitScore, aggregateConfidence);
  if (escalated) {
    const tier3: RunTierResult = await deps.runTier(3, prompt, { purpose: "prospect:qualify", json: true, maxTokens: 400 });
    tier3Engine = tier3.engine;
    const tier3Verdict = tier3.ok && tier3.text ? parseQualifyVerdict(tier3.text) : null;
    if (tier3Verdict) {
      qualified = tier3Verdict.qualified;
      reasons = tier3Verdict.reasons;
      tier = 3;
    }
    // tier-3 call failed or didn't parse: tier-2's verdict (or its degraded default) stands, tier stays 2.
  }

  return {
    companyId: input.companyId,
    qualified,
    reasons,
    tier,
    escalated,
    aggregateConfidence,
    tier2Engine: tier2.engine,
    tier3Engine,
    parseError: tier2ParseError,
  };
}
