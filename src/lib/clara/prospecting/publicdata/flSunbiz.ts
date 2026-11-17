// publicdata/flSunbiz.ts — Florida Division of Corporations (Sunbiz) business-entity search, via
// CLARA's existing crawler waterfall (crawler/waterfall.ts's crawlPage — http -> jina -> playwright),
// NOT a raw fetch. Cached 90 days (cache.ts's existing "sunbiz" CacheKind/TTL_DAYS entry — this module
// reuses ttlMs("sunbiz") rather than hardcoding 90 again).
//
// VERIFIED: search.sunbiz.org/Inquiry/CorporationSearch/ByName is Sunbiz's real "search by name" base
// path (confirmed via WebSearch — it's the canonical, widely-linked entry point for this search). A
// direct WebFetch probe of a constructed results URL in this environment returned HTTP 403 — Sunbiz's
// bot protection blocking a non-browser request — which is exactly why the plan routes this lookup
// through the waterfall's jina/playwright rungs rather than a bare fetch; a plain server-side fetch
// hitting the same wall is the expected, confirmed-real failure mode this module is built around.
// ASSUMED (not independently confirmed against a real rendered results page, for the same reason):
// the results query-string shape (SUNBIZ_SEARCH_BASE/buildSunbizSearchUrl below) and the detail-page
// label text this module's regex-based parser looks for ("Document Number", "Status", "Registered
// Agent Name & Address", "Date Filed", etc.) — these are Sunbiz's well-known, long-stable page labels
// per general public familiarity with the site, not freshly fetched in this environment. The parser
// is deliberately defensive text-scanning (matches htmlToText.ts's existing zero-new-deps style)
// specifically so label-wording drift degrades a field to "not found" rather than throwing.
//
// crawlPage only writes a readable evidence text file when given a `companyId` (crawler/waterfall.ts
// — finalize() skips writeEvidence without one), so lookupSunbiz requires one; stage 55's public_data
// handler always has a real companyId (it's a per-company task), so this is never a real limitation.

import { promises as fsReal } from "node:fs";
import { crawlPage as crawlPageReal } from "../crawler/waterfall";
import { cachedCall as cachedCallReal, cacheKey } from "../cache";
import type { SunbizRecord } from "./types";

export const SUNBIZ_SEARCH_BASE = "https://search.sunbiz.org/Inquiry/CorporationSearch/SearchResults";

export function buildSunbizSearchUrl(businessName: string): string {
  const term = businessName.trim();
  const params = new URLSearchParams({ inquiryType: "EntityName", searchNameOrder: term.toUpperCase(), searchTerm: term });
  return `${SUNBIZ_SEARCH_BASE}?${params.toString()}`;
}

function afterLabel(text: string, label: string): string | undefined {
  const re = new RegExp(`${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*[:\\n]?\\s*([^\\n]+)`, "i");
  const m = text.match(re);
  return m ? m[1].trim() : undefined;
}

const ACTIVE_STATUS_VALUES: ReadonlySet<string> = new Set(["active"]);

/**
 * Defensive, regex/text-scan parse of a Sunbiz entity detail (or single-hit search result) page's
 * flattened text into SunbizRecord[]. Handles a single-entity page (one record) and a multi-row
 * results listing (best-effort: splits on repeated "Document Number" occurrences). Pure — takes
 * already-fetched page text, never fetches itself.
 */
export function parseSunbizPageText(text: string, fallbackName: string): SunbizRecord[] {
  const t = text.replace(/ /g, " ");
  const blocks = t.split(/(?=Document Number)/i).filter((c) => /Document Number/i.test(c));
  const chunks = blocks.length ? blocks : [t];

  const out: SunbizRecord[] = [];
  for (const block of chunks) {
    const documentNumber = afterLabel(block, "Document Number");
    if (!documentNumber) continue;
    const status = afterLabel(block, "Status") ?? afterLabel(block, "Entity Status") ?? "";
    const entityName = afterLabel(block, "Entity Name") ?? afterLabel(block, "Corporation Name") ?? fallbackName;
    const registeredAgentName = afterLabel(block, "Registered Agent Name & Address") ?? afterLabel(block, "Registered Agent Name");
    const filingDate = afterLabel(block, "Date Filed");
    const entityType = afterLabel(block, "Entity Type") ?? afterLabel(block, "Document Type");
    const principalAddress = afterLabel(block, "Principal Address");

    out.push({
      entityName: entityName.trim(),
      documentNumber: documentNumber.trim(),
      status: status.trim(),
      statusActive: ACTIVE_STATUS_VALUES.has(status.trim().toLowerCase()),
      entityType: entityType?.trim(),
      filingDate: filingDate?.trim(),
      registeredAgentName: registeredAgentName?.trim(),
      principalAddress: principalAddress?.trim(),
      officers: [],
    });
  }
  return out;
}

export interface SunbizDeps {
  crawlPage: typeof crawlPageReal;
  cachedCall: typeof cachedCallReal;
  readFile: (path: string) => Promise<string>;
}

export const defaultSunbizDeps: SunbizDeps = {
  crawlPage: crawlPageReal,
  cachedCall: cachedCallReal,
  readFile: (p) => fsReal.readFile(p, "utf8"),
};

export interface LookupSunbizOpts {
  jobId?: string;
  allowLive: boolean;
}

/**
 * Looks up a business name on Sunbiz through the crawler waterfall, cached 90 days (cache.ts's
 * "sunbiz" CacheKind). A cache miss with `allowLive:false` (shadow mode) returns [] without ever
 * calling the waterfall, matching cachedCall's existing shadow-mode contract. Any crawl failure
 * (all-rungs-failed, robots-blocked, etc.) degrades to [] rather than throwing.
 */
export async function lookupSunbiz(businessName: string, companyId: string, opts: LookupSunbizOpts, deps: SunbizDeps = defaultSunbizDeps): Promise<SunbizRecord[]> {
  const name = businessName.trim();
  if (!name) return [];
  const url = buildSunbizSearchUrl(name);
  const key = cacheKey(["sunbiz", name.toLowerCase()]);

  const result = await deps.cachedCall<{ text?: string; error?: string }>({
    provider: "sunbiz",
    kind: "sunbiz",
    key,
    jobId: opts.jobId,
    costUsd: 0, // sunbiz itself is free; any real $ cost is the waterfall rung's own, recorded separately by crawlPage
    allowLive: opts.allowLive,
    fn: async () => {
      const page = await deps.crawlPage(url, { jobId: opts.jobId, companyId });
      if (!page.ok || !page.evidence) return { error: page.error ?? page.reason ?? "sunbiz crawl failed" };
      const text = await deps.readFile(page.evidence.txtPath).catch(() => undefined);
      return { text };
    },
  });

  if (!result.value?.text) return [];
  return parseSunbizPageText(result.value.text, name);
}
