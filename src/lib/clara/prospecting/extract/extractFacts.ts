// extract/extractFacts.ts — stage 50's `extract` handler collaborator: tier-2 LLM extraction of
// structured facts (services/certifications/financing/owner/year_founded/service_areas, per the
// blueprint's §9 schema) off a company's crawled page text, with every fact's `quote` checked
// against the real source page text before it's trusted (checkGrounded) — an ungrounded quote still
// gets written (facts_add accepts `grounded:false`), just at half confidence, rather than dropped.
//
// Field-name convention: the LLM is asked to use the schema's field names directly as `facts_add`'s
// `field_name` ("services"/"certifications"/"service_areas"/"financing"/"owner"/"year_founded") —
// these are exactly the OS's real field names (no translation layer needed), and three of them
// ("services", "certifications", "service_areas") are the OS's multi-valued fields: one facts_add
// entry per distinct value. The other three ("financing", "owner", "year_founded") are
// single-valued: one entry total, last-value-wins is the server's job (facts_add's own supersede
// logic), not this module's.

import { promises as fsReal } from "node:fs";
import type { DiscoveredCandidate } from "../types";
import type { EvidenceRef } from "../crawler/evidence";
import { runTier as runTierReal, type RunTierResult } from "../llm";
import { factsAdd as factsAddReal, type FactInput, type FactsAddResult } from "../osBridge";

/** The blueprint §9 schema's field names — also the literal facts_add `field_name` values the LLM
 *  is instructed to use (see module doc comment). */
export const EXTRACT_FIELDS = ["services", "certifications", "financing", "owner", "year_founded", "service_areas"] as const;
export type ExtractField = (typeof EXTRACT_FIELDS)[number];
const EXTRACT_FIELD_SET: ReadonlySet<string> = new Set(EXTRACT_FIELDS);

/** The OS's multi-valued fields, restricted to the subset this schema ever touches (the full server
 *  list is bigger — locations/social_profiles/job_postings/people/awards/brands/licenses — but this
 *  module never emits those field names). */
export const MULTI_VALUED_EXTRACT_FIELDS: ReadonlySet<ExtractField> = new Set(["services", "certifications", "service_areas"]);

/** Ungrounded facts are still written (facts_add accepts grounded:false), just discounted. */
export const UNGROUNDED_CONFIDENCE_MULTIPLIER = 0.5;
const BASE_CONFIDENCE = 0.8;

/** Keep each page's text capped — this is a tier-2 bulk-extraction call (local/cheap by default),
 *  not a full-document summarizer; six pages at this cap stays comfortably inside a local model's
 *  context window. */
const PAGE_TEXT_SNIPPET_CHARS = 3000;

export interface PageText {
  url: string;
  text: string;
}

export interface RawExtractedFact {
  field?: unknown;
  value?: unknown;
  quote?: unknown;
  url?: unknown;
}

/** Builds the tier-2 extraction prompt over one or more crawled pages' text, each labeled by URL so
 *  the model can report which page a quote/value came from. Pure. */
export function buildExtractPrompt(pages: PageText[]): string {
  const body = pages
    .map((p) => `URL: ${p.url}\n${p.text.trim().slice(0, PAGE_TEXT_SNIPPET_CHARS)}`)
    .join("\n\n---\n\n");
  return [
    `Extract facts about this business from the page text below. Reply with ONLY strict JSON, no other text, shaped exactly like:`,
    `{"facts": [{"field": "owner", "value": "Jane Smith", "quote": "owned and operated by Jane Smith since 2004", "url": "https://..."}]}`,
    ``,
    `Rules:`,
    `- "field" must be one of: ${EXTRACT_FIELDS.join(", ")}.`,
    `- "services", "certifications" and "service_areas" are lists — emit ONE fact object per distinct value, not an array in "value".`,
    `- "owner", "year_founded" and "financing" are single-valued — emit at most one fact object per field. "financing" is the name of a financing/payment-plan provider the business offers (e.g. "GreenSky"), if any is mentioned.`,
    `- "quote" MUST be an exact, verbatim substring copied from the page text below that supports "value" — do not paraphrase or summarize it.`,
    `- "url" must be the exact URL (from the "URL:" line) the quote came from.`,
    `- Only emit a fact when the page text actually supports it. If nothing qualifies, reply {"facts": []}.`,
    ``,
    body,
  ].join("\n");
}

/** True when `quote` is a real (whitespace/case-normalized) substring of `pageText` — never a
 *  fuzzy/semantic match. Pure, unit-testable in isolation. */
export function checkGrounded(quote: string, pageText: string): boolean {
  const normalize = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  const q = normalize(quote);
  if (!q) return false;
  return normalize(pageText).includes(q);
}

export interface ExtractFactsInput {
  companyId: string;
  candidate: DiscoveredCandidate;
  /** PR 7's crawl handler fan-out — the evidence refs for this company's crawled pages. */
  evidence: EvidenceRef[];
  researchJobId?: string;
}

