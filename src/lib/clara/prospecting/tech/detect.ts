// tech/detect.ts — stage 50's `tech_detect` handler collaborator: scans a company's crawled
// homepage HTML against ./signatures.ts, infers mail-provider/SPF facts from DNS, and writes both
// a `company_technologies_upsert` row and a matching `facts_add` row per detected technology.
//
// FIELD_NAME_BY_CATEGORY below is the convention this module uses to decide each tech fact's
// `field_name`: wherever a detected category maps onto one of the OS's known signal-emitting fields
// (crm, website_platform, chat, booking, ai_receptionist, phone_system, call_tracking, payments,
// email_platform — PR 8's brief), we use that exact field name so facts_add's server-side
// factChangeSignal logic auto-emits the right tech_added/tech_removed signal. Everything else
// (analytics, ads, other) still gets a fact for audit/history — field_name "detected_tech_<category>"
// — even though no signal fires for it; that's expected, not a bug.
//
// HTTP-header detection: crawler/httpFetch.ts (PR 7) does not currently capture response headers —
// only `html`/status — so there is nothing to scan yet. source_type "http_header" stays a valid,
// real enum value this module could emit (DetectedTechFact's type admits it), but no signature here
// actually produces one; wiring real header capture through httpFetch->waterfall->evidence is left
// to a later PR rather than over-scoping this one.

import { promises as fsReal } from "node:fs";
import type { DiscoveredCandidate } from "../types";
import { normalizeDomain } from "../entity/normalize";
import type { EvidenceRef } from "../crawler/evidence";
import {
  companyTechnologiesUpsert as companyTechnologiesUpsertReal,
  factsAdd as factsAddReal,
  type CompanyTechnologyInput,
  type FactInput,
  type TechCategory,
} from "../osBridge";
import { SIGNATURES, type TechSignature } from "./signatures";
import { dnsResolveMx as dnsResolveMxReal, dnsResolveTxt as dnsResolveTxtReal, type DnsMxResult, type DnsTxtResult } from "./dns";

/** The OS's known signal-emitting field names (PR 8's brief) that a detected tech CATEGORY can map
 *  onto. Categories not listed here still get a fact written (field_name "detected_tech_<category>")
 *  for audit/history — they just don't trigger an automatic company_signals row. */
const FIELD_NAME_BY_CATEGORY: Partial<Record<TechCategory, string>> = {
  crm: "crm",
  website_builder: "website_platform",
  chat: "chat",
  booking: "booking",
  ai_receptionist: "ai_receptionist",
  payments: "payments",
  email_platform: "email_platform",
  financing: "financing",
};
/** CallRail (category "phone") is specifically call-tracking, not a phone *system* — it maps to the
 *  OS's "call_tracking" signal field, not "phone_system" (which this module never detects a
 *  signature for). Keyed by technology name rather than category since "phone" alone is ambiguous. */
const FIELD_NAME_BY_TECH_NAME: Record<string, string> = { CallRail: "call_tracking" };

function fieldNameFor(sigMatch: TechSignature): string {
  return FIELD_NAME_BY_TECH_NAME[sigMatch.name] ?? FIELD_NAME_BY_CATEGORY[sigMatch.category] ?? `detected_tech_${sigMatch.category}`;
}

const MX_PROVIDER_PATTERNS: ReadonlyArray<{ provider: string; patterns: readonly string[] }> = [
  { provider: "Google Workspace", patterns: [".google.com", ".googlemail.com"] },
  { provider: "Microsoft 365", patterns: [".mail.protection.outlook.com"] },
  { provider: "GoDaddy", patterns: [".secureserver.net"] },
];

const SPF_INCLUDE_PATTERNS: ReadonlyArray<{ provider: string; patterns: readonly string[] }> = [
  { provider: "mailchimp", patterns: ["servers.mcsv.net", "mailchimp.com"] },
  { provider: "hubspot", patterns: ["_spf.hubspot.com", "hubspot.com"] },
  { provider: "sendgrid", patterns: ["sendgrid.net"] },
  { provider: "constantcontact", patterns: ["constantcontact.com"] },
];

/** Pulls every `<script src="...">` value off raw HTML — the "scripts" list signatures.ts's
 *  `TechSignature.match` checks alongside the full HTML string. Inline `<script>...</script>` bodies
 *  (no `src`) are intentionally not included here — every signature in this table matches against a
 *  known embed/CDN domain or a plain-text brand mention, both of which the full `html` string already
 *  covers (inline script bodies are part of `html` too, since this runs on raw markup, not a
 *  script-stripped copy). */
export function extractScriptSrcs(html: string): string[] {
  const out: string[] = [];
  const re = /<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) out.push(m[1]);
  return out;
}

