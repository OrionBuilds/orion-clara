import { test } from "node:test";
import assert from "node:assert/strict";
import { runPermitGrowthCheck, computePermitWindowCounts, LAST_PERMIT_SCAN_FIELD, PERMIT_GROWTH_SCORE_DELTA } from "./permitGrowth";
import type { CompanyFactRow } from "../../osBridge";
import type { CompanySignalInput, SignalRunDeps } from "../types";
import type { PermitRecord } from "../../publicdata/types";

const NOW = new Date("2026-10-01T12:00:00Z");

interface SignalCall { signalType: string; scoreDelta: number }

function daysAgo(n: number): string {
  return new Date(NOW.getTime() - n * 24 * 3600_000).toISOString().slice(0, 10);
}

function permit(issueDate: string | undefined, jurisdiction: "hillsborough" | "pinellas" = "hillsborough"): PermitRecord {
  return { permitNumber: `p-${issueDate ?? "undated"}-${Math.random()}`, jurisdiction, issueDate };
}

function depsFor(opts: {
  existing?: CompanyFactRow[];
  dbprFacts?: CompanyFactRow[];
  hillsboroughPermits?: PermitRecord[];
  pinellasPermits?: PermitRecord[];
  hillsboroughThrows?: boolean;
}): { deps: SignalRunDeps; signals: SignalCall[]; writes: { fieldName: string; value: string }[]; hillsboroughCalls: string[]; pinellasCalls: string[] } {
  const signals: SignalCall[] = [];
  const writes: { fieldName: string; value: string }[] = [];
  const hillsboroughCalls: string[] = [];
  const pinellasCalls: string[] = [];
  const deps: SignalRunDeps = {
    now: () => NOW,
    factsList: async ({ field_name }) => {
      if (field_name === "dbpr_license") return opts.dbprFacts ?? [];
      if (field_name === LAST_PERMIT_SCAN_FIELD) return opts.existing ?? [];
      return [];
    },
    writeLastCheckedFact: async (input) => {
      writes.push({ fieldName: input.fieldName, value: input.value });
    },
    fireSignal: async (input) => {
      signals.push({ signalType: input.signalType, scoreDelta: input.scoreDelta });
      return { signal: {} };
    },
    crawlPage: (async () => ({ ok: false, url: "", costUsd: 0 })) as SignalRunDeps["crawlPage"],
    readFile: async () => "",
    cachedCall: (async () => ({ cached: false, costUsd: 0 })) as SignalRunDeps["cachedCall"],
    getPlaceDetails: async () => ({ ok: true }),
    webSearch: async () => ({ ok: false, results: [], error: "not used in this test" }),
    findBusiness: async () => ({ ok: false, candidates: [], error: "not used in this test" }),
    lookupHillsboroughPermits: async (term: string) => {
      hillsboroughCalls.push(term);
      if (opts.hillsboroughThrows) throw new Error("service unavailable");
      return opts.hillsboroughPermits ?? [];
    },
    lookupPinellasPermits: async (term: string) => {
      pinellasCalls.push(term);
      return opts.pinellasPermits ?? [];
    },
    runTier: async () => ({ ok: false, engine: "lmstudio", error: "not used in this test" }),
    allowLive: true,
  };
  return { deps, signals, writes, hillsboroughCalls, pinellasCalls };
}

const tampaCompany: CompanySignalInput = { id: "co_1", name: "Acme Roofing", city: "Tampa" };

// ── computePermitWindowCounts ─────────────────────────────────────────────────────────────────

test("computePermitWindowCounts: buckets correctly into trailing-30d vs prior-30d", () => {
  const permits: PermitRecord[] = [permit(daysAgo(5)), permit(daysAgo(10)), permit(daysAgo(45)), permit(daysAgo(70))];
  const r = computePermitWindowCounts(permits, NOW.getTime());
  assert.equal(r.recentCount, 2);
  assert.equal(r.priorCount, 1); // only the 45-day-old one; 70 days is outside the 2nd window
  assert.equal(r.undated, 0);
});

test("computePermitWindowCounts: undated permits are excluded from both windows, counted separately", () => {
  const permits: PermitRecord[] = [permit(undefined), permit(daysAgo(5))];
  const r = computePermitWindowCounts(permits, NOW.getTime());
  assert.equal(r.recentCount, 1);
  assert.equal(r.undated, 1);
});

test("computePermitWindowCounts: unparseable issueDate string is treated as undated, not a crash", () => {
  const permits: PermitRecord[] = [permit("not-a-date")];
  const r = computePermitWindowCounts(permits, NOW.getTime());
  assert.equal(r.undated, 1);
  assert.equal(r.recentCount, 0);
});

// ── runPermitGrowthCheck ──────────────────────────────────────────────────────────────────────

test("out-of-county company — graceful skip, not an error", async () => {
  const { deps, hillsboroughCalls, pinellasCalls } = depsFor({});
  const r = await runPermitGrowthCheck({ id: "co_1", name: "Acme Roofing", city: "Orlando" }, deps);
  assert.equal(r.ran, false);
  assert.equal(r.skippedReason, "not_in_covered_county");
  assert.equal(hillsboroughCalls.length, 0);
  assert.equal(pinellasCalls.length, 0);
});

