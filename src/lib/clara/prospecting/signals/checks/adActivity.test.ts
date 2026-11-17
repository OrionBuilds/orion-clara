import { test } from "node:test";
import assert from "node:assert/strict";
import {
  runAdActivityCheck, checkMetaAdLibrary, braveAdLikeHit, metaAdLibraryConfigured,
  AD_ACTIVITY_SCORE_DELTA, AD_ACTIVITY_HASH_FIELD, TECH_ADS_FIELD,
} from "./adActivity";
import type { CompanyFactRow } from "../../osBridge";
import type { CompanySignalInput, SignalRunDeps } from "../types";
import type { WebSearchResult } from "../../../brave-search";

const NOW = new Date("2026-10-01T12:00:00Z");

interface SignalCall { signalType: string; scoreDelta: number }

function depsFor(opts: {
  existing?: CompanyFactRow[];
  techAdsFacts?: CompanyFactRow[];
  braveResults?: WebSearchResult[];
  braveOk?: boolean;
  allowLive?: boolean;
}): { deps: SignalRunDeps; signals: SignalCall[]; writes: { fieldName: string; value: string }[] } {
  const signals: SignalCall[] = [];
  const writes: { fieldName: string; value: string }[] = [];
  const deps: SignalRunDeps = {
    now: () => NOW,
    factsList: async ({ field_name }) => {
      if (field_name === TECH_ADS_FIELD) return opts.techAdsFacts ?? [];
      if (field_name === AD_ACTIVITY_HASH_FIELD) return opts.existing ?? [];
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
    cachedCall: (async (args: { allowLive: boolean; fn: () => Promise<unknown> }) => {
      if (!args.allowLive) return { cached: false, skipped: true, costUsd: 0 };
      const value = await args.fn();
      return { value, cached: false, costUsd: 0.005 };
    }) as SignalRunDeps["cachedCall"],
    getPlaceDetails: async () => ({ ok: true }),
    webSearch: async () => ({ ok: opts.braveOk ?? true, results: opts.braveResults ?? [] }),
    findBusiness: async () => ({ ok: false, candidates: [], error: "not used in this test" }),
    lookupHillsboroughPermits: async () => [],
    lookupPinellasPermits: async () => [],
    runTier: async () => ({ ok: false, engine: "lmstudio", error: "not used in this test" }),
    allowLive: opts.allowLive ?? true,
  };
  return { deps, signals, writes };
}

const company: CompanySignalInput = { id: "co_1", name: "Acme Roofing", city: "Tampa", website_url: "https://acme.com" };

// ── checkMetaAdLibrary — the plan's named "Meta Ad Library graceful degradation" requirement ────

test("checkMetaAdLibrary: no token configured -> graceful degrade, no network call attempted", async () => {
  const prevToken = process.env.CLARA_META_AD_LIBRARY_TOKEN;
  delete process.env.CLARA_META_AD_LIBRARY_TOKEN;
  try {
    let fetchCalled = false;
    const r = await checkMetaAdLibrary("Acme Roofing", { fetchJson: async () => { fetchCalled = true; return {}; } });
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /access_token/);
    assert.equal(fetchCalled, false, "no network call should be attempted without a configured token");
  } finally {
    if (prevToken === undefined) delete process.env.CLARA_META_AD_LIBRARY_TOKEN; else process.env.CLARA_META_AD_LIBRARY_TOKEN = prevToken;
  }
});

test("checkMetaAdLibrary: token configured, API returns ads -> hasActiveAds true", async () => {
  const prevToken = process.env.CLARA_META_AD_LIBRARY_TOKEN;
  process.env.CLARA_META_AD_LIBRARY_TOKEN = "fake-token";
  try {
    const r = await checkMetaAdLibrary("Acme Roofing", { fetchJson: async () => ({ data: [{ id: "1" }] }) });
    assert.equal(r.ok, true);
    assert.equal(r.hasActiveAds, true);
  } finally {
    if (prevToken === undefined) delete process.env.CLARA_META_AD_LIBRARY_TOKEN; else process.env.CLARA_META_AD_LIBRARY_TOKEN = prevToken;
  }
});

test("checkMetaAdLibrary: token configured, fetch throws -> graceful error, not a crash", async () => {
  const prevToken = process.env.CLARA_META_AD_LIBRARY_TOKEN;
  process.env.CLARA_META_AD_LIBRARY_TOKEN = "fake-token";
  try {
    const r = await checkMetaAdLibrary("Acme Roofing", { fetchJson: async () => { throw new Error("network down"); } });
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /network down/);
  } finally {
    if (prevToken === undefined) delete process.env.CLARA_META_AD_LIBRARY_TOKEN; else process.env.CLARA_META_AD_LIBRARY_TOKEN = prevToken;
  }
});

test("metaAdLibraryConfigured reflects the env var", () => {
  const prevToken = process.env.CLARA_META_AD_LIBRARY_TOKEN;
  try {
    delete process.env.CLARA_META_AD_LIBRARY_TOKEN;
    assert.equal(metaAdLibraryConfigured(), false);
    process.env.CLARA_META_AD_LIBRARY_TOKEN = "x";
    assert.equal(metaAdLibraryConfigured(), true);
  } finally {
    if (prevToken === undefined) delete process.env.CLARA_META_AD_LIBRARY_TOKEN; else process.env.CLARA_META_AD_LIBRARY_TOKEN = prevToken;
  }
});

// ── braveAdLikeHit — the plan's named "ad detection patterns" heuristic, honestly weak ──────────

