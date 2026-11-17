// signals/checks/websiteChange.ts — hashes home/services/financing, compares to the last-stored
// hash fact for each page, fires `website_change` if ANY of the 3 differ from last scan.
//
// Reuses PR 7's crawler/waterfall.ts (`crawlPage`, http->jina->playwright) directly rather than a
// bespoke fetch — gets robots/aggregator gating and the evidence file (text already flattened by
// htmlToText) for free. The evidence file's text, not CrawlPageResult itself, is what gets hashed
// (crawlPage only hands back a path — see signals/types.ts's SignalRunDeps.readFile doc comment).

import { hashContent, diffChanged } from "../diff";
import { targetPages, websiteOrigin } from "../pageUrls";
import type { CompanySignalInput, SignalRunDeps, SignalRunResult } from "../types";

/** Fixed per the plan's "a fixed per-signal-type delta is simplest" guidance (registry.ts mirrors
 *  this as website_change's registered score_delta). */
export const WEBSITE_CHANGE_SCORE_DELTA = 6;

export interface WebsiteChangeResult extends SignalRunResult {
  /** Specifically whether the HOME page changed — tech-change's own gate (see checks/techChange.ts
   *  and refresh.ts's sequencing). */
  homepageChanged: boolean;
  /** The home page's freshly-crawled text, when we have it — informational, not reused by
   *  tech-change (which needs raw HTML — see homepageHtml below). */
  homepageText?: string;
  /** The home page's raw HTML, when the winning crawl rung returned one (http/playwright; jina
   *  never does — see crawler/waterfall.ts's finalize()). Handed to tech-change so it never
   *  re-crawls the homepage in the same tick. */
  homepageHtml?: string;
}

export async function runWebsiteChangeCheck(company: CompanySignalInput, deps: SignalRunDeps): Promise<WebsiteChangeResult> {
  const notes: string[] = [];
  if (!company.website_url) {
    return { ran: false, changed: false, signalFired: false, costCentsSpent: 0, notes: ["no website_url"], skippedReason: "no website_url", homepageChanged: false };
  }
  const pages = targetPages(company.website_url);
  if (!pages) {
    return { ran: false, changed: false, signalFired: false, costCentsSpent: 0, notes: ["unparseable website_url"], skippedReason: "unparseable website_url", homepageChanged: false };
  }

  const existing = await deps.factsList({ subject_type: "company", subject_id: company.id });
  const prevHashFor = (fieldName: string): string | undefined => {
    const row = existing.find((f) => f.field_name === fieldName);
    return typeof row?.value === "string" ? row.value : undefined;
  };

  let costCentsSpent = 0;
  let anyChanged = false;
  let homepageChanged = false;
  let homepageText: string | undefined;
  let homepageHtml: string | undefined;
  const changedPages: string[] = [];
  const observedAt = deps.now().toISOString();

  for (const page of pages) {
    const r = await deps.crawlPage(page.url, { companyId: company.id });
    costCentsSpent += (r.costUsd ?? 0) * 100;
    if (!r.ok || !r.evidence?.txtPath) {
      notes.push(`${page.key}: crawl ${r.reason ?? r.error ?? "failed"}`);
      continue;
    }
    let text: string;
    try {
      text = await deps.readFile(r.evidence.txtPath);
    } catch (e) {
      notes.push(`${page.key}: could not read crawled text (${e instanceof Error ? e.message : String(e)})`);
      continue;
    }
    if (page.key === "home") {
      homepageText = text;
      if (r.evidence.htmlPath) {
        try {
          homepageHtml = await deps.readFile(r.evidence.htmlPath);
        } catch {
          /* best-effort only — tech-change's own fallback handles a missing html read */
        }
      }
    }

    const hash = hashContent(text);
    const prev = prevHashFor(page.fieldName);
    const changed = diffChanged(prev, hash);
    if (changed) {
      anyChanged = true;
      changedPages.push(page.key);
      if (page.key === "home") homepageChanged = true;
    }
    await deps.writeLastCheckedFact({
      companyId: company.id,
      fieldName: page.fieldName,
      value: hash,
      sourceType: "website_page",
      sourceUrl: page.url,
      observedAt,
    });
  }

  let signalFired = false;
  if (anyChanged) {
    await deps.fireSignal({
      companyId: company.id,
      signalType: "website_change",
      headline: `Website changed (${changedPages.join(", ")})`,
      detail: `Re-crawl found a different page hash for: ${changedPages.join(", ")}.`,
      strength: "medium",
      scoreDelta: WEBSITE_CHANGE_SCORE_DELTA,
      sourceUrl: websiteOrigin(company.website_url),
      observedAt,
    });
    signalFired = true;
  }

  return { ran: true, changed: anyChanged, signalFired, costCentsSpent, notes, homepageChanged, homepageText, homepageHtml };
}