test("no city at all — treated the same as out-of-county, graceful skip", async () => {
  const { deps } = depsFor({});
  const r = await runPermitGrowthCheck({ id: "co_1", name: "Acme Roofing" }, deps);
  assert.equal(r.ran, false);
  assert.equal(r.skippedReason, "not_in_covered_county");
});

test("no DBPR license on file — falls back gracefully to searching by company name", async () => {
  const { deps, hillsboroughCalls } = depsFor({ dbprFacts: [], hillsboroughPermits: [] });
  const r = await runPermitGrowthCheck(tampaCompany, deps);
  assert.equal(r.ran, true);
  assert.deepEqual(hillsboroughCalls, ["Acme Roofing"]);
});

test("a DBPR license on file is preferred as the search term over the bare company name", async () => {
  const { deps, hillsboroughCalls } = depsFor({
    dbprFacts: [{ id: "f1", field_name: "dbpr_license", value: "CCC1234567", source_type: "dbpr" }],
    hillsboroughPermits: [],
  });
  await runPermitGrowthCheck(tampaCompany, deps);
  assert.deepEqual(hillsboroughCalls, ["CCC1234567"]);
});

test("first-ever scan: baseline only, no signal even with a positive-looking delta", async () => {
  const { deps, signals, writes } = depsFor({
    existing: [],
    hillsboroughPermits: [permit(daysAgo(5)), permit(daysAgo(10))],
  });
  const r = await runPermitGrowthCheck(tampaCompany, deps);
  assert.equal(r.ran, true);
  assert.equal(r.changed, false);
  assert.equal(r.signalFired, false);
  assert.equal(signals.length, 0);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].fieldName, LAST_PERMIT_SCAN_FIELD);
});

test("a positive 30-day delta (not baseline) triggers +6", async () => {
  const existing: CompanyFactRow[] = [{ id: "f1", field_name: LAST_PERMIT_SCAN_FIELD, value: JSON.stringify({ recentCount: 0, priorCount: 0 }), source_type: "permit" }];
  const { deps, signals } = depsFor({
    existing,
    hillsboroughPermits: [permit(daysAgo(5)), permit(daysAgo(10)), permit(daysAgo(15))],
  });
  const r = await runPermitGrowthCheck(tampaCompany, deps);
  assert.equal(r.changed, true);
  assert.equal(r.signalFired, true);
  assert.equal(signals.length, 1);
  assert.equal(signals[0].signalType, "permit");
  assert.equal(signals[0].scoreDelta, PERMIT_GROWTH_SCORE_DELTA);
});

test("a flat delta (recent == prior) does NOT trigger", async () => {
  const existing: CompanyFactRow[] = [{ id: "f1", field_name: LAST_PERMIT_SCAN_FIELD, value: JSON.stringify({ recentCount: 2, priorCount: 2 }), source_type: "permit" }];
  const { deps, signals } = depsFor({
    existing,
    hillsboroughPermits: [permit(daysAgo(5)), permit(daysAgo(10)), permit(daysAgo(45)), permit(daysAgo(50))],
  });
  const r = await runPermitGrowthCheck(tampaCompany, deps);
  assert.equal(r.signalFired, false);
  assert.equal(signals.length, 0);
});

test("a negative delta (recent < prior) does NOT trigger", async () => {
  const existing: CompanyFactRow[] = [{ id: "f1", field_name: LAST_PERMIT_SCAN_FIELD, value: JSON.stringify({ recentCount: 5, priorCount: 5 }), source_type: "permit" }];
  const { deps, signals } = depsFor({
    existing,
    hillsboroughPermits: [permit(daysAgo(5)), permit(daysAgo(45)), permit(daysAgo(50)), permit(daysAgo(55))],
  });
  const r = await runPermitGrowthCheck(tampaCompany, deps);
  assert.equal(r.signalFired, false);
  assert.equal(signals.length, 0);
});

test("zero recent permits never fires even if that's technically > a negative prior-window count", async () => {
  const existing: CompanyFactRow[] = [{ id: "f1", field_name: LAST_PERMIT_SCAN_FIELD, value: JSON.stringify({ recentCount: 0, priorCount: 0 }), source_type: "permit" }];
  const { deps, signals } = depsFor({ existing, hillsboroughPermits: [] });
  const r = await runPermitGrowthCheck(tampaCompany, deps);
  assert.equal(r.signalFired, false);
  assert.equal(signals.length, 0);
});

test("permit lookup failure (adapter throws) — graceful skip, not a crash", async () => {
  const { deps } = depsFor({ hillsboroughThrows: true });
  const r = await runPermitGrowthCheck(tampaCompany, deps);
  assert.equal(r.ran, false);
  assert.equal(r.skippedReason, "lookup_failed");
});

test("Pinellas company routes to the Pinellas adapter, not Hillsborough", async () => {
  const { deps, hillsboroughCalls, pinellasCalls } = depsFor({ pinellasPermits: [] });
  await runPermitGrowthCheck({ id: "co_2", name: "Beta Roofing", city: "Clearwater" }, deps);
  assert.equal(hillsboroughCalls.length, 0);
  assert.equal(pinellasCalls.length, 1);
});
