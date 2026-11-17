import { test } from "node:test";
import assert from "node:assert/strict";
import {
  runReviewVelocityCheck,
  reviewVelocityStrength,
  closestSnapshot,
  REVIEW_SNAPSHOT_FIELD,
  REVIEW_VELOCITY_HIGH_THRESHOLD,
  REVIEW_VELOCITY_SCORE_DELTA_HIGH,
  REVIEW_VELOCITY_SCORE_DELTA_MEDIUM,
} from "./reviewVelocity";
import type { CompanyFactRow } from "../../osBridge";
import type { CompanySignalInput, SignalRunDeps } from "../types";

const NOW = new Date("2026-10-01T00:00:00Z");
const DAY_MS = 24 * 3600_000;

function snapshotFact(daysAgo: number, reviewCount: number, rating = 4.5): CompanyFactRow {
  const observedAt = new Date(NOW.getTime() - daysAgo * DAY_MS).toISOString();
  return { id: `f_${daysAgo}`, field_name: REVIEW_SNAPSHOT_FIELD, value: JSON.stringify({ rating, review_count: reviewCount, observed_at: observedAt }), source_type: "derived", observed_at: observedAt };
}

interface SignalCall { signalType: string; headline: string; strength?: string; scoreDelta: number }

function depsFor(opts: { history?: CompanyFactRow[]; placeResult?: { ok: boolean; rating?: number; userRatingCount?: number; error?: string }; allowLive?: boolean }): { deps: SignalRunDeps; signals: SignalCall[]; writes: { fieldName: string; value: string }[] } {
  const signals: SignalCall[] = [];
  const writes: { fieldName: string; value: string }[] = [];
  const deps: SignalRunDeps = {
    now: () => NOW,
    factsList: async () => opts.history ?? [],
    writeLastCheckedFact: async (input) => {
      writes.push({ fieldName: input.fieldName, value: input.value });
    },
    fireSignal: async (input) => {
      signals.push({ signalType: input.signalType, headline: input.headline, strength: input.strength, scoreDelta: input.scoreDelta });
      return { signal: {} };
    },
    crawlPage: (async () => ({ ok: false, url: "", costUsd: 0 })) as SignalRunDeps["crawlPage"],
    readFile: async () => "",
    cachedCall: (async (args: { fn: () => Promise<unknown>; allowLive: boolean }) => {
      if (!args.allowLive) return { cached: false, skipped: true, costUsd: 0 };
      const value = await args.fn();
      return { value, cached: false, costUsd: 0.005 };
    }) as SignalRunDeps["cachedCall"],
    getPlaceDetails: async () => opts.placeResult ?? { ok: true, rating: 4.5, userRatingCount: 120 },
    webSearch: async () => ({ ok: false, results: [], error: "not used in this test" }),
    findBusiness: async () => ({ ok: false, candidates: [], error: "not used in this test" }),
    lookupHillsboroughPermits: async () => [],
    lookupPinellasPermits: async () => [],
    runTier: async () => ({ ok: false, engine: "lmstudio", error: "not used in this test" }),
    allowLive: opts.allowLive ?? true,
  };
  return { deps, signals, writes };
}

const company: CompanySignalInput = { id: "co_1", google_place_id: "place_123" };

test("no google_place_id — skips, never calls Places", async () => {
  const { deps } = depsFor({});
  const r = await runReviewVelocityCheck({ id: "co_1" }, deps);
  assert.equal(r.ran, false);
  assert.equal(r.skippedReason, "no google_place_id");
});

test("shadow mode (allowLive=false): skips the paid call, no crash, no signal", async () => {
  const { deps, signals } = depsFor({ allowLive: false });
  const r = await runReviewVelocityCheck(company, deps);
  assert.equal(r.ran, false);
  assert.equal(r.skippedReason, "shadow_mode");
  assert.equal(signals.length, 0);
});

test("missing historical snapshots (first-ever check): writes a baseline snapshot, no signal, no crash", async () => {
  const { deps, signals, writes } = depsFor({ history: [] });
  const r = await runReviewVelocityCheck(company, deps);
  assert.equal(r.ran, true);
  assert.equal(r.signalFired, false);
  assert.equal(signals.length, 0);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].fieldName, REVIEW_SNAPSHOT_FIELD);
});

test("only a 90d-ago snapshot exists (no 30d-ago) -> graceful no-signal, not a crash", async () => {
  const { deps, signals } = depsFor({ history: [snapshotFact(90, 100)] });
  const r = await runReviewVelocityCheck(company, deps);
  assert.equal(r.signalFired, false);
  assert.equal(signals.length, 0);
});