/** Runs every signature in SIGNATURES against one page's HTML. Pure. */
export function matchSignatures(html: string, signatures: readonly TechSignature[] = SIGNATURES): TechSignature[] {
  const scripts = extractScriptSrcs(html);
  return signatures.filter((s) => s.match(html, scripts));
}

function normalizeHostList(raw: string[]): string {
  return raw.map((h) => h.toLowerCase().trim()).filter((h, i, arr) => arr.indexOf(h) === i).sort().join(",");
}

function containsAnyHost(haystack: string, patterns: readonly string[]): boolean {
  const h = haystack.toLowerCase();
  return patterns.some((p) => h.includes(p.toLowerCase()));
}

/** Which mail provider (if any) a set of MX exchange hostnames implies. undefined = not one of the
 *  providers this module recognizes (a legitimate, common outcome — most self-hosted/niche mail
 *  providers just aren't in this list). */
export function inferMxProvider(exchanges: string[]): string | undefined {
  for (const { provider, patterns } of MX_PROVIDER_PATTERNS) {
    if (exchanges.some((ex) => containsAnyHost(ex, patterns))) return provider;
  }
  return undefined;
}

/** Parses the `v=spf1 ...` TXT record (if any) out of a domain's TXT records and returns the
 *  recognized `include:`-mechanism providers it names, sorted. Empty when there's no SPF record or
 *  none of its includes match a known provider — both legitimate, common outcomes. */
export function parseSpfIncludes(txtRecords: string[][]): string[] {
  const spf = txtRecords.map((parts) => parts.join("")).find((r) => r.trim().toLowerCase().startsWith("v=spf1"));
  if (!spf) return [];
  const found = new Set<string>();
  for (const { provider, patterns } of SPF_INCLUDE_PATTERNS) {
    if (containsAnyHost(spf, patterns)) found.add(provider);
  }
  return [...found].sort();
}

/** The quote-grounding check tech_detect shares the same spirit of as extractFacts.ts, but for
 *  DNS-derived facts there's no "quote" — these two helpers above (inferMxProvider/parseSpfIncludes)
 *  ARE the grounding: a provider is only reported when its exact known hostname/include pattern is
 *  present in the real DNS answer. */

export interface DetectTechInput {
  companyId: string;
  candidate: DiscoveredCandidate;
  /** PR 7's crawl handler fan-out — the evidence refs for this company's crawled pages. */
  evidence: EvidenceRef[];
  researchJobId?: string;
  jobId?: string;
  allowLive: boolean;
}

export interface DetectedTech {
  category: TechCategory;
  name: string;
  fieldName: string;
  detectedVia: "script" | "html" | "dns";
  evidenceUrl?: string;
  bestEffort?: boolean;
}

export interface DetectTechResult {
  companyId: string;
  detected: DetectedTech[];
  techUpsertCalled: boolean;
  factsWritten: number;
  mxProvider?: string;
  spfIncludes: string[];
  notes: string[];
}

export interface DetectTechDeps {
  readFile: (path: string) => Promise<string>;
  resolveMx: (domain: string, opts: { jobId?: string; allowLive: boolean }) => Promise<DnsMxResult>;
  resolveTxt: (domain: string, opts: { jobId?: string; allowLive: boolean }) => Promise<DnsTxtResult>;
  companyTechnologiesUpsert: typeof companyTechnologiesUpsertReal;
  factsAdd: typeof factsAddReal;
}

export const defaultDetectTechDeps: DetectTechDeps = {
  readFile: (p) => fsReal.readFile(p, "utf8"),
  resolveMx: dnsResolveMxReal,
  resolveTxt: dnsResolveTxtReal,
  companyTechnologiesUpsert: companyTechnologiesUpsertReal,
  factsAdd: factsAddReal,
};

const HTML_SIGNATURE_CONFIDENCE = 0.85;
const HTML_SIGNATURE_CONFIDENCE_BEST_EFFORT = 0.5;
const DNS_FACT_CONFIDENCE = 0.9;

/**
 * Stage 50's tech_detect collaborator. Scans the homepage's saved HTML evidence against
 * ./signatures.ts, resolves the candidate's domain MX/TXT records for mail-provider/SPF facts,
 * then writes ONE `company_technologies_upsert` call (`replace: true` — every category this run was
 * scanned, so any stale tech not redetected should close) and ONE `facts_add` batch call for the
 * company (mirroring extractFacts.ts's single-batch-per-company convention).
 */
