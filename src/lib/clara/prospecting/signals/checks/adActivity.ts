// signals/checks/adActivity.ts — PR 18: is this company CURRENTLY running paid ads (not just "has a
// pixel installed, maybe paused")? Combines three inputs:
//
//   1. PIXEL-IN-TECH-FACTS (free, no new crawl): reads the facts PR 8's tech/detect.ts already wrote
//      under field_name "detected_tech_ads" (confirmed by reading tech/detect.ts's
//      FIELD_NAME_BY_CATEGORY — category "ads" has NO override entry there, so it falls through to
//      that module's own `detected_tech_${category}` default; its signatures.ts table's "ads"
//      category covers Meta Pixel, Google Ads (the AW-######### conversion-id pattern) and Google
//      Local Services Ads). A row here means a pixel/conversion tag is INSTALLED — not necessarily
//      that a campaign is live today, hence inputs 2/3 below.
//   2. META AD LIBRARY — see checkMetaAdLibrary()'s doc comment for exactly what was verified.
//   3. BRAVE "AD BADGE" HEURISTIC — see braveAdLikeHit()'s doc comment for exactly what was
//      researched and why this is honestly a weak, best-effort proxy, not real ad detection.
//
// COMBINATION RULE (documented per the plan's own request): `active = pixelDetected ||
// metaAdLibraryHasAds || braveAdLikeHit` — ANY of the 3 hitting counts as active. This is
// deliberately permissive (an OR, not a majority vote) because each input is cheap/free and a false
// negative (missing real ad activity) is worse for a sales signal than an occasional false positive.
//
// FIRING RULE: the +6 only fires on a genuine TRANSITION into active (previous scan's stored
// `active` was false/absent, this scan's is true) — never on a baseline first scan, and never again
// on every subsequent weekly scan while the company simply KEEPS running ads (which would be the
// same ads_started "signal" repeating forever, worth nothing new to a salesperson). The
// ad_tety_hash fact still stores the full 3-input breakdown every scan (so `changed` reflects ANY
// detail changing, useful for audit/history), but `signalFired`/score_delta are gated on the
// active-transition specifically, not on every hash change.
//
// FIELD-NAMING: "ad_tech_hash" does not collide with the OS's own auto-signal fields (`google_ads`/
// `meta_ads`/`local_services_ads` — see writers.ts's header comment); this check never writes those
// three field names itself, only reads tech/detect.ts's already-written "detected_tech_ads" rows.

import { hashContent, diffChanged } from "../diff";
import { cacheKey } from "../../cache";
import { normalizeDomain } from "../../entity/normalize";
import type { WebSearchResult } from "../../../brave-search";
import type { CompanySignalInput, SignalRunDeps, SignalRunResult } from "../types";

export const AD_ACTIVITY_HASH_FIELD = "ad_tech_hash";
export const AD_ACTIVITY_SCORE_DELTA = 6;
/** The field_name tech/detect.ts actually writes "ads"-category detections under — see module doc. */
export const TECH_ADS_FIELD = "detected_tech_ads";
/** Mirrors rates.json's `brave_query` (0.005 USD). */
export const BRAVE_QUERY_COST_USD = 0.005;

// ── Input 2: Meta Ad Library ──────────────────────────────────────────────────────────────────
//
// RESEARCHED (WebFetch/WebSearch against Meta's own developer docs and current third-party
// integration guides, October 2026): the Ad Library API's `ads_archive` endpoint has NO
// unauthenticated/keyless read path. Every call requires an `access_token` (a registered Meta app,
// identity-verified developer, and the `ads_read` permission granted to that token); calls without
// one return a permission error, full stop — this is NOT a regional/category-dependent exception as
// earlier (pre-2023) docs once suggested, it is now a hard requirement on every call. There is a
// separate, keyless, browser-only search UI at facebook.com/ads/library, but it is not an API and
// has no stable JSON contract to scrape against from a server. So: no real "genuinely unauthenticated
// keyless query path" exists here, confirmed, not assumed — this module therefore degrades
// gracefully by design (same honest-degradation precedent as PR 9's flPermits/pinellas.ts), rather
// than pretending to call an endpoint that will always 4xx without a token this deployment doesn't
// have.
export function metaAdLibraryConfigured(): boolean {
  return Boolean(process.env.CLARA_META_AD_LIBRARY_TOKEN?.trim());
}

