import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evidenceHash, extractClaimedTokens, validateSlotText, validatePersonalizeResult, renderStep,
  buildPersonalizePrompt, type PersonalizeInput, type PersonalizeDeps, type PersonalizeResult,
} from "./personalize";
import type { CompanyFactRow, SignalRow } from "./osBridge";

function fact(overrides: Partial<CompanyFactRow> = {}): CompanyFactRow {
  return { id: "fact_1", field_name: "owner", value: "Jane Smith", confidence: 0.8, ...overrides };
}
function signal(overrides: Partial<SignalRow> = {}): SignalRow {
  return { id: "signal_1", company_id: "co_1", signal_type: "hiring", headline: "Hiring 2 roofers", observed_at: new Date().toISOString(), ...overrides };
}
function input(overrides: Partial<PersonalizeInput> = {}): PersonalizeInput {
  return {
    contact: { fullName: "Jane Smith", firstName: "Jane", title: "Owner" },
    company: { name: "Acme Roofing", city: "Tampa", state: "FL" },
    facts: [fact()],
    signals: [signal()],
    template: { body: "Hi {{contact.first_name}}, {{ai:opener}}" },
    aiSlots: [{ name: "opener", maxWords: 20, mustCite: true, fallback: "wanted to reach out." }],
    priorTouches: [],
    ...overrides,
  };
}

test("evidenceHash: stable for the same fact/signal id set regardless of input order", () => {
  const a = evidenceHash([fact({ id: "f1" }), fact({ id: "f2" })], [signal({ id: "s1" })]);
  const b = evidenceHash([fact({ id: "f2" }), fact({ id: "f1" })], [signal({ id: "s1" })]);
  assert.equal(a, b);
});
test("evidenceHash: changes when the id set changes (a new signal invalidates the cache)", () => {
  const a = evidenceHash([fact({ id: "f1" })], [signal({ id: "s1" })]);
  const b = evidenceHash([fact({ id: "f1" })], [signal({ id: "s1" }), signal({ id: "s2" })]);
  assert.notEqual(a, b);
});

test("buildPersonalizePrompt: cites evidence ids in fact:/signal: form and names the must_cite slot", () => {
  const prompt = buildPersonalizePrompt(input());
  assert.match(prompt, /fact:fact_1/);
  assert.match(prompt, /signal:signal_1/);
  assert.match(prompt, /"opener".*MUST cite/);
});

test("extractClaimedTokens: picks up numbers and non-sentence-initial capitalized words", () => {
  const tokens = extractClaimedTokens("We noticed Acme added 47 open roles this month.");
  assert.ok(tokens.includes("47"));
  assert.ok(tokens.includes("Acme"));
  assert.ok(!tokens.includes("We")); // sentence-initial — grammar, not a claim
});

test("validateSlotText: passes when every claimed token appears in the cited evidence", () => {
  const r = validateSlotText("Saw Acme is hiring.", "Hiring 2 roofers at Acme this week");
  assert.equal(r.ok, true);
});
test("validateSlotText: fails on a number not present in the cited evidence", () => {
  const r = validateSlotText("Saw you're hiring 12 people.", "Hiring 2 roofers at Acme this week");
  assert.equal(r.ok, false);
  assert.match(r.reason ?? "", /12/);
});
test("validateSlotText: fails on an invented proper noun", () => {
  const r = validateSlotText("Congrats on the Chicago expansion!", "Hiring 2 roofers at Acme this week");
  assert.equal(r.ok, false);
  assert.match(r.reason ?? "", /Chicago/);
});

function result(overrides: Partial<PersonalizeResult> = {}): PersonalizeResult {
  return { slots: { opener: { text: "Saw you're hiring roofers.", citations: ["signal:signal_1"] } }, rationale: "cites the hiring signal", ...overrides };
}

