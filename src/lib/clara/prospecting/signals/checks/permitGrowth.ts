// signals/checks/permitGrowth.ts — PR 18: is this company's recent building-permit volume trending
// UP (trailing 30 days vs. the prior 30 days) in the one of Hillsborough/Pinellas county its address
// falls in?
//
// Reuses PR 9's two county adapters (publicdata/flPermits/{hillsborough,pinellas}.ts) directly — see
// those files' own doc comments for exactly what's CONFIRMED real (Hillsborough's ArcGIS
// FeatureServer) vs. best-guess/unconfirmed (Pinellas's, which in practice returns [] until a real
// endpoint is found — this check inherits that honest limitation as-is, not something to paper over
// here). `pickPermitJurisdiction` (publicdata/index.ts, PR 9) is reused as-is for the
// city->jurisdiction decision — a company outside both counties' city lists cleanly SKIPS
// (`ran:false, skippedReason:"not_in_covered_county"`), mirroring PR 9's own graceful "most of
// Florida just doesn't have permit data" precedent, not an error.
//
// SEARCH TERM: prefers the company's own DBPR license number on file (facts field_name
// "dbpr_license", written by publicdata/index.ts's dbprFacts — PR 9), specifically an ACTIVE one
// when more than one is on file (evidence.statusActive, per flDbpr.ts's DbprRecord shape), falling
// back to the bare company name when no DBPR license fact exists. A license number is a far more
// precise cross-reference than free-text name matching — especially against Hillsborough's
// description-only search (that adapter's own doc comment: it has no contractor-name field at all,
// only a DESCRIPTION free-text scan, which sometimes embeds a contractor reference number).
//
// THRESHOLD: fires on ANY positive delta (recentCount > priorCount) with at least 1 permit in the
// trailing 30 days — the simplest, most testable rule available (the plan leaves the exact threshold
// open: "your call, keep it simple and testable"). No minimum absolute count beyond ">0 this window"
// was added on top of ">prior window" — a company going from 0->1 permits in 30 days IS a genuine,
// real increase worth a look, not noise to filter out.
//
// FIELD-NAMING: "last_permit_scan" does not collide with any OS auto-signal field (writers.ts's
// header comment's list), nor with publicdata/index.ts's own "permit_count"/"permit_value" facts
// (a different, PR 9, write path for a different purpose — this PR's own last-checked/diff-baseline
// state is intentionally separate so the two features' facts_add calls can never interfere).

import { pickPermitJurisdiction } from "../../publicdata";
import type { PermitRecord } from "../../publicdata/types";
import type { CompanySignalInput, SignalRunDeps, SignalRunResult } from "../types";

export const LAST_PERMIT_SCAN_FIELD = "last_permit_scan";
export const PERMIT_GROWTH_SCORE_DELTA = 6;
const WINDOW_MS = 30 * 24 * 3600_000;

export interface PermitWindowCounts {
  recentCount: number;
  priorCount: number;
  undated: number;
}

/** Pure: buckets `permits` by issueDate into "trailing 30 days" vs. "the 30 days before that,"
 *  relative to `nowMs`. Permits with no parseable issueDate are counted separately (`undated`) and
 *  excluded from both windows — an undated permit can't honestly be placed in either bucket, and
 *  silently dropping it (rather than guessing a window) is the honest choice. Exported for direct
 *  unit testing. */
export function computePermitWindowCounts(permits: readonly PermitRecord[], nowMs: number): PermitWindowCounts {
  const recentCutoff = nowMs - WINDOW_MS;
  const priorCutoff = nowMs - 2 * WINDOW_MS;
  let recentCount = 0;
  let priorCount = 0;
  let undated = 0;
  for (const p of permits) {
    const t = p.issueDate ? Date.parse(p.issueDate) : NaN;
    if (!Number.isFinite(t)) {
      undated++;
      continue;
    }
    if (t >= recentCutoff && t <= nowMs) recentCount++;
    else if (t >= priorCutoff && t < recentCutoff) priorCount++;
  }
  return { recentCount, priorCount, undated };
}

export async function runPermitGrowthCheck(company: CompanySignalInput, deps: SignalRunDeps): Promise<SignalRunResult> {
  const jurisdiction = pickPermitJurisdiction(company.city);
  if (!jurisdiction) {
    return {
      ran: false, changed: false, signalFired: false, costCentsSpent: 0,
      notes: [`company city "${company.city ?? ""}" is not in a jurisdiction this signal covers (Hillsborough/Pinellas only)`],
      skippedReason: "not_in_covered_county",
    };
  }
  if (!company.name) {
    return { ran: false, changed: false, signalFired: false, costCentsSpent: 0, notes: ["no company name"], skippedReason: "no_company_name" };
  }

  // NOTE: facts_list's CompanyFactRow (osBridge.ts) does not carry the `evidence` jsonb column back
  // (only field_name/value/confidence/grounded/source_type/observed_at) — so, unlike
  // publicdata/index.ts's own in-process `dbpr.some((r) => r.statusActive)` check (which reads
  // statusActive straight off DbprRecord before it's ever written to a fact), this check cannot
  // distinguish an active vs. inactive license once it's round-tripped through facts_list. It
  // simply takes the first dbpr_license fact on file (there is usually just one per company) —
  // still a far more precise cross-reference than the bare company-name fallback below.
  const dbprFacts = await deps.factsList({ subject_type: "company", subject_id: company.id, field_name: "dbpr_license" });
  const licenseValue = typeof dbprFacts[0]?.value === "string" ? dbprFacts[0].value.trim() : "";
  const searchTerm = licenseValue || company.name;
  const usedLicense = Boolean(licenseValue);

  const lookup = jurisdiction === "hillsborough" ? deps.lookupHillsboroughPermits : deps.lookupPinellasPermits;
  let permits: PermitRecord[];
  try {
    permits = await lookup(searchTerm);
  } catch (e) {
    return {
      ran: false, changed: false, signalFired: false, costCentsSpent: 0,
      notes: [`permit lookup failed: ${e instanceof Error ? e.message : String(e)}`], skippedReason: "lookup_failed",
    };
  }

  const now = deps.now();
  const observedAt = now.toISOString();
  const { recentCount, priorCount, undated } = computePermitWindowCounts(permits, now.getTime());

  const existing = await deps.factsList({ subject_type: "company", subject_id: company.id, field_name: LAST_PERMIT_SCAN_FIELD });
  const isBaseline = existing.length === 0;

  await deps.writeLastCheckedFact({
    companyId: company.id,
    fieldName: LAST_PERMIT_SCAN_FIELD,
    value: JSON.stringify({ recentCount, priorCount }),
    sourceType: "permit",
    observedAt,
  });

  const notes = [
    `${jurisdiction} (by ${usedLicense ? "DBPR license" : "company name"} "${searchTerm}"): ${recentCount} permits in trailing 30d vs ${priorCount} in the prior 30d (${undated} undated, excluded)`,
  ];

  if (isBaseline) {
    return { ran: true, changed: false, signalFired: false, costCentsSpent: 0, notes: [...notes, "baseline scan — no signal"] };
  }

  if (recentCount > priorCount && recentCount > 0) {
    await deps.fireSignal({
      companyId: company.id,
      signalType: "permit",
      headline: `Permit activity up (${priorCount} → ${recentCount} in 30d)`,
      detail: notes[0],
      strength: "medium",
      scoreDelta: PERMIT_GROWTH_SCORE_DELTA,
      observedAt,
    });
    return { ran: true, changed: true, signalFired: true, costCentsSpent: 0, notes };
  }

  return { ran: true, changed: false, signalFired: false, costCentsSpent: 0, notes };
}
