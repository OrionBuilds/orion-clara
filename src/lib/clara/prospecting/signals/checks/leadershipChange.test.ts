import { test } from "node:test";
import assert from "node:assert/strict";
import { runLeadershipChangeCheck, parseLeadershipResponse, leadershipHash, LEADERSHIP_NAMES_FIELD, LEADERSHIP_CHANGE_SCORE_DELTA } from "./leadershipChange";
import type { CompanyFactRow } from "../../osBridge";
import type { CompanySignalInput, SignalRunDeps } from "../types";
import type { CrawlPageResult } from "../../crawler/waterfall";
import type { RunTierResult } from "../../llm";

const NOW = new Date("2026-10-01T12:00:00Z");

interface SignalCall { signalType: string; scoreDelta: number; strength?: string }

function page(url: string, ok = true): CrawlPageResult {
  return ok
    ? { ok: true, url, method: "http", costUsd: 0, evidence: { sha: "s", companyId: "co_1", url, sourceType: "other", txtPath: "/x/team.txt", sourceId: "s1" } }
    : { ok: false, url, costUsd: 0, reason: "all-rungs-failed", error: "every crawl rung failed" };
}

function depsFor(opts: {
  existing?: CompanyFactRow[];
  teamCrawlOk?: boolean;
  teamText?: string;
  llmResult?: RunTierResult;
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
    crawlPage: async (url) => page(url, opts.teamCrawlOk ?? true),
    readFile: async (p) => {
      if (p === "/x/team.txt") return opts.teamText ?? "Jane Doe, Owner. John Smith, General Manager.";
      throw new Error(`no fixture for ${p}`);
    },
    cachedCall: (async () => ({ cached: false, costUsd: 0 })) as SignalRunDeps["cachedCall"],
    getPlaceDetails: async () => ({ ok: true }),
    webSearch: async () => ({ ok: false, results: [], error: "not used in this test" }),
    findBusiness: async () => ({ ok: false, candidates: [], error: "not used in this test" }),
    lookupHillsboroughPermits: async () => [],
    lookupPinellasPermits: async () => [],
    runTier: async () => opts.llmResult ?? { ok: true, engine: "lmstudio", text: '{"people": [{"name": "Jane Doe", "title": "Owner"}]}' },
    allowLive: true,
  };
  return { deps, signals, writes };
}

const company: CompanySignalInput = { id: "co_1", website_url: "https://acme.com" };

// ── parseLeadershipResponse ───────────────────────────────────────────────────────────────────

test("parseLeadershipResponse: valid JSON parsed correctly", () => {
  const people = parseLeadershipResponse('{"people": [{"name": "Jane Doe", "title": "Owner"}]}');
  assert.deepEqual(people, [{ name: "Jane Doe", title: "Owner" }]);
});

test("parseLeadershipResponse: malformed JSON handled gracefully (no throw, empty list)", () => {
  assert.deepEqual(parseLeadershipResponse("not json {{{"), []);
});

test("parseLeadershipResponse: wrong shape handled gracefully", () => {
  assert.deepEqual(parseLeadershipResponse('{"staff": []}'), []);
});

test("parseLeadershipResponse: entries missing a usable name are dropped, not thrown on", () => {
  const people = parseLeadershipResponse('{"people": [{"title": "Owner"}, {"name": "Jane Doe"}]}');
  assert.deepEqual(people, [{ name: "Jane Doe", title: undefined }]);
});

test("leadershipHash is order-independent (sorted before hashing)", () => {
  const a = leadershipHash([{ name: "Jane Doe", title: "Owner" }, { name: "John Smith", title: "GM" }]);
  const b = leadershipHash([{ name: "John Smith", title: "GM" }, { name: "Jane Doe", title: "Owner" }]);
  assert.equal(a, b);
});

// ── runLeadershipChangeCheck ──────────────────────────────────────────────────────────────────

test("no website_url — skips cleanly", async () => {
  const { deps } = depsFor({});
  const r = await runLeadershipChangeCheck({ id: "co_1" }, deps);
  assert.equal(r.ran, false);
  assert.equal(r.skippedReason, "no_website_url");
});

test("no team/about page text available — graceful skip, not a crash", async () => {
  const { deps } = depsFor({ teamCrawlOk: false });
  const r = await runLeadershipChangeCheck(company, deps);
  assert.equal(r.ran, false);
  assert.equal(r.skippedReason, "no_page_text");
});

test("first-ever scan: baseline only, no signal", async () => {
  const { deps, signals, writes } = depsFor({ existing: [] });
  const r = await runLeadershipChangeCheck(company, deps);
  assert.equal(r.ran, true);
  assert.equal(r.changed, false);
  assert.equal(r.signalFired, false);
  assert.equal(signals.length, 0);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].fieldName, LEADERSHIP_NAMES_FIELD);
});

test("a name/title change from last scan triggers the signal", async () => {
  const prevHash = leadershipHash([{ name: "Old Owner", title: "Owner" }]);
  const existing: CompanyFactRow[] = [{ id: "f1", field_name: LEADERSHIP_NAMES_FIELD, value: prevHash, source_type: "website_page" }];
  const { deps, signals } = depsFor({ existing });
  const r = await runLeadershipChangeCheck(company, deps);
  assert.equal(r.changed, true);
  assert.equal(r.signalFired, true);
  assert.equal(signals.length, 1);
  assert.equal(signals[0].signalType, "leadership_change");
  assert.equal(signals[0].scoreDelta, LEADERSHIP_CHANGE_SCORE_DELTA);
});

test("no change from last scan does NOT trigger", async () => {
  const prevHash = leadershipHash([{ name: "Jane Doe", title: "Owner" }]);
  const existing: CompanyFactRow[] = [{ id: "f1", field_name: LEADERSHIP_NAMES_FIELD, value: prevHash, source_type: "website_page" }];
  const { deps, signals } = depsFor({ existing, llmResult: { ok: true, engine: "lmstudio", text: '{"people": [{"name": "Jane Doe", "title": "Owner"}]}' } });
  const r = await runLeadershipChangeCheck(company, deps);
  assert.equal(r.changed, false);
  assert.equal(r.signalFired, false);
  assert.equal(signals.length, 0);
});

test("malformed extraction handled gracefully — no crash, no false signal when the hash still resolves to empty both times", async () => {
  const prevHash = leadershipHash([]);
  const existing: CompanyFactRow[] = [{ id: "f1", field_name: LEADERSHIP_NAMES_FIELD, value: prevHash, source_type: "website_page" }];
  const { deps, signals } = depsFor({ existing, llmResult: { ok: true, engine: "lmstudio", text: "not valid json {{{" } });
  const r = await runLeadershipChangeCheck(company, deps);
  assert.equal(r.ran, true);
  assert.equal(r.changed, false);
  assert.equal(r.signalFired, false);
  assert.equal(signals.length, 0);
});

test("LLM call itself fails (tier down) — graceful, no crash, no false signal", async () => {
  const { deps, signals } = depsFor({ existing: [], llmResult: { ok: false, engine: "lmstudio", error: "tier-1 down" } });
  const r = await runLeadershipChangeCheck(company, deps);
  assert.equal(r.ran, true);
  assert.equal(r.signalFired, false);
  assert.equal(signals.length, 0);
});
