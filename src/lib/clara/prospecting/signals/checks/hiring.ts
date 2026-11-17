// signals/checks/hiring.ts — PR 18: is this company visibly hiring, and if so, for what?
//
// Three input sources, merged into one text blob for a single tier-1 extraction pass:
//   1. Brave web search: `site:indeed.com "{name}" {city}` and `site:linkedin.com/jobs "{name}"` —
//      job BOARDS, not the company's own site, so a listing shows up here even for a company with
//      no /careers page of its own.
//   2. A direct crawl of `{origin}/careers` (deps.crawlPage — free under today's rates.json, same
//      $0 crawl rungs website-change already uses). Deliberately NOT pagePicker.ts's full
//      discovery/alternate-spelling pass (jobs/employment/careers-and-jobs) — this is a cheap,
//      best-effort recurring scan, not a first-crawl discovery pass; a company whose careers page
//      lives at a non-canonical path just relies on the Brave inputs instead, which is an
//      acceptable, documented gap rather than a reason to pay for pagePicker's full fan-out here.
//
// Role titles are then extracted from that combined text by a single tier-1 LLM call (free under
// today's rates.json — see llm.ts's `llm_t1_call: 0`) asking for strict JSON `{"roles": string[]}`.
// Tier-1 (not tier-2/3) per the plan's own "tier-1 extraction" phrasing for hiring — this is a
// simple "what roles are mentioned" read, not a judgment call worth a bigger model.
//
// SCORING: +8 when the CHANGE includes a role matching /sales|estimator|project manager|ops|
// operations/i — the EXACT regex orion/mcp-server/src/tools/prospects.ts's factChangeSignal uses
// for its own `hiring`/`job_postings` field-change signal (confirmed by reading that file directly,
// October 2026) — reused verbatim so CLARA's own signal-scan reasons about "is this hiring
// sales/ops-relevant" exactly the way the OS's auto-signal path already does. A hiring change that
// does NOT match gets a smaller +3 (this PR's own call, per the plan's "your call on a non-sales/
// ops hiring signal's value" — generic hiring still indicates real business activity/growth worth
// a token bump, just far less relevant to a CRM/process-automation pitch than sales/ops hiring
// specifically; zero felt like throwing away real information the scan already paid to gather).
//
// FIELD-NAMING, to avoid the OS's own auto-signal collision (see writers.ts's doc comment and this
// PR's overall header): the OS's facts_add already auto-emits a score-less `hiring` signal off
// field_name `hiring`/`job_postings` changes (factChangeSignal, same file). This check's own
// last-checked/diff-baseline state is therefore written under "last_hiring_scan" — NOT "hiring" or
// "job_postings" — so writeLastCheckedFact's facts_add call can never accidentally trigger that
// score-less OS-side path; the real, SCORED signal here only ever comes from this file's own
// fireSignal call below.

import { hashContent, diffChanged } from "../diff";
import { websiteOrigin } from "../pageUrls";
import { cacheKey } from "../../cache";
import type { CompanySignalInput, SignalRunDeps, SignalRunResult } from "../types";

export const HIRING_LAST_SCAN_FIELD = "last_hiring_scan";
export const HIRING_SALES_OPS_SCORE_DELTA = 8;
export const HIRING_GENERIC_SCORE_DELTA = 3;
/** Mirrors rates.json's `brave_query` (0.005 USD) — see reviewVelocity.ts's PLACES_DETAILS_COST_USD
 *  doc comment for why this is a local constant, not an async rates.json read. Two queries (indeed +
 *  linkedin) per scan. */
export const BRAVE_QUERY_COST_USD = 0.005;

/** Verbatim copy of orion/mcp-server/src/tools/prospects.ts's factChangeSignal regex for the
 *  `hiring`/`job_postings` fields — see module doc for why this must match exactly. */
export const SALES_OPS_HIRING_REGEX = /sales|estimator|project manager|ops|operations/i;

interface HiringLlmResult {
  roles: string[];
  notes: string[];
}

/** Pure: parses a tier-1 `{"roles": string[]}` response into a deduped, trimmed role list. Malformed
 *  JSON (or a shape that isn't `{roles: string[]}`) degrades to an empty list rather than throwing —
 *  exported for direct unit testing (hiring.test.ts's "malformed LLM JSON handled gracefully"). */
export function parseHiringRolesResponse(text: string | undefined): HiringLlmResult {
  const notes: string[] = [];
  if (!text || !text.trim()) return { roles: [], notes: ["no extraction text returned"] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { roles: [], notes: ["LLM role extraction returned malformed JSON — treated as no roles found"] };
  }
  const obj = parsed as { roles?: unknown };
  if (!obj || !Array.isArray(obj.roles)) {
    return { roles: [], notes: ["LLM response had no roles[] array — treated as no roles found"] };
  }
  const roles = obj.roles
    .filter((r): r is string => typeof r === "string" && r.trim().length > 0)
    .map((r) => r.trim());
  return { roles, notes };
}

