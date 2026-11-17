// extract/classifyIndustry.ts — tier-1 LLM industry classifier.
//
// Richer than stage 30's original inline classifier (a bare `{probability}`): asks for
// is_roofing/probability/residential_commercial in one JSON shape (the `is_roofing` key name is
// fixed regardless of the job's actual vertical — see buildClassifyPrompt's doc comment), and — now
// that PR 7 adds a real crawler — can optionally be handed a snippet of the crawled homepage text
// for a better read than candidate metadata alone.
//
// Stage 30 itself still runs BEFORE any crawl (crawl is stage 40, downstream of classify per
// STAGE_ORDER in stages.ts), so `crawledText` is undefined on that call; this module is reusable
// as-is by a later PR that wants a post-crawl re-classify with real page text.

import type { DiscoveredCandidate } from "../types";
import { runTier as runTierReal, type RunTierResult } from "../llm";

export type ResidentialCommercial = "residential" | "commercial" | "both" | "unknown";

const VALID_RESIDENTIAL_COMMERCIAL: ReadonlySet<string> = new Set(["residential", "commercial", "both", "unknown"]);

/** Inclusive — a probability of exactly 0.7 counts as in-industry. */
export const PROBABILITY_THRESHOLD = 0.7;

/** Keep the crawled-text snippet handed to the classifier small — this is a tier-1 (cheap/local)
 *  call, not a full-page summarizer. */
const CRAWLED_TEXT_SNIPPET_CHARS = 1500;

export interface ClassifyIndustryResult {
  /** probability >= PROBABILITY_THRESHOLD */
  inIndustry: boolean;
  probability: number;
  residentialCommercial: ResidentialCommercial;
  engine: string;
  /** The tier-1 call's raw text, for debugging a bad classification. */
  raw?: string;
  /** Set when the LLM's output couldn't be parsed/trusted as-is and a fallback was used. */
  parseError?: string;
  /** No model answered at all — the classification is a guess and must not drop the company. */
  callFailed?: boolean;
}

/** Strict-JSON prompt. The reply's "is_roofing" key literally means "is this business in the job's
 *  target industry" — the key name is fixed across every vertical this engine runs (a holdover from
 *  the roofing-vertical origin of this prospecting engine), while the prompt text itself names the
 *  real industry from the job spec. */
export function buildClassifyPrompt(candidate: DiscoveredCandidate, industry: string[], crawledText?: string): string {
  const industryLabel = industry.length ? industry.join(" / ") : "the target industry";
  const snippet = crawledText?.trim() ? crawledText.trim().slice(0, CRAWLED_TEXT_SNIPPET_CHARS) : undefined;
  return [
    `Classify this business against the "${industryLabel}" industry. Reply with ONLY strict JSON, no other text:`,
    `{"is_roofing": boolean, "probability": number between 0 and 1, "residential_commercial": "residential"|"commercial"|"both"|"unknown"}`,
    ``,
    `"is_roofing" means "is this business in the '${industryLabel}' industry" — the key name is fixed, it is not literally about roofing unless that is the target industry above.`,
    `"residential_commercial" is which customers the business primarily serves, based on the evidence given; reply "unknown" if the evidence doesn't say.`,
    ``,
    `Name: ${candidate.name}`,
    `Category hint: ${candidate.category_hint ?? "none"}`,
    `Website: ${candidate.website_url ?? "none"}`,
    snippet ? `Homepage text (excerpt):\n${snippet}` : `Homepage text: not crawled yet`,
  ].join("\n");
}

function clampProbability(v: unknown): number | undefined {
  const n = Number(v);
  if (!Number.isFinite(n)) return undefined;
  return Math.max(0, Math.min(1, n));
}

function parseResidentialCommercial(v: unknown): ResidentialCommercial {
  return typeof v === "string" && VALID_RESIDENTIAL_COMMERCIAL.has(v) ? (v as ResidentialCommercial) : "unknown";
}

export interface ClassifyIndustryDeps {
  runTier: typeof runTierReal;
}

export const defaultClassifyIndustryDeps: ClassifyIndustryDeps = { runTier: runTierReal };

/**
 * Tier-1 industry classification. Defensive JSON parsing: a malformed/empty reply, a missing or
 * non-numeric `probability`, or a failed tier-1 call all fall back to probability 0.5
 * ("undetermined" — matching stage 30's original inline classifier's own fallback) rather than
 * throwing. `residentialCommercial` defaults to "unknown" on anything that isn't one of the 4 valid
 * values (missing, garbage, wrong type). The ≥0.7 threshold is inclusive.
 */
export async function classifyIndustry(
  candidate: DiscoveredCandidate,
  industry: string[],
  crawledText?: string,
  deps: ClassifyIndustryDeps = defaultClassifyIndustryDeps,
): Promise<ClassifyIndustryResult> {
  const r: RunTierResult = await deps.runTier(1, buildClassifyPrompt(candidate, industry, crawledText), {
    purpose: "prospect:classify_industry",
    json: true,
    maxTokens: 150,
  });

  let probability = 0.5;
  let residentialCommercial: ResidentialCommercial = "unknown";
  let parseError: string | undefined;

  if (r.ok && r.text) {
    try {
      const parsed = JSON.parse(r.text) as {
        is_roofing?: unknown;
        probability?: unknown;
        residential_commercial?: unknown;
      };
      const p = clampProbability(parsed.probability);
      if (p !== undefined) {
        probability = p;
      } else {
        parseError = "probability missing or non-numeric";
      }
      residentialCommercial = parseResidentialCommercial(parsed.residential_commercial);
    } catch (e) {
      parseError = e instanceof Error ? e.message : String(e);
    }
  } else {
    parseError = r.error ?? "tier-1 call failed";
  }

  return {
    callFailed: !r.ok,
    inIndustry: probability >= PROBABILITY_THRESHOLD,
    probability,
    residentialCommercial,
    engine: r.engine,
    raw: r.text,
    parseError,
  };
}