export interface ExtractFactsDeps {
  runTier: typeof runTierReal;
  readFile: (path: string) => Promise<string>;
  factsAdd: typeof factsAddReal;
}

export const defaultExtractFactsDeps: ExtractFactsDeps = {
  runTier: runTierReal,
  readFile: (p) => fsReal.readFile(p, "utf8"),
  factsAdd: factsAddReal,
};

export interface ExtractFactsResult {
  companyId: string;
  factsBuilt: number;
  factsWritten: number;
  groundedCount: number;
  ungroundedCount: number;
  engine?: string;
  model?: string;
  parseError?: string;
  notes: string[];
}

/** Loads each evidence ref's saved `.txt` off disk into `{url, text}` pairs, skipping any that fail
 *  to read (a missing/corrupt file for one page shouldn't fail extraction for the whole company). */
async function loadPageTexts(evidence: EvidenceRef[], deps: ExtractFactsDeps, notes: string[]): Promise<PageText[]> {
  const pages: PageText[] = [];
  for (const e of evidence) {
    try {
      const text = await deps.readFile(e.txtPath);
      if (text.trim()) pages.push({ url: e.url, text });
    } catch (err) {
      notes.push(`could not read evidence text for ${e.url}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return pages;
}

function isValidField(v: unknown): v is ExtractField {
  return typeof v === "string" && EXTRACT_FIELD_SET.has(v);
}

/**
 * Tier-2 fact extraction for one company. Reads the company's crawled page text off disk (from
 * `input.evidence`'s saved `.txt` files), asks the LLM for grounded facts against the §9 schema,
 * checks each fact's quote against its claimed source page, and writes everything in ONE batch
 * `facts_add` call (never one call per fact — see osBridge.ts's facts_add doc / PR 8's brief).
 */
export async function extractFacts(input: ExtractFactsInput, deps: ExtractFactsDeps = defaultExtractFactsDeps): Promise<ExtractFactsResult> {
  const notes: string[] = [];
  const pages = await loadPageTexts(input.evidence, deps, notes);
  if (!pages.length) {
    return { companyId: input.companyId, factsBuilt: 0, factsWritten: 0, groundedCount: 0, ungroundedCount: 0, notes: [...notes, "no crawled page text available — nothing to extract"] };
  }

  const r: RunTierResult = await deps.runTier(2, buildExtractPrompt(pages), {
    purpose: "prospect:extract_facts",
    json: true,
    maxTokens: 800,
  });

  if (!r.ok || !r.text) {
    return {
      companyId: input.companyId, factsBuilt: 0, factsWritten: 0, groundedCount: 0, ungroundedCount: 0,
      engine: r.engine, model: r.model, parseError: r.error ?? "tier-2 call failed", notes,
    };
  }

  let raw: RawExtractedFact[] = [];
  let parseError: string | undefined;
  try {
    const parsed = JSON.parse(r.text) as { facts?: unknown };
    raw = Array.isArray(parsed.facts) ? (parsed.facts as RawExtractedFact[]) : [];
  } catch (e) {
    parseError = e instanceof Error ? e.message : String(e);
  }

  const pageByUrl = new Map(pages.map((p) => [p.url, p.text]));
  const facts: FactInput[] = [];
  let groundedCount = 0;
  let ungroundedCount = 0;

  for (const f of raw) {
    if (!isValidField(f.field)) continue;
    if (f.value === undefined || f.value === null || f.value === "") continue;
    const quote = typeof f.quote === "string" ? f.quote : "";
    const url = typeof f.url === "string" ? f.url : undefined;
    const pageText = url ? pageByUrl.get(url) : undefined;
    const grounded = Boolean(quote && pageText && checkGrounded(quote, pageText));
    if (grounded) groundedCount++;
    else ungroundedCount++;

    const value = f.field === "year_founded" ? Number(f.value) : f.value;
    if (f.field === "year_founded" && !Number.isFinite(value)) continue;

    facts.push({
      subject_type: "company",
      subject_id: input.companyId,
      field_name: f.field,
      value,
      source_type: "llm_extraction",
      source_url: url,
      confidence: grounded ? BASE_CONFIDENCE : BASE_CONFIDENCE * UNGROUNDED_CONFIDENCE_MULTIPLIER,
      grounded,
      evidence: { quote, evidence_ref: input.evidence.find((e) => e.url === url)?.sha },
      extraction_model: r.model ?? r.engine,
    });
  }

  let factsWritten = 0;
  if (facts.length) {
    const res: FactsAddResult = await deps.factsAdd({ research_task_id: undefined, facts });
    factsWritten = res.inserted?.length ?? facts.length;
  }

  return {
    companyId: input.companyId,
    factsBuilt: facts.length,
    factsWritten,
    groundedCount,
    ungroundedCount,
    engine: r.engine,
    model: r.model,
    parseError,
    notes,
  };
}
