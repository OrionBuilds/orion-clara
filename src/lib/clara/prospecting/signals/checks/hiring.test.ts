import { test } from "node:test";
import assert from "node:assert/strict";
import { runHiringCheck, parseHiringRolesResponse, HIRING_SALES_OPS_SCORE_DELTA, HIRING_GENERIC_SCORE_DELTA, HIRING_LAST_SCAN_FIELD, SALES_OPS_HIRING_REGEX } from "./hiring";
import { hashContent } from "../diff";
import type { CompanyFactRow } from "../../osBridge";
import type { CompanySignalInput, SignalRunDeps } from "../types";
import type { WebSearchResult } from "../../../brave-search";
import type { RunTierResult } from "../../llm";

const NOW = new Date("2026-10-01T12:00:00Z");

interface SignalCall { signalType: string; headline: string; scoreDelta: number; strength?: string }

function depsFor(opts: {
  existing?: CompanyFactRow[];
  braveResults?: WebSearchResult[];
  braveOk?: boolean;
  careersText?: string;
  careersOk?: boolean;
  llmResult?: RunTierResult;
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
      signals.push({ signalType: input.signalType, headline: input.headline, scoreDelta: input.scoreDelta, strength: input.strength });
      return { signal: {} };
    },
    crawlPage: async (url) =>
      opts.careersOk === false
        ? { ok: false, url, costUsd: 0, reason: "all-rungs-failed", error: "every crawl rung failed" }
        : { ok: true, url, method: "http", costUsd: 0, evidence: { sha: "s", companyId: "co_1", url, sourceType: "other", txtPath: "/x/careers.txt", sourceId: "s1" } },
    readFile: async (p) => {
      if (p === "/x/careers.txt") return opts.careersText ?? "";
      throw new Error(`no fixture for ${p}`);
    },
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
    runTier: async () => opts.llmResult ?? { ok: true, engine: "lmstudio", text: '{"roles": []}' },
    allowLive: opts.allowLive ?? true,
  };
  return { deps, signals, writes };
}

const company: CompanySignalInput = { id: "co_1", name: "Acme Roofing", city: "Tampa", website_url: "https://acme.com" };

// ── parseHiringRolesResponse (the plan's named "role extraction" requirement) ──────────────────

test("parseHiringRolesResponse: valid JSON role list parsed correctly", () => {
  const r = parseHiringRolesResponse('{"roles": ["Sales Estimator", "Roofing Technician"]}');
  assert.deepEqual(r.roles, ["Sales Estimator", "Roofing Technician"]);
});

test("parseHiringRolesResponse: malformed JSON handled gracefully (no throw, empty roles)", () => {
  const r = parseHiringRolesResponse("not json at all {{{");
  assert.deepEqual(r.roles, []);
  assert.ok(r.notes.length > 0);
});

test("parseHiringRolesResponse: valid JSON but wrong shape (no roles[]) handled gracefully", () => {
  const r = parseHiringRolesResponse('{"jobs": ["x"]}');
  assert.deepEqual(r.roles, []);
});

test("parseHiringRolesResponse: empty/undefined text handled gracefully", () => {
  assert.deepEqual(parseHiringRolesResponse(undefined).roles, []);
  assert.deepEqual(parseHiringRolesResponse("").roles, []);
});

test("SALES_OPS_HIRING_REGEX matches the OS's own factChangeSignal pattern", () => {
  assert.ok(SALES_OPS_HIRING_REGEX.test("Sales Estimator"));
  assert.ok(SALES_OPS_HIRING_REGEX.test("Operations Manager"));
  assert.ok(SALES_OPS_HIRING_REGEX.test("Project Manager"));
  assert.ok(!SALES_OPS_HIRING_REGEX.test("Roofing Technician"));
  assert.ok(!SALES_OPS_HIRING_REGEX.test("Warehouse Associate"));
});

// ── runHiringCheck ────────────────────────────────────────────────────────────────────────────

test("no company name — skips cleanly, never searches/crawls", async () => {
  const { deps } = depsFor({});
  const r = await runHiringCheck({ id: "co_1" }, deps);
  assert.equal(r.ran, false);
  assert.equal(r.skippedReason, "no_company_name");
});