export async function runHiringCheck(company: CompanySignalInput, deps: SignalRunDeps): Promise<SignalRunResult> {
  if (!company.name) {
    return { ran: false, changed: false, signalFired: false, costCentsSpent: 0, notes: ["no company name"], skippedReason: "no_company_name" };
  }

  const notes: string[] = [];
  let costCentsSpent = 0;
  const textParts: string[] = [];

  const queries: { key: string; q: string }[] = [
    { key: "indeed", q: `site:indeed.com "${company.name}"${company.city ? ` ${company.city}` : ""}` },
    { key: "linkedin", q: `site:linkedin.com/jobs "${company.name}"` },
  ];
  for (const { key, q } of queries) {
    const k = cacheKey(["hiring_scan", company.id, key]);
    const r = await deps.cachedCall({
      provider: "brave", kind: "brave", key: k, companyId: company.id,
      costUsd: BRAVE_QUERY_COST_USD, allowLive: deps.allowLive,
      fn: () => deps.webSearch(q, { count: 5 }),
    });
    costCentsSpent += r.costUsd * 100;
    if (r.skipped) {
      notes.push(`${key}: shadow mode — brave query skipped`);
      continue;
    }
    if (!r.value || !r.value.ok) {
      notes.push(`${key}: ${r.value?.error ?? "brave search unavailable"}`);
      continue;
    }
    for (const item of r.value.results) textParts.push(`${item.title} — ${item.snippet ?? ""}`);
  }

  const origin = company.website_url ? websiteOrigin(company.website_url) : undefined;
  if (origin) {
    const r = await deps.crawlPage(`${origin}/careers`, { companyId: company.id });
    costCentsSpent += (r.costUsd ?? 0) * 100;
    if (r.ok && r.evidence?.txtPath) {
      try {
        textParts.push(await deps.readFile(r.evidence.txtPath));
      } catch (e) {
        notes.push(`careers page: could not read crawled text (${e instanceof Error ? e.message : String(e)})`);
      }
    } else if (!r.ok) {
      notes.push(`careers page: ${r.reason ?? r.error ?? "crawl failed"}`);
    }
  }

  const combinedText = textParts.join("\n\n").slice(0, 6000);
  let roles: string[] = [];
  if (combinedText.trim()) {
    const prompt = `Extract distinct job/role titles this company appears to be hiring for, from the text below (job-board snippets and/or careers-page copy). Respond with STRICT JSON only, no commentary: {"roles": string[]}. If nothing looks like an open role, return {"roles": []}.\n\nText:\n${combinedText}`;
    const llm = await deps.runTier(1, prompt, { purpose: "prospect:signal_hiring_extract", json: true, maxTokens: 300 });
    if (llm.ok) {
      const parsed = parseHiringRolesResponse(llm.text);
      roles = parsed.roles;
      notes.push(...parsed.notes);
    } else {
      notes.push(`role extraction unavailable: ${llm.error ?? "tier-1 call failed"}`);
    }
  } else {
    notes.push("no hiring-signal text gathered this scan (brave + careers page both empty/unavailable)");
  }

  const normalizedRoles = [...new Set(roles.map((r) => r.toLowerCase().trim()))].sort();
  const hash = hashContent(JSON.stringify(normalizedRoles));
  const existing = await deps.factsList({ subject_type: "company", subject_id: company.id, field_name: HIRING_LAST_SCAN_FIELD });
  const prevHash = typeof existing[0]?.value === "string" ? existing[0].value : undefined;
  const changed = diffChanged(prevHash, hash);
  const observedAt = deps.now().toISOString();

  await deps.writeLastCheckedFact({
    companyId: company.id,
    fieldName: HIRING_LAST_SCAN_FIELD,
    value: hash,
    sourceType: "job_post",
    observedAt,
  });

  let signalFired = false;
  if (changed && roles.length) {
    const salesOpsMatch = roles.some((r) => SALES_OPS_HIRING_REGEX.test(r));
    const scoreDelta = salesOpsMatch ? HIRING_SALES_OPS_SCORE_DELTA : HIRING_GENERIC_SCORE_DELTA;
    await deps.fireSignal({
      companyId: company.id,
      signalType: "hiring",
      headline: `Hiring: ${roles.slice(0, 3).join(", ")}`.slice(0, 120),
      detail: `Roles found this scan: ${roles.join(", ")}.`,
      interpretation: salesOpsMatch ? "Expanding the sales/ops organization — likely need for CRM/process automation." : undefined,
      strength: salesOpsMatch ? "high" : "medium",
      scoreDelta,
      observedAt,
    });
    signalFired = true;
    notes.push(salesOpsMatch ? "sales/ops-relevant hiring detected (+8)" : "generic (non sales/ops) hiring change detected (+3)");
  }

  return { ran: true, changed, signalFired, costCentsSpent, notes };
}
