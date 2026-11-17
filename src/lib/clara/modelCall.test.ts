// Tests for modelCall.ts — the direct-call path every non-router call site uses. Settings, fetch,
// ledger and budget are all injected: no OS, no vendor, no files.

import { test } from "node:test";
import assert from "node:assert/strict";
import { callModelText, type ModelCallDeps } from "./modelCall";
import { defaultSnapshot, normalizeAgentSettings, type AgentSettingsSnapshot, type EffectiveAgentSettings } from "./agentSettings";

function snapWith(patch: (s: EffectiveAgentSettings) => void, subs: Record<string, EffectiveAgentSettings> = {}): AgentSettingsSnapshot {
  const snap = defaultSnapshot();
  snap.root = normalizeAgentSettings({});
  patch(snap.root);
  snap.subagents = subs;
  return snap;
}

const gemini = (model = "gemini-2.5-pro") => ({ id: "g", model_key: model, provider: "google", display_name: null, max_output_tokens: null, available: true });
const claude = (model: string) => ({ id: "c", model_key: model, provider: "anthropic", display_name: null, max_output_tokens: null, available: true });

function harness(opts: { snap: AgentSettingsSnapshot; env?: Record<string, string>; fail?: RegExp }) {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const records: { engine: string; model: string; purpose: string }[] = [];
  const logs: string[] = [];
  const deps: ModelCallDeps = {
    settings: async () => opts.snap,
    env: opts.env ?? { ANTHROPIC_API_KEY: "ak", GEMINI_API_KEY: "gk" },
    log: (m) => logs.push(m),
    record: async (r) => { records.push({ engine: r.engine, model: r.model, purpose: r.purpose }); },
    withinBudget: async () => true,
    fetchImpl: (async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      calls.push({ url, body });
      if (opts.fail && opts.fail.test(url + JSON.stringify(body))) return new Response("nope", { status: 529 });
      if (url.includes("generativelanguage")) {
        return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "from gemini" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 } }));
      }
      return new Response(JSON.stringify({ content: [{ type: "thinking", text: "" }, { type: "text", text: " from claude " }], usage: { input_tokens: 4, output_tokens: 3 } }));
    }) as unknown as typeof fetch,
  };
  return { deps, calls, records, logs };
}

const base = { site: "documents", purpose: "documents", defaultModel: "claude-opus-4-8", system: "sys", prompt: "draft it", maxTokens: 2000 };

test("no OS settings → the site's built-in Anthropic model, metered under its purpose", async () => {
  const h = harness({ snap: defaultSnapshot() });
  const out = await callModelText(base, h.deps);
  assert.equal(out?.text, "from claude", "text block, trimmed, past a thinking block");
  assert.equal(out?.provider, "anthropic");
  assert.equal(h.calls[0].body.model, "claude-opus-4-8");
  assert.equal(h.calls[0].body.max_tokens, 2000);
  assert.deepEqual(h.records, [{ engine: "anthropic", model: "claude-opus-4-8", purpose: "documents" }]);
});

test("OS primary = Gemini → Gemini generateContent, metered as engine google", async () => {
  const h = harness({ snap: snapWith((s) => { s.model.primary = gemini(); s.model.primary_source = "agent"; }) });
  const out = await callModelText(base, h.deps);
  assert.equal(out?.text, "from gemini");
  assert.equal(out?.provider, "google");
  assert.match(h.calls[0].url, /models\/gemini-2\.5-pro:generateContent$/);
  assert.deepEqual(h.records, [{ engine: "google", model: "gemini-2.5-pro", purpose: "documents" }]);
});

test("Gemini picked but no key → logged once, falls back to the built-in model", async () => {
  const h = harness({ snap: snapWith((s) => { s.model.primary = gemini(); s.model.primary_source = "agent"; }), env: { ANTHROPIC_API_KEY: "ak" } });
  const out = await callModelText(base, h.deps);
  assert.equal(out?.provider, "anthropic");
  assert.equal(out?.fellBack, true);
  assert.equal(h.calls.length, 1);
  assert.ok(h.logs.some((l) => /GEMINI_API_KEY/.test(l)));
});