test("braveAdLikeHit: a result on the company's own domain with promo CTA language -> hit", () => {
  const results: WebSearchResult[] = [{ title: "Get a Free Quote Today", url: "https://acme.com/roofing", snippet: "Call now for a free estimate" }];
  assert.equal(braveAdLikeHit(results, "acme.com"), true);
});

test("braveAdLikeHit: promo language but on a DIFFERENT domain -> no hit", () => {
  const results: WebSearchResult[] = [{ title: "Get a Free Quote Today", url: "https://otherguy.com/x" }];
  assert.equal(braveAdLikeHit(results, "acme.com"), false);
});

test("braveAdLikeHit: own domain but no promo language -> no hit", () => {
  const results: WebSearchResult[] = [{ title: "About Us", url: "https://acme.com/about" }];
  assert.equal(braveAdLikeHit(results, "acme.com"), false);
});

test("braveAdLikeHit: no domain to compare against -> always false", () => {
  assert.equal(braveAdLikeHit([{ title: "x", url: "https://acme.com" }], undefined), false);
});

// ── runAdActivityCheck — combination logic ───────────────────────────────────────────────────

test("no company name — skips cleanly", async () => {
  const { deps } = depsFor({});
  const r = await runAdActivityCheck({ id: "co_1" }, deps);
  assert.equal(r.ran, false);
  assert.equal(r.skippedReason, "no_company_name");
});

test("first-ever scan: baseline only, no signal even if active", async () => {
  const { deps, signals, writes } = depsFor({
    existing: [],
    techAdsFacts: [{ id: "f1", field_name: TECH_ADS_FIELD, value: "Meta Pixel", source_type: "website_script" }],
  });
  const r = await runAdActivityCheck(company, deps);
  assert.equal(r.ran, true);
  assert.equal(r.signalFired, false);
  assert.equal(signals.length, 0);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].fieldName, AD_ACTIVITY_HASH_FIELD);
});

test("input 1 (tech-detect pixel fact) alone drives active -> fires on transition from baseline", async () => {
  const existing: CompanyFactRow[] = [{ id: "f1", field_name: AD_ACTIVITY_HASH_FIELD, value: JSON.stringify({ active: false, pixel: false, meta: false, brave: false }), source_type: "derived" }];
  const { deps, signals } = depsFor({
    existing,
    techAdsFacts: [{ id: "f2", field_name: TECH_ADS_FIELD, value: "Google Ads", source_type: "website_script" }],
  });
  const r = await runAdActivityCheck(company, deps);
  assert.equal(r.signalFired, true);
  assert.equal(signals[0].signalType, "ad_started");
  assert.equal(signals[0].scoreDelta, AD_ACTIVITY_SCORE_DELTA);
});

test("input 2 (Meta Ad Library) alone drives active", async () => {
  const prevToken = process.env.CLARA_META_AD_LIBRARY_TOKEN;
  process.env.CLARA_META_AD_LIBRARY_TOKEN = "fake-token";
  // Monkeypatch global fetch for this test only, since checkMetaAdLibrary's default dep uses it.
  const realFetch = global.fetch;
  global.fetch = (async () => ({ ok: true, json: async () => ({ data: [{ id: "1" }] }) })) as unknown as typeof fetch;
  try {
    const existing: CompanyFactRow[] = [{ id: "f1", field_name: AD_ACTIVITY_HASH_FIELD, value: JSON.stringify({ active: false, pixel: false, meta: false, brave: false }), source_type: "derived" }];
    const { deps, signals } = depsFor({ existing });
    const r = await runAdActivityCheck(company, deps);
    assert.equal(r.signalFired, true);
  } finally {
    global.fetch = realFetch;
    if (prevToken === undefined) delete process.env.CLARA_META_AD_LIBRARY_TOKEN; else process.env.CLARA_META_AD_LIBRARY_TOKEN = prevToken;
  }
});

test("input 3 (brave ad-like heuristic) alone drives active", async () => {
  const existing: CompanyFactRow[] = [{ id: "f1", field_name: AD_ACTIVITY_HASH_FIELD, value: JSON.stringify({ active: false, pixel: false, meta: false, brave: false }), source_type: "derived" }];
  const { deps, signals } = depsFor({
    existing,
    braveResults: [{ title: "Get a Free Quote Today", url: "https://acme.com/roofing", snippet: "Call now" }],
  });
  const r = await runAdActivityCheck(company, deps);
  assert.equal(r.signalFired, true);
  assert.equal(signals[0].scoreDelta, AD_ACTIVITY_SCORE_DELTA);
});

test("none of the 3 inputs hit -> not active, no signal", async () => {
  const { deps, signals } = depsFor({ existing: [{ id: "f1", field_name: AD_ACTIVITY_HASH_FIELD, value: JSON.stringify({ active: false, pixel: false, meta: false, brave: false }), source_type: "derived" }] });
  const r = await runAdActivityCheck(company, deps);
  assert.equal(r.signalFired, false);
  assert.equal(signals.length, 0);
});

test("already active last scan -> stays active this scan -> does NOT refire (no duplicate weekly bump)", async () => {
  const existing: CompanyFactRow[] = [{ id: "f1", field_name: AD_ACTIVITY_HASH_FIELD, value: JSON.stringify({ active: true, pixel: true, meta: false, brave: false }), source_type: "derived" }];
  const { deps, signals } = depsFor({
    existing,
    techAdsFacts: [{ id: "f2", field_name: TECH_ADS_FIELD, value: "Meta Pixel", source_type: "website_script" }],
  });
  const r = await runAdActivityCheck(company, deps);
  assert.equal(r.signalFired, false, "still active, not a fresh transition -> no refire");
  assert.equal(signals.length, 0);
});
