// signals/checks/techChange.ts — re-runs tech/detect.ts's PURE signature matcher
// (`matchSignatures`) against the homepage HTML, hashes the resulting signature set, and fires a
// signal when that set differs from last scan.
//
// Deliberately does NOT call tech/detect.ts's full `detectTech()` pipeline: that writes a
// company_technologies_upsert row plus one facts_add row per detected technology, using field names
// (crm, website_platform, …) the OS's own factChangeSignal logic already auto-emits tech_added/
// tech_removed signals for (see osBridge.ts's doc comment on that mechanism). Reusing it here would
// either double-signal (if those field names overlap, which they do) or silently rely on OS-side
// auto-emission for a score_delta this PR has no control over — and "score delta math" is an
// explicit, must-be-precise test requirement for every PR 17 signal. So this check keeps its own,
// much simpler, separately-hashed/tracked state (`tech_scan_hash`, one fact) and calls signals_add
// itself with a fixed score_delta, exactly like website-change and review-velocity do. A future PR
// could reconcile the two approaches if that ever matters.
//
// SEQUENCING: tech-change is deliberately NOT independent of website-change. Re-scanning signatures
// against unchanged HTML can never find a different signature set, so refresh.ts only calls this
// AFTER website-change has run for the same company this tick, and only when that found the
// homepage itself changed — see refresh.ts's doc comment. `ctx` carries that decision + the
// already-fetched homepage HTML down so this check never re-crawls. Called with no `ctx` at all
// (e.g. a future ad-hoc per-company check, or this module's own tests), it falls back to an
// independent crawl+hash of its own rather than being permanently inert outside refresh.ts's loop.

import { hashContent, diffChanged } from "../diff";
import { homepageUrl } from "../pageUrls";
import { matchSignatures } from "../../tech/detect";
import type { CompanySignalInput, SignalRunDeps, SignalRunResult, SignalRunContext } from "../types";

export const TECH_SCAN_FIELD = "tech_scan_hash";
/** Fixed per-signal score_delta (registry.ts mirrors this) — see this file's header comment on why
 *  tech-change doesn't vary it by tech-added-vs-removed direction: either direction is a genuine
 *  stack change and equally worth a look. */
export const TECH_CHANGE_SCORE_DELTA = 8;

/** Pure: the sorted, deduped signature-name set for one page's HTML, and its hash. Exported for
 *  direct unit testing (techChange.test.ts). */
export function signatureSetHash(html: string): { names: string[]; hash: string } {
  const names = [...new Set(matchSignatures(html).map((s) => s.name))].sort();
  return { names, hash: hashContent(JSON.stringify(names)) };
}

export async function runTechChangeCheck(company: CompanySignalInput, deps: SignalRunDeps, ctx?: SignalRunContext): Promise<SignalRunResult> {
  if (!company.website_url) {
    return { ran: false, changed: false, signalFired: false, costCentsSpent: 0, notes: ["no website_url"], skippedReason: "no website_url" };
  }

  let html: string | undefined = ctx?.homepageHtml;
  let costCentsSpent = 0;

  if (ctx && ctx.homepageChanged === false) {
    return { ran: false, changed: false, signalFired: false, costCentsSpent: 0, notes: ["homepage unchanged this tick — sequencing gate skipped tech-change"], skippedReason: "homepage_unchanged" };
  }

  if (html === undefined) {
    // Standalone fallback (no ctx, or ctx carried no html — e.g. a jina-only homepage fetch) — do
    // our own crawl rather than staying permanently inert.
    const url = homepageUrl(company.website_url);
    if (!url) {
      return { ran: false, changed: false, signalFired: false, costCentsSpent: 0, notes: ["unparseable website_url"], skippedReason: "unparseable website_url" };
    }
    const r = await deps.crawlPage(url, { companyId: company.id });
    costCentsSpent += (r.costUsd ?? 0) * 100;
    if (!r.ok || !r.evidence?.htmlPath) {
      return {
        ran: false, changed: false, signalFired: false, costCentsSpent, notes: [`no raw html to scan (${r.reason ?? r.error ?? "jina-only fetch"})`],
        skippedReason: "no_html",
      };
    }
    try {
      html = await deps.readFile(r.evidence.htmlPath);
    } catch (e) {
      return { ran: false, changed: false, signalFired: false, costCentsSpent, notes: [`could not read html: ${e instanceof Error ? e.message : String(e)}`], skippedReason: "read_failed" };
    }
  }

  const { names, hash } = signatureSetHash(html);
  const existing = await deps.factsList({ subject_type: "company", subject_id: company.id, field_name: TECH_SCAN_FIELD });
  const prev = typeof existing[0]?.value === "string" ? existing[0].value : undefined;
  const changed = diffChanged(prev, hash);
  const observedAt = deps.now().toISOString();

  await deps.writeLastCheckedFact({
    companyId: company.id,
    fieldName: TECH_SCAN_FIELD,
    value: hash,
    sourceType: "derived",
    sourceUrl: homepageUrl(company.website_url),
    observedAt,
  });

  let signalFired = false;
  if (changed) {
    await deps.fireSignal({
      companyId: company.id,
      signalType: names.length ? "tech_added" : "tech_removed",
      headline: names.length ? `Tech stack changed: ${names.join(", ")}` : "Tech stack changed: signatures no longer detected",
      detail: `Signature scan of the homepage now reads [${names.join(", ")}].`,
      strength: "medium",
      scoreDelta: TECH_CHANGE_SCORE_DELTA,
      sourceUrl: homepageUrl(company.website_url),
      observedAt,
    });
    signalFired = true;
  }

  return { ran: true, changed, signalFired, costCentsSpent, notes: [] };
}
