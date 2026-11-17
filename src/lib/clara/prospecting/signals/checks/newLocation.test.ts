import { test } from "node:test";
import assert from "node:assert/strict";
import { runNewLocationCheck, isLikelySameCompany, diffNewPlaceIds, KNOWN_PLACE_IDS_FIELD, NEW_LOCATION_SCORE_DELTA } from "./newLocation";
import type { CompanyFactRow } from "../../osBridge";
import type { CompanySignalInput, SignalRunDeps } from "../types";
import type { BusinessCandidate } from "../../../places";

const NOW = new Date("2026-10-01T12:00:00Z");

interface SignalCall { signalType: string; scoreDelta: number; strength?: string }

function depsFor(opts: {
  existing?: CompanyFactRow[];
  candidates?: BusinessCandidate[];
  findOk?: boolean;
  allowLive?: boolean;
}): { deps: SignalRunDeps; signals: SignalCall[]; writes: { fieldName: string; value: string }[] } {
  const signals: SignalCall[] = [];
  const writes: { fieldName: string; value: string }[] = [];
  const deps: SignalRunDeps = {
    now: () => NOW,
    factsList: async () => opts.existing ?? [],
    writeLastCheckedFact: async (input) => {
      writes.push({ fieldName: input.fieldName, value: input.value });
    },
    fireSignal: async (input) => {
      signals.push({ signalType: input.signalType, scoreDelta: input.scoreDelta, strength: input.strength });
      return { signal: {} };
    },
    crawlPage: (async () => ({ ok: false, url: "", costUsd: 0 })) as SignalRunDeps["crawlPage"],
    readFile: async () => "",
    cachedCall: (async (args: { allowLive: boolean; fn: () => Promise<unknown> }) => {
      if (!args.allowLive) return { cached: false, skipped: true, costUsd: 0 };
      const value = await args.fn();
      return { value, cached: false, costUsd: 0.035 };
    }) as SignalRunDeps["cachedCall"],
    getPlaceDetails: async () => ({ ok: true }),
    webSearch: async () => ({ ok: false, results: [], error: "not used in this test" }),
    findBusiness: async () => ({ ok: opts.findOk ?? true, candidates: opts.candidates ?? [] }),
    lookupHillsboroughPermits: async () => [],
    lookupPinellasPermits: async () => [],
    runTier: async () => ({ ok: false, engine: "lmstudio", error: "not used in this test" }),
    allowLive: opts.allowLive ?? true,
  };
  return { deps, signals, writes };
}

const company: CompanySignalInput = { id: "co_1", name: "Acme Roofing", state: "FL" };

// ── isLikelySameCompany — name-similarity filtering ───────────────────────────────────────────

test("isLikelySameCompany: identical names match", () => {
  assert.equal(isLikelySameCompany("Acme Roofing", "Acme Roofing"), true);
});

test("isLikelySameCompany: a branch-location variant (one contains the other) matches", () => {
  assert.equal(isLikelySameCompany("Acme Roofing", "Acme Roofing of Tampa"), true);
});

test("isLikelySameCompany: unrelated business names do NOT match", () => {
  assert.equal(isLikelySameCompany("Acme Roofing", "Joe's Plumbing"), false);
});

test("isLikelySameCompany: shares only a short/common first token -> does not match", () => {
  assert.equal(isLikelySameCompany("A Roofing Co", "A Plumbing Co"), false);
});

// ── diffNewPlaceIds — pure set diff ──────────────────────────────────────────────────────────

test("diffNewPlaceIds: no prior ids -> everything found is new, allIds is the full found set", () => {
  const d = diffNewPlaceIds([], ["p1", "p2"]);
  assert.deepEqual(d.newIds.sort(), ["p1", "p2"]);
  assert.deepEqual(d.allIds, ["p1", "p2"]);
});

test("diffNewPlaceIds: an already-known id is NOT reported as new", () => {
  const d = diffNewPlaceIds(["p1"], ["p1"]);
  assert.deepEqual(d.newIds, []);
  assert.deepEqual(d.allIds, ["p1"]);
});