test("first-ever scan (no prior hash): baseline only, no signal fires even if sales/ops roles found", async () => {
  const { deps, signals, writes } = depsFor({
    existing: [],
    braveResults: [{ title: "Sales Estimator - Acme Roofing", url: "https://indeed.com/x", snippet: "Hiring now" }],
  });
  const r = await runHiringCheck(company, deps);
  assert.equal(r.ran, true);
  assert.equal(r.changed, false);
  assert.equal(r.signalFired, false);
  assert.equal(signals.length, 0);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].fieldName, HIRING_LAST_SCAN_FIELD);
});

test("sales/ops-relevant hiring change triggers the +8 bump", async () => {
  const prevHash = hashContent(JSON.stringify([]));
  const existing: CompanyFactRow[] = [{ id: "f1", field_name: HIRING_LAST_SCAN_FIELD, value: prevHash, source_type: "job_post" }];
  const { deps, signals } = depsFor({
    existing,
    braveResults: [{ title: "Sales Estimator - Acme Roofing", url: "https://indeed.com/x", snippet: "Hiring now" }],
    llmResult: { ok: true, engine: "lmstudio", text: '{"roles": ["Sales Estimator"]}' },
  });
  const r = await runHiringCheck(company, deps);
  assert.equal(r.changed, true);
  assert.equal(r.signalFired, true);
  assert.equal(signals.length, 1);
  assert.equal(signals[0].signalType, "hiring");
  assert.equal(signals[0].scoreDelta, HIRING_SALES_OPS_SCORE_DELTA);
  assert.equal(signals[0].strength, "high");
});

test("a non-matching (generic) hiring change does NOT trigger the +8 bump — fires at the smaller generic delta instead", async () => {
  const prevHash = hashContent(JSON.stringify([]));
  const existing: CompanyFactRow[] = [{ id: "f1", field_name: HIRING_LAST_SCAN_FIELD, value: prevHash, source_type: "job_post" }];
  const { deps, signals } = depsFor({
    existing,
    careersText: "Now hiring: Warehouse Associate. Apply today!",
    llmResult: { ok: true, engine: "lmstudio", text: '{"roles": ["Warehouse Associate"]}' },
  });
  const r = await runHiringCheck(company, deps);
  assert.equal(r.signalFired, true);
  assert.equal(signals[0].scoreDelta, HIRING_GENERIC_SCORE_DELTA);
  assert.notEqual(signals[0].scoreDelta, HIRING_SALES_OPS_SCORE_DELTA);
  assert.equal(signals[0].strength, "medium");
});

test("malformed LLM JSON handled gracefully — no crash, no false signal", async () => {
  const prevHash = hashContent(JSON.stringify(["old role"]));
  const existing: CompanyFactRow[] = [{ id: "f1", field_name: HIRING_LAST_SCAN_FIELD, value: prevHash, source_type: "job_post" }];
  const { deps, signals, writes } = depsFor({
    existing,
    braveResults: [{ title: "Some job", url: "https://indeed.com/x" }],
    llmResult: { ok: true, engine: "lmstudio", text: "not valid json {{{" },
  });
  const r = await runHiringCheck(company, deps);
  assert.equal(r.ran, true);
  assert.equal(r.signalFired, false, "malformed extraction -> 0 roles -> never fires (even though the hash DID change, from a non-empty prior to an empty-roles hash)");
  assert.equal(signals.length, 0);
  assert.equal(writes.length, 1);
});

test("no hiring text gathered this scan (brave unavailable, no website_url) — ran true, no crash", async () => {
  const { deps } = depsFor({ braveOk: false });
  const r = await runHiringCheck({ id: "co_1", name: "Acme Roofing" }, deps);
  assert.equal(r.ran, true);
  assert.equal(r.signalFired, false);
});

test("shadow mode: brave queries skipped (no live spend), check still completes without crashing", async () => {
  const { deps } = depsFor({ allowLive: false });
  const r = await runHiringCheck(company, deps);
  assert.equal(r.ran, true);
  assert.equal(r.costCentsSpent, 0);
});