export async function detectTech(input: DetectTechInput, deps: DetectTechDeps = defaultDetectTechDeps): Promise<DetectTechResult> {
  const notes: string[] = [];
  const domain = normalizeDomain(input.candidate.website_url);

  // ── HTML/script signatures off the homepage evidence ──────────────────────────────────────
  const homepage = input.evidence.find((e) => e.sourceType === "homepage" && e.htmlPath) ?? input.evidence.find((e) => e.htmlPath);
  let matched: TechSignature[] = [];
  let homepageUrl: string | undefined;
  if (homepage?.htmlPath) {
    homepageUrl = homepage.url;
    try {
      const html = await deps.readFile(homepage.htmlPath);
      matched = matchSignatures(html);
    } catch (e) {
      notes.push(`could not read homepage evidence html: ${e instanceof Error ? e.message : String(e)}`);
    }
  } else {
    notes.push("no evidence carried raw HTML (jina-only crawl) — html/script signature scan skipped");
  }

  const detected: DetectedTech[] = matched.map((s) => ({
    category: s.category,
    name: s.name,
    fieldName: fieldNameFor(s),
    detectedVia: s.detectedVia === "script" ? "script" : "html",
    evidenceUrl: homepageUrl,
    bestEffort: s.bestEffort,
  }));

  // ── DNS: mx_provider + spf_includes ────────────────────────────────────────────────────────
  let mxProvider: string | undefined;
  let spfIncludes: string[] = [];
  if (domain) {
    const [mx, txt] = await Promise.all([
      deps.resolveMx(domain, { jobId: input.jobId, allowLive: input.allowLive }),
      deps.resolveTxt(domain, { jobId: input.jobId, allowLive: input.allowLive }),
    ]);
    if (mx.ok) {
      mxProvider = inferMxProvider((mx.records ?? []).map((r) => r.exchange));
    } else if (mx.error) {
      notes.push(`mx lookup failed: ${mx.error}`);
    }
    if (txt.ok) {
      spfIncludes = parseSpfIncludes(txt.records ?? []);
    } else if (txt.error) {
      notes.push(`txt lookup failed: ${txt.error}`);
    }
  } else {
    notes.push("no usable domain — dns-based detection skipped");
  }

  // ── company_technologies_upsert (one batch call) ───────────────────────────────────────────
  let techUpsertCalled = false;
  if (detected.length) {
    const technologies: CompanyTechnologyInput[] = detected.map((d) => ({
      category: d.category,
      name: d.name,
      detected_via: d.detectedVia,
      evidence_url: d.evidenceUrl,
      confidence: d.bestEffort ? HTML_SIGNATURE_CONFIDENCE_BEST_EFFORT : HTML_SIGNATURE_CONFIDENCE,
    }));
    await deps.companyTechnologiesUpsert({ company_id: input.companyId, technologies, replace: true });
    techUpsertCalled = true;
  }

  // ── facts_add (one batch call) ─────────────────────────────────────────────────────────────
  const facts: FactInput[] = detected.map((d) => ({
    subject_type: "company",
    subject_id: input.companyId,
    field_name: d.fieldName,
    value: d.name,
    source_type: d.detectedVia === "script" ? "website_script" : "website_page",
    source_url: d.evidenceUrl,
    confidence: d.bestEffort ? HTML_SIGNATURE_CONFIDENCE_BEST_EFFORT : HTML_SIGNATURE_CONFIDENCE,
    grounded: true,
    evidence: { detectedVia: d.detectedVia, bestEffort: Boolean(d.bestEffort) },
  }));
  if (mxProvider) {
    facts.push({
      subject_type: "company",
      subject_id: input.companyId,
      field_name: "mx_provider",
      value: mxProvider,
      normalized_value: mxProvider.toLowerCase(),
      source_type: "dns",
      confidence: DNS_FACT_CONFIDENCE,
      grounded: true,
      evidence: { domain },
    });
  }
  if (spfIncludes.length) {
    facts.push({
      subject_type: "company",
      subject_id: input.companyId,
      field_name: "spf_includes",
      // spf_includes is NOT one of the OS's multi-valued fields, so this is ONE fact whose value is
      // the whole array (not one fact per provider, which would just supersede itself repeatedly).
      value: spfIncludes,
      normalized_value: normalizeHostList(spfIncludes),
      source_type: "dns",
      confidence: DNS_FACT_CONFIDENCE,
      grounded: true,
      evidence: { domain },
    });
  }

  let factsWritten = 0;
  if (facts.length) {
    const res = await deps.factsAdd({ research_task_id: undefined, facts });
    factsWritten = res.inserted?.length ?? facts.length;
  }

  return { companyId: input.companyId, detected, techUpsertCalled, factsWritten, mxProvider, spfIncludes, notes };
}