test("diffNewPlaceIds: a mix of known and new ids reports only the genuinely new ones", () => {
  const d = diffNewPlaceIds(["p1"], ["p1", "p2"]);
  assert.deepEqual(d.newIds, ["p2"]);
  assert.deepEqual(d.allIds.sort(), ["p1", "p2"]);
});

// ── runNewLocationCheck ───────────────────────────────────────────────────────────────────────

test("no company name — skips cleanly", async () => {
  const { deps } = depsFor({});
  const r = await runNewLocationCheck({ id: "co_1" }, deps);
  assert.equal(r.ran, false);
  assert.equal(r.skippedReason, "no_company_name");
});

test("first-ever scan: baseline only, no signal even with multiple candidates on file", async () => {
  const { deps, signals, writes } = depsFor({
    existing: [],
    candidates: [{ placeId: "p1", name: "Acme Roofing" }, { placeId: "p2", name: "Acme Roofing of Tampa" }],
  });
  const r = await runNewLocationCheck(company, deps);
  assert.equal(r.ran, true);
  assert.equal(r.changed, false);
  assert.equal(r.signalFired, false);
  assert.equal(signals.length, 0);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].fieldName, KNOWN_PLACE_IDS_FIELD);
  assert.deepEqual(JSON.parse(writes[0].value).sort(), ["p1", "p2"]);
});

test("a genuinely new place_id (not in the known set) triggers +10", async () => {
  const existing: CompanyFactRow[] = [{ id: "f1", field_name: KNOWN_PLACE_IDS_FIELD, value: JSON.stringify(["p1"]), source_type: "places" }];
  const { deps, signals } = depsFor({
    existing,
    candidates: [{ placeId: "p1", name: "Acme Roofing" }, { placeId: "p2", name: "Acme Roofing of Clearwater" }],
  });
  const r = await runNewLocationCheck(company, deps);
  assert.equal(r.changed, true);
  assert.equal(r.signalFired, true);
  assert.equal(signals.length, 1);
  assert.equal(signals[0].signalType, "new_location");
  assert.equal(signals[0].scoreDelta, NEW_LOCATION_SCORE_DELTA);
});

test("an already-known place_id does NOT trigger a signal", async () => {
  const existing: CompanyFactRow[] = [{ id: "f1", field_name: KNOWN_PLACE_IDS_FIELD, value: JSON.stringify(["p1"]), source_type: "places" }];
  const { deps, signals } = depsFor({ existing, candidates: [{ placeId: "p1", name: "Acme Roofing" }] });
  const r = await runNewLocationCheck(company, deps);
  assert.equal(r.changed, false);
  assert.equal(r.signalFired, false);
  assert.equal(signals.length, 0);
});

test("name-similarity filtering excludes unrelated businesses Places happened to also return", async () => {
  const existing: CompanyFactRow[] = [{ id: "f1", field_name: KNOWN_PLACE_IDS_FIELD, value: JSON.stringify(["p1"]), source_type: "places" }];
  const { deps, signals, writes } = depsFor({
    existing,
    candidates: [{ placeId: "p1", name: "Acme Roofing" }, { placeId: "p_unrelated", name: "Totally Different Plumbing LLC" }],
  });
  const r = await runNewLocationCheck(company, deps);
  assert.equal(r.signalFired, false, "the unrelated business must not count as a new location");
  assert.equal(signals.length, 0);
  assert.deepEqual(JSON.parse(writes[0].value), ["p1"], "the unrelated candidate's place_id is never even written to known_place_ids");
});

test("Places Text Search unavailable -> graceful skip, not a crash", async () => {
  const { deps } = depsFor({ findOk: false });
  const r = await runNewLocationCheck(company, deps);
  assert.equal(r.ran, false);
  assert.equal(r.skippedReason, "places_unavailable");
});

test("shadow mode: Places Text Search call skipped, no crash", async () => {
  const { deps } = depsFor({ allowLive: false });
  const r = await runNewLocationCheck(company, deps);
  assert.equal(r.ran, false);
  assert.equal(r.skippedReason, "shadow_mode");
});