export interface MetaAdLibraryCheckResult {
  ok: boolean;
  hasActiveAds?: boolean;
  error?: string;
}

export interface MetaAdLibraryDeps {
  fetchJson: (url: string) => Promise<unknown>;
}

async function defaultFetchJson(url: string): Promise<unknown> {
  const r = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new Error(`meta ad library query ${r.status}`);
  return r.json();
}

export const defaultMetaAdLibraryDeps: MetaAdLibraryDeps = { fetchJson: defaultFetchJson };

/**
 * Queries the Meta Ad Library for active ads by company name. Returns `{ok:false, error:"..."}`
 * immediately, with NO network call, when CLARA_META_AD_LIBRARY_TOKEN isn't configured — which is
 * expected and the common case today (see module doc: this deployment has never provisioned one,
 * since no genuinely keyless path exists to use instead). Written against the real `ads_archive`
 * shape (`{data: [...]}`) so a future PR that DOES provision a token needs no changes here.
 */
export async function checkMetaAdLibrary(companyName: string, deps: MetaAdLibraryDeps = defaultMetaAdLibraryDeps): Promise<MetaAdLibraryCheckResult> {
  const token = process.env.CLARA_META_AD_LIBRARY_TOKEN?.trim();
  if (!token) {
    return {
      ok: false,
      error: "Meta Ad Library requires an access_token with ads_read (no unauthenticated path exists — see module doc); CLARA_META_AD_LIBRARY_TOKEN not configured",
    };
  }
  try {
    const url = `https://graph.facebook.com/v21.0/ads_archive?${new URLSearchParams({
      search_terms: companyName,
      ad_reached_countries: '["US"]',
      ad_active_status: "ACTIVE",
      limit: "5",
      access_token: token,
    }).toString()}`;
    const raw = (await deps.fetchJson(url)) as { data?: unknown[] };
    return { ok: true, hasActiveAds: Array.isArray(raw?.data) && raw.data.length > 0 };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ── Input 3: Brave "ad badge" heuristic ───────────────────────────────────────────────────────
//
// RESEARCHED (Brave's own API reference docs, api-dashboard.search.brave.com, confirmed October
// 2026): the Web Search JSON API this codebase integrates (brave-search.ts's `webSearch()`) returns
// ORGANIC results only — its documented response schema has no `is_sponsored`/`is_ad` field on a
// result, and no separate top-level "ads" array at all. The "Ad ·" badges people see on Brave's
// rendered HTML search page are a presentation-layer feature of that page, not of this JSON
// endpoint; and "Brave Search Ads" (a real, separate Brave product — ads businesses buy to appear
// IN Brave's own results) is an entirely different thing from a business's GOOGLE Ads campaigns,
// which is what the plan actually wants detected. Bottom line, confirmed not assumed: there is no
// reliable way to detect "this business runs Google Ads" from a Brave SERP via this API.
//
// What follows is a deliberately weak, best-effort proxy — kept only to fulfil the plan's 3-input
// design, NOT presented as real ad detection: it flags a hit only when a returned result's domain is
// the company's OWN domain AND that result's title/snippet contains an explicit promotional
// call-to-action phrase commonly written for paid-campaign landing pages. This correlates with
// "actively marketing," at best, loosely — never treat it as more reliable than inputs 1/2, and
// never as the SOLE justification for a fired signal without noting its low confidence (see this
// file's combination-rule comment: it's one vote among three, not a tie-breaker).
const PROMO_CTA_PATTERNS = [
  "shop now", "book now", "call now", "get a free quote", "free estimate", "schedule a free",
  "limited time", "$0 down", "0% financing", "sponsored",
];

export function braveAdLikeHit(results: readonly WebSearchResult[], companyDomain: string | undefined): boolean {
  if (!companyDomain || !results.length) return false;
  return results.some((r) => {
    if (normalizeDomain(r.url) !== companyDomain) return false;
    const text = `${r.title} ${r.snippet ?? ""}`.toLowerCase();
    return PROMO_CTA_PATTERNS.some((p) => text.includes(p));
  });
}

interface AdActivityState {
  active: boolean;
  pixel: boolean;
  meta: boolean;
  brave: boolean;
}

function parseState(value: unknown): AdActivityState | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const p = JSON.parse(value) as Partial<AdActivityState>;
    if (typeof p.active !== "boolean") return undefined;
    return { active: p.active, pixel: Boolean(p.pixel), meta: Boolean(p.meta), brave: Boolean(p.brave) };
  } catch {
    return undefined;
  }
}