test("reviewVelocityStrength: exactly 20% is HIGH (the plan's one precisely-specified rule)", () => {
  const tier = reviewVelocityStrength(0.2);
  assert.deepEqual(tier, { strength: "high", scoreDelta: REVIEW_VELOCITY_SCORE_DELTA_HIGH });
});

test("reviewVelocityStrength: just under 20% (19.999%) is NOT high", () => {
  const tier = reviewVelocityStrength(0.19999);
  assert.notEqual(tier?.strength, "high");
});

test("reviewVelocityStrength: 5% is medium, just under 5% is undefined (no signal)", () => {
  assert.deepEqual(reviewVelocityStrength(0.05), { strength: "medium", scoreDelta: REVIEW_VELOCITY_SCORE_DELTA_MEDIUM });
  assert.equal(reviewVelocityStrength(0.0499), undefined);
});

test("reviewVelocityStrength: 0% or negative is undefined", () => {
  assert.equal(reviewVelocityStrength(0), undefined);
  assert.equal(reviewVelocityStrength(-0.5), undefined);
});

test("full run: 90d delta exactly 20% (100 -> 120) fires HIGH with the exact registered score_delta", async () => {
  const history = [snapshotFact(30, 110), snapshotFact(90, 100)];
  const { deps, signals } = depsFor({ history, placeResult: { ok: true, rating: 4.6, userRatingCount: 120 } });
  const r = await runReviewVelocityCheck(company, deps);
  assert.equal(r.signalFired, true);
  assert.equal(signals.length, 1);
  assert.equal(signals[0].signalType, "review_velocity");
  assert.equal(signals[0].strength, "high");
  assert.equal(signals[0].scoreDelta, REVIEW_VELOCITY_SCORE_DELTA_HIGH);
  assert.equal(REVIEW_VELOCITY_HIGH_THRESHOLD, 0.2); // the boundary this test sits exactly on
});

test("full run: 90d delta just under 20% (119 vs 100 = 19%) does NOT fire high — fires medium instead", async () => {
  const history = [snapshotFact(30, 110), snapshotFact(90, 100)];
  const { deps, signals } = depsFor({ history, placeResult: { ok: true, userRatingCount: 119 } });
  const r = await runReviewVelocityCheck(company, deps);
  assert.equal(r.signalFired, true);
  assert.equal(signals[0].strength, "medium");
  assert.equal(signals[0].scoreDelta, REVIEW_VELOCITY_SCORE_DELTA_MEDIUM);
});

test("full run: small positive delta below the medium threshold does not fire", async () => {
  const history = [snapshotFact(30, 102), snapshotFact(90, 100)];
  const { deps, signals } = depsFor({ history, placeResult: { ok: true, userRatingCount: 102 } }); // 2% over 90d
  const r = await runReviewVelocityCheck(company, deps);
  assert.equal(r.signalFired, false);
  assert.equal(signals.length, 0);
});

test("full run: flat/declining review count never fires", async () => {
  const history = [snapshotFact(30, 100), snapshotFact(90, 100)];
  const { deps, signals } = depsFor({ history, placeResult: { ok: true, userRatingCount: 95 } });
  const r = await runReviewVelocityCheck(company, deps);
  assert.equal(r.signalFired, false);
  assert.equal(signals.length, 0);
});

test("90d-ago snapshot of 0 reviews is handled without a divide-by-zero crash", async () => {
  const history = [snapshotFact(30, 5), snapshotFact(90, 0)];
  const { deps, signals } = depsFor({ history, placeResult: { ok: true, userRatingCount: 20 } });
  const r = await runReviewVelocityCheck(company, deps);
  assert.equal(r.signalFired, false);
  assert.equal(signals.length, 0);
});

test("closestSnapshot picks the historical row nearest the target date, within tolerance", () => {
  const history = [snapshotFact(28, 50), snapshotFact(32, 55), snapshotFact(200, 10)];
  const snap = closestSnapshot(history, NOW, 30);
  assert.ok(snap);
  // 28 and 32 are each 2 days from the 30-day target; whichever the implementation treats as
  // "closest," it must come from one of the two near rows, never the 200-day-old outlier.
  assert.ok(snap!.reviewCount === 50 || snap!.reviewCount === 55);
});

test("closestSnapshot returns undefined when nothing is within tolerance of the target", () => {
  const history = [snapshotFact(60, 50)]; // 30 days off the 90-day target — outside +/-5d tolerance
  assert.equal(closestSnapshot(history, NOW, 90), undefined);
});

test("Places API error is a graceful skip, not a crash", async () => {
  const { deps, signals } = depsFor({ placeResult: { ok: false, error: "Places API 404" } });
  const r = await runReviewVelocityCheck(company, deps);
  assert.equal(r.ran, false);
  assert.equal(r.skippedReason, "places_unavailable");
  assert.equal(signals.length, 0);
});