test("validatePersonalizeResult: passes a well-cited, well-grounded result", () => {
  assert.equal(validatePersonalizeResult(result(), input()).ok, true);
});
test("validatePersonalizeResult: fails a must_cite slot with no citations", () => {
  const r = validatePersonalizeResult(result({ slots: { opener: { text: "Hi there.", citations: [] } } }), input());
  assert.equal(r.ok, false);
  assert.match(r.reason ?? "", /no valid citation/);
});
test("validatePersonalizeResult: fails a citation pointing outside this render's own evidence set, even on a non-must_cite slot", () => {
  const notMustCite = input({ aiSlots: [{ name: "opener", mustCite: false, fallback: "wanted to reach out." }] });
  const r = validatePersonalizeResult(result({ slots: { opener: { text: "Hi there.", citations: ["fact:not_in_input"] } } }), notMustCite);
  assert.equal(r.ok, false);
  assert.match(r.reason ?? "", /outside this render's evidence/);
});
test("validatePersonalizeResult: fails a missing slot entirely", () => {
  const r = validatePersonalizeResult({ slots: {}, rationale: "" }, input());
  assert.equal(r.ok, false);
  assert.match(r.reason ?? "", /missing slot/);
});

// ── renderStep ───────────────────────────────────────────────────────────────────────────────

test("renderStep: a cache hit (matching evidence_hash) never calls runTier", async () => {
  let called = false;
  const deps: PersonalizeDeps = { runTier: async () => { called = true; return { ok: false, engine: "anthropic" }; } };
  const hash = evidenceHash(input().facts, input().signals);
  const r = await renderStep(input(), { evidence_hash: hash, slots: { opener: "cached text" }, citations: {} }, deps);
  assert.equal(r.fromCache, true);
  assert.equal(r.slots.opener, "cached text");
  assert.equal(called, false);
});

test("renderStep: a valid tier-3 result is used directly, no fallback", async () => {
  const deps: PersonalizeDeps = { runTier: async () => ({ ok: true, engine: "anthropic", text: JSON.stringify(result()) }) };
  const r = await renderStep(input(), undefined, deps);
  assert.equal(r.usedFallback, false);
  assert.equal(r.slots.opener, "Saw you're hiring roofers.");
  assert.deepEqual(r.citations.opener, ["signal:signal_1"]);
});

test("renderStep: an invalid result is retried once, and falls back to template text on a second failure", async () => {
  let calls = 0;
  const deps: PersonalizeDeps = {
    runTier: async () => {
      calls++;
      return { ok: true, engine: "anthropic", text: JSON.stringify(result({ slots: { opener: { text: "Congrats on your Chicago office!", citations: ["signal:signal_1"] } } })) };
    },
  };
  const r = await renderStep(input(), undefined, deps);
  assert.equal(calls, 2); // one try + one retry, both invalid
  assert.equal(r.usedFallback, true);
  assert.equal(r.slots.opener, "wanted to reach out.");
});

test("renderStep: a tier-3 failure (ok:false) also falls back after the retry, never throws", async () => {
  const deps: PersonalizeDeps = { runTier: async () => ({ ok: false, engine: "anthropic", error: "timeout" }) };
  const r = await renderStep(input(), undefined, deps);
  assert.equal(r.usedFallback, true);
  assert.equal(r.slots.opener, "wanted to reach out.");
});

test("renderStep: a fresh valid generation surfaces the model's rationale; a cache hit has none to surface", async () => {
  const deps: PersonalizeDeps = { runTier: async () => ({ ok: true, engine: "anthropic", text: JSON.stringify(result({ rationale: "cites the hiring signal" })) }) };
  const fresh = await renderStep(input(), undefined, deps);
  assert.equal(fresh.rationale, "cites the hiring signal");

  const hash = evidenceHash(input().facts, input().signals);
  const cached = await renderStep(input(), { evidence_hash: hash, slots: { opener: "cached text" }, citations: {} }, deps);
  assert.equal(cached.rationale, undefined);
});

test("renderStep: a fallback with no configured fallback text renders blank, never blocks", async () => {
  const deps: PersonalizeDeps = { runTier: async () => ({ ok: false, engine: "anthropic" }) };
  const noFallbackInput = input({ aiSlots: [{ name: "opener", mustCite: true }] });
  const r = await renderStep(noFallbackInput, undefined, deps);
  assert.equal(r.slots.opener, "");
});