test("model error → OS fallback model → built-in, in order", async () => {
  const h = harness({
    snap: snapWith((s) => { s.model.primary = gemini(); s.model.primary_source = "agent"; s.model.fallback = claude("claude-sonnet-5"); s.model.fallback_source = "agent"; }),
    fail: /generativelanguage|claude-sonnet-5/,
  });
  const out = await callModelText(base, h.deps);
  assert.equal(out?.model, "claude-opus-4-8");
  assert.deepEqual(h.calls.map((c) => (c.url.includes("generativelanguage") ? "gemini" : c.body.model)), ["gemini", "claude-sonnet-5", "claude-opus-4-8"]);
});

test("org-default model is ignored; the site keeps its own default", async () => {
  const h = harness({ snap: snapWith((s) => { s.model.primary = claude("claude-haiku-4-5"); s.model.primary_source = "org_default"; }) });
  await callModelText(base, h.deps);
  assert.equal(h.calls[0].body.model, "claude-opus-4-8");
});

test("cost-tier sites (honourModelSetting:false) keep their pinned model", async () => {
  const h = harness({ snap: snapWith((s) => { s.model.primary = gemini(); s.model.primary_source = "agent"; }) });
  await callModelText({ ...base, defaultModel: "claude-haiku-4-5", honourModelSetting: false }, h.deps);
  assert.equal(h.calls[0].body.model, "claude-haiku-4-5");
});

test("max_tokens narrows the site's cap, never raises it", async () => {
  const lower = harness({ snap: snapWith((s) => { s.limits.max_tokens = 500; }) });
  await callModelText(base, lower.deps);
  assert.equal(lower.calls[0].body.max_tokens, 500);
  const higher = harness({ snap: snapWith((s) => { s.limits.max_tokens = 9000; }) });
  await callModelText(base, higher.deps);
  assert.equal(higher.calls[0].body.max_tokens, 2000);
});

test("paused / disabled → null without calling any model", async () => {
  for (const status of ["paused", "disabled"] as const) {
    const h = harness({ snap: snapWith((s) => { s.status = status; }) });
    assert.equal(await callModelText(base, h.deps), null);
    assert.equal(h.calls.length, 0);
  }
});

test("a paused subagent refuses on its own; others use CLARA's settings", async () => {
  const sub = normalizeAgentSettings({ agent_key: "clara.front-desk", status: "paused" }, "clara.front-desk");
  const h = harness({ snap: snapWith(() => {}, { "clara.front-desk": sub }) });
  assert.equal(await callModelText({ ...base, subagent: "front-desk" }, h.deps), null);
  assert.ok(await callModelText({ ...base, subagent: "scheduler" }, h.deps));
});

test("rate limit and daily budget refuse the call (null), only when the OS sets them", async () => {
  const rl = harness({ snap: snapWith((s) => { s.limits.rate_limit_per_minute = 1; }) });
  rl.deps.rateSlot = () => false;
  assert.equal(await callModelText(base, rl.deps), null);
  assert.equal(rl.calls.length, 0);

  const budget = harness({ snap: snapWith((s) => { s.limits.daily_budget_usd = 5; }) });
  budget.deps.withinBudget = async () => false;
  assert.equal(await callModelText(base, budget.deps), null);

  const noBudget = harness({ snap: defaultSnapshot() });
  noBudget.deps.withinBudget = async () => { throw new Error("must not be consulted"); };
  assert.ok(await callModelText(base, noBudget.deps));
});

test("every model failing → null (the caller's canned fallback), never a throw", async () => {
  const h = harness({ snap: defaultSnapshot(), fail: /./ });
  assert.equal(await callModelText(base, h.deps), null);
  const none = harness({ snap: defaultSnapshot(), env: {} });
  assert.equal(await callModelText(base, none.deps), null);
  assert.equal(none.calls.length, 0);
});
