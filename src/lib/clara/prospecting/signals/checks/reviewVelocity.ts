// signals/checks/reviewVelocity.ts — snapshots a company's Google rating/review count
// (Place Details, by google_place_id — no text search needed, the id's already on the row from
// discovery) and, once ~30d-ago AND ~90d-ago historical snapshots both exist, fires `review_velocity`
// when the 90-day review-COUNT delta clears a threshold.
//
// The plan pins down exactly one rule precisely: (latest - snapshot_90d_ago) / snapshot_90d_ago
// >= 20% => strength "high". Everything below that is this PR's own judgement call (documented
// below) since the plan explicitly leaves it open ("your call on thresholds below 20%").

import type { CompanyFactRow } from "../../osBridge";
import { cacheKey } from "../../cache";
import type { CompanySignalInput, SignalRunDeps, SignalRunResult } from "../types";

export const REVIEW_SNAPSHOT_FIELD = "review_snapshot";
/** Mirrors rates.json's `places_details` (0.005 USD) — see places.ts's getPlaceDetails doc comment
 *  and rates.json's own _comment on these being placeholder figures until the owner's real plan numbers
 *  are in. Kept as a local constant (not an async rates.json read) — same convention
 *  discovery/index.ts's cellCosts() already uses. */
export const PLACES_DETAILS_COST_USD = 0.005;

/** HIGH tier — the plan's one precisely-specified rule. MEDIUM is this PR's own simplification of
 *  the plan's "a smaller-but-positive delta can fire at low/medium — your call" guidance, using
 *  exactly the ≥5%-=-medium example the plan itself offers; below that is "no signal" rather than
 *  adding a third LOW tier the plan doesn't ask for precisely. */
export const REVIEW_VELOCITY_HIGH_THRESHOLD = 0.2;
export const REVIEW_VELOCITY_MEDIUM_THRESHOLD = 0.05;
export const REVIEW_VELOCITY_SCORE_DELTA_HIGH = 10;
export const REVIEW_VELOCITY_SCORE_DELTA_MEDIUM = 5;

/** How close (days) a historical snapshot has to be to a target (30 or 90 days ago) to count as
 *  "the ~30d-ago" / "the ~90d-ago" snapshot. Weekly scan cadence (see registry.ts) means a snapshot
 *  should normally land within a few days of either target; ±5 keeps a slightly-late/early scan
 *  from disqualifying an otherwise-good comparison without accepting something too far off to be
 *  meaningful. */
export const SNAPSHOT_TOLERANCE_DAYS = 5;

export interface ReviewStrength {
  strength: "high" | "medium";
  scoreDelta: number;
}

/** Pure: which tier (if any) a 90-day review-count delta clears. Exported for exact boundary
 *  testing (reviewVelocity.test.ts asserts the ≥20% rule precisely, including AT exactly 20%). */
export function reviewVelocityStrength(deltaFraction: number): ReviewStrength | undefined {
  if (deltaFraction >= REVIEW_VELOCITY_HIGH_THRESHOLD) return { strength: "high", scoreDelta: REVIEW_VELOCITY_SCORE_DELTA_HIGH };
  if (deltaFraction >= REVIEW_VELOCITY_MEDIUM_THRESHOLD) return { strength: "medium", scoreDelta: REVIEW_VELOCITY_SCORE_DELTA_MEDIUM };
  return undefined;
}

interface Snapshot {
  reviewCount: number;
  rating?: number;
  observedAtMs: number;
}

function parseSnapshot(row: CompanyFactRow): Snapshot | undefined {
  if (typeof row.value !== "string") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.value);
  } catch {
    return undefined;
  }
  const obj = parsed as { review_count?: unknown; rating?: unknown };
  if (typeof obj.review_count !== "number" || !Number.isFinite(obj.review_count)) return undefined;
  const observedAtMs = typeof row.observed_at === "string" ? Date.parse(row.observed_at) : NaN;
  if (!Number.isFinite(observedAtMs)) return undefined;
  return { reviewCount: obj.review_count, rating: typeof obj.rating === "number" ? obj.rating : undefined, observedAtMs };
}

/** Picks the historical row closest to `targetDaysAgo`, within SNAPSHOT_TOLERANCE_DAYS. Pure, unit
 *  tested directly. `history` excludes the just-written current snapshot (callers pass only prior
 *  rows). */