export async function runAdActivityCheck(company: CompanySignalInput, deps: SignalRunDeps): Promise<SignalRunResult> {
  if (!company.name) {
    return { ran: false, changed: false, signalFired: false, costCentsSpent: 0, notes: ["no company name"], skippedReason: "no_company_name" };
  }

  const notes: string[] = [];
  let costCentsSpent = 0;

  // Input 1 — free, read-only.
  const techFacts = await deps.factsList({ subject_type: "company", subject_id: company.id, field_name: TECH_ADS_FIELD });
  const pixelDetected = techFacts.length > 0;
  if (pixelDetected) notes.push(`tech-detect facts show: ${techFacts.map((f) => String(f.value)).join(", ")}`);

  // Input 2.
  const meta = await checkMetaAdLibrary(company.name);
  notes.push(meta.ok ? `Meta Ad Library: ${meta.hasActiveAds ? "active ads found" : "no active ads found"}` : `Meta Ad Library: ${meta.error}`);

  // Input 3 — best-effort, see braveAdLikeHit's doc comment.
  let braveHit = false;
  const domain = company.website_url ? normalizeDomain(company.website_url) : undefined;
  if (domain) {
    const k = cacheKey(["ad_activity_brave", company.id]);
    const q = `"${company.name}"${company.city ? ` ${company.city}` : ""}`;
    const r = await deps.cachedCall({
      provider: "brave", kind: "brave", key: k, companyId: company.id,
      costUsd: BRAVE_QUERY_COST_USD, allowLive: deps.allowLive,
      fn: () => deps.webSearch(q, { count: 10 }),
    });
    costCentsSpent += r.costUsd * 100;
    if (r.skipped) {
      notes.push("brave ad-badge heuristic: shadow mode — skipped");
    } else if (r.value?.ok) {
      braveHit = braveAdLikeHit(r.value.results, domain);
      notes.push(`brave ad-badge heuristic: ${braveHit ? "hit (low-confidence)" : "no hit"}`);
    } else {
      notes.push(`brave ad-badge heuristic unavailable: ${r.value?.error ?? "brave search failed"}`);
    }
  } else {
    notes.push("no website_url — brave ad-badge heuristic skipped (nothing to match a result's domain against)");
  }

  const active = pixelDetected || meta.hasActiveAds === true || braveHit;
  const state: AdActivityState = { active, pixel: pixelDetected, meta: meta.hasActiveAds === true, brave: braveHit };
  const hash = hashContent(JSON.stringify(state));

  const existing = await deps.factsList({ subject_type: "company", subject_id: company.id, field_name: AD_ACTIVITY_HASH_FIELD });
  const prevHash = typeof existing[0]?.value === "string" ? existing[0].value : undefined;
  const prevState = parseState(existing[0]?.value);
  const changed = diffChanged(prevHash, hash);
  const observedAt = deps.now().toISOString();

  await deps.writeLastCheckedFact({
    companyId: company.id,
    fieldName: AD_ACTIVITY_HASH_FIELD,
    value: hash,
    sourceType: "derived",
    observedAt,
  });

  let signalFired = false;
  const wasActive = prevState?.active === true;
  if (changed && active && !wasActive) {
    await deps.fireSignal({
      companyId: company.id,
      signalType: "ad_started",
      headline: "Active advertising detected",
      detail: notes.join(" "),
      strength: "medium",
      scoreDelta: AD_ACTIVITY_SCORE_DELTA,
      observedAt,
    });
    signalFired = true;
  }

  return { ran: true, changed, signalFired, costCentsSpent, notes };
}