export function closestSnapshot(history: CompanyFactRow[], now: Date, targetDaysAgo: number): Snapshot | undefined {
  const targetMs = now.getTime() - targetDaysAgo * 24 * 3600_000;
  const toleranceMs = SNAPSHOT_TOLERANCE_DAYS * 24 * 3600_000;
  let best: { snap: Snapshot; distanceMs: number } | undefined;
  for (const row of history) {
    const snap = parseSnapshot(row);
    if (!snap) continue;
    const distanceMs = Math.abs(snap.observedAtMs - targetMs);
    if (distanceMs > toleranceMs) continue;
    if (!best || distanceMs < best.distanceMs) best = { snap, distanceMs };
  }
  return best?.snap;
}

export async function runReviewVelocityCheck(company: CompanySignalInput, deps: SignalRunDeps): Promise<SignalRunResult> {
  if (!company.google_place_id) {
    return { ran: false, changed: false, signalFired: false, costCentsSpent: 0, notes: ["no google_place_id"], skippedReason: "no google_place_id" };
  }

  const key = cacheKey(["places_details", company.google_place_id]);
  const result = await deps.cachedCall({
    provider: "places",
    kind: "places",
    key,
    companyId: company.id,
    costUsd: PLACES_DETAILS_COST_USD,
    allowLive: deps.allowLive,
    fn: () => deps.getPlaceDetails(company.google_place_id as string),
  });

  const costCentsSpent = result.costUsd * 100;
  if (result.skipped) {
    return { ran: false, changed: false, signalFired: false, costCentsSpent, notes: ["shadow mode — Places Details call skipped"], skippedReason: "shadow_mode" };
  }
  const place = result.value;
  if (!place || place.ok === false || typeof place.userRatingCount !== "number") {
    return { ran: false, changed: false, signalFired: false, costCentsSpent, notes: [`Places Details unavailable: ${place?.error ?? "no data"}`], skippedReason: "places_unavailable" };
  }

  const now = deps.now();
  const observedAt = now.toISOString();
  const latestReviewCount = place.userRatingCount;

  const history = await deps.factsList({ subject_type: "company", subject_id: company.id, field_name: REVIEW_SNAPSHOT_FIELD, include_history: true });
  const snapshot30 = closestSnapshot(history, now, 30);
  const snapshot90 = closestSnapshot(history, now, 90);

  // Always write this scan's own snapshot first — it becomes next time's history, regardless of
  // whether we have enough history YET to compute a delta this run.
  await deps.writeLastCheckedFact({
    companyId: company.id,
    fieldName: REVIEW_SNAPSHOT_FIELD,
    value: JSON.stringify({ rating: place.rating, review_count: latestReviewCount, observed_at: observedAt }),
    sourceType: "derived",
    observedAt,
  });

  if (!snapshot30 || !snapshot90) {
    return {
      ran: true, changed: false, signalFired: false, costCentsSpent,
      notes: [`insufficient history for a velocity read (30d snapshot: ${snapshot30 ? "ok" : "missing"}, 90d snapshot: ${snapshot90 ? "ok" : "missing"})`],
    };
  }
  if (snapshot90.reviewCount <= 0) {
    return { ran: true, changed: false, signalFired: false, costCentsSpent, notes: ["90d-ago review count was 0 — can't compute a meaningful percentage delta"] };
  }

  const deltaFraction = (latestReviewCount - snapshot90.reviewCount) / snapshot90.reviewCount;
  const tier = deltaFraction > 0 ? reviewVelocityStrength(deltaFraction) : undefined;
  if (!tier) {
    return { ran: true, changed: false, signalFired: false, costCentsSpent, notes: [`90d delta ${(deltaFraction * 100).toFixed(1)}% — below the medium threshold`] };
  }

  await deps.fireSignal({
    companyId: company.id,
    signalType: "review_velocity",
    headline: `Reviews up ${(deltaFraction * 100).toFixed(0)}% in ~90 days (${snapshot90.reviewCount} → ${latestReviewCount})`,
    detail: `30d-ago snapshot: ${snapshot30.reviewCount} reviews. 90d-ago snapshot: ${snapshot90.reviewCount} reviews. Now: ${latestReviewCount}.`,
    strength: tier.strength,
    scoreDelta: tier.scoreDelta,
    observedAt,
  });

  return { ran: true, changed: true, signalFired: true, costCentsSpent, notes: [`90d delta ${(deltaFraction * 100).toFixed(1)}% — ${tier.strength}`] };
}
