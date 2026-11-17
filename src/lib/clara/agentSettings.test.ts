// Tests for agentSettings.ts — the OS per-agent settings client and the narrowing rules every call
// site relies on. The client is exercised against a stubbed fetch: no OS, no network, no JWT.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AgentSettingsClient, MinuteRateLimiter, defaultAgentSettings, normalizeAgentSettings, normalizeSnapshot,
  settingsFor, narrowCap, narrowIntCap, modelChain, ignoredModelReason, filterToolNames, filterOsToolNames,
  statusRefusal, effectiveVoiceId, voiceSettingOverrides, normalizeProvider, getAgentSettings,
} from "./agentSettings";

// A response shaped exactly like orion agent-settings-get's present() output.
function osData(over: Record<string, unknown> = {}) {
  return {
    agent_key: "clara",
    parent_key: null,
    status: "active",
    model: {
      effective: { id: "m1", model_key: "gemini-2.5-pro", provider: "google", display_name: "Gemini 2.5 Pro", context_window: 1e6, max_output_tokens: 65536, available: true },
      primary: { id: "m1", model_key: "gemini-2.5-pro", provider: "google", display_name: "Gemini 2.5 Pro", context_window: 1e6, max_output_tokens: 65536, available: true },
      primary_source: "agent",
      fallback: { id: "m2", model_key: "claude-sonnet-5", provider: "anthropic", display_name: "Sonnet 5", context_window: 2e5, max_output_tokens: null, available: true },
      fallback_source: "agent",
    },
    voice: { provider: "elevenlabs", voice_id: "AbCdEfGhIjKlMnOpQrSt", voice_name: "Ava", available: true, source: "agent", settings: { stability: 0.4 } },
    prompts: { persona_override: "Keep phone replies short.", persona_mode: "append", templates: [{ id: "t1", name: "Sign-off", version: 2, body: "Sign off as Clara." }] },
    knowledge: { collections: [], include_global: true, global_collections: [] },
    tools: { allowed: null, denied: ["cancel_event"] },
    limits: { daily_budget_usd: 10, max_tokens: 800, max_calls_per_day: 100, rate_limit_per_minute: 30, max_turns: 4 },
    require_approval: false,
    updated_at: "2026-10-29T00:00:00Z",
    subagents: [
      { agent_key: "clara.front-desk", status: "paused", model: { primary: null, primary_source: "none", fallback: null, fallback_source: "none" }, tools: { allowed: ["crm_lookup"], denied: [] }, limits: {} },
    ],
    caller: { user_id: "u", role: "ClaraAgent" },
    generated_at: "2026-10-29T00:00:00Z",
    ...over,
  };
}

function okResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ success: true, data }), { status, headers: { "content-type": "application/json" } });
}

// ── normalisation ──────────────────────────────────────────────────────────────────────────────

test("normalizeSnapshot reads the OS shape, including the subagents ARRAY keyed by agent_key", () => {
  const snap = normalizeSnapshot(osData(), 123);
  assert.equal(snap.source, "os");
  assert.equal(snap.root.status, "active");
  assert.equal(snap.root.model.primary?.provider, "google");
  assert.equal(snap.root.limits.max_turns, 4);
  assert.deepEqual(snap.root.tools, { allowed: null, denied: ["cancel_event"] });
  assert.equal(snap.root.prompts.templates[0].body, "Sign off as Clara.");
  assert.equal(snap.subagents["clara.front-desk"].status, "paused");
  assert.deepEqual(snap.subagents["clara.front-desk"].tools.allowed, ["crm_lookup"]);
});

test("normalizeSnapshot also accepts subagents as an object keyed by <parent>.<id>, and drops other trees", () => {
  const snap = normalizeSnapshot(osData({ subagents: { "clara.scheduler": { status: "disabled" }, "friday.builder": { status: "paused" } } }), 1);
  assert.equal(snap.subagents["clara.scheduler"].status, "disabled");
  assert.equal(snap.subagents["friday.builder"], undefined);
});

test("malformed fields degrade to built-in defaults rather than throwing", () => {
  const s = normalizeAgentSettings({ status: "on-fire", limits: { max_turns: "abc", max_tokens: -5, daily_budget_usd: "12.5" }, tools: { allowed: "all", denied: [1, "x"] }, model: "nope" });
  assert.equal(s.status, "active");
  assert.equal(s.limits.max_turns, null);
  assert.equal(s.limits.max_tokens, null, "a zero/negative limit is unset, never '0 allowed'");
  assert.equal(s.limits.daily_budget_usd, 12.5, "numeric strings (Postgres numeric) parse");
  assert.equal(s.tools.allowed, null);
  assert.deepEqual(s.tools.denied, ["x"]);
  assert.equal(s.model.primary, null);
  assert.deepEqual(normalizeAgentSettings(null), defaultAgentSettings());
});

test("settingsFor falls back to CLARA's own entry when a subagent has no OS row", () => {
  const snap = normalizeSnapshot(osData(), 1);
  assert.equal(settingsFor(snap, "front-desk").status, "paused");
  assert.equal(settingsFor(snap, "researcher"), snap.root);
  assert.equal(settingsFor(snap), snap.root);
});

// ── narrowing helpers ──────────────────────────────────────────────────────────────────────────

test("narrowCap: a setting can lower a hard cap but never raise it", () => {
  assert.equal(narrowCap(15, 10), 10);
  assert.equal(narrowCap(15, 50), 15);
  assert.equal(narrowCap(15, null), 15);
  assert.equal(narrowCap(15, 0), 15);
  assert.equal(narrowIntCap(6, 2.7), 2);
  assert.equal(narrowIntCap(6, 0.4), 1, "never below one turn");
  assert.equal(narrowIntCap(6, 10), 6);
});

test("modelChain: OS primary → OS fallback → built-in, google ids lose a models/ prefix", () => {
  const s = normalizeAgentSettings(osData());
  s.model.primary!.model_key = "models/gemini-2.5-pro";
  assert.deepEqual(modelChain(s, "claude-opus-4-8"), [
    { provider: "google", model: "gemini-2.5-pro", via: "primary" },
    { provider: "anthropic", model: "claude-sonnet-5", via: "fallback" },
    { provider: "anthropic", model: "claude-opus-4-8", via: "default" },
  ]);
});

test("modelChain ignores org defaults, unavailable models and providers CLARA can't call", () => {
  const s = normalizeAgentSettings(osData());
  s.model.primary_source = "org_default";
  s.model.fallback = { ...s.model.fallback!, available: false, unavailable_reason: "provider disabled" };
  assert.deepEqual(modelChain(s, "claude-sonnet-5"), [{ provider: "anthropic", model: "claude-sonnet-5", via: "default" }]);

  const openai = normalizeAgentSettings(osData());
  openai.model.primary = { ...openai.model.primary!, provider: "openai", model_key: "gpt-5" };
  assert.equal(modelChain(openai, "x")[0].model, "claude-sonnet-5", "unsupported primary skipped, fallback used");
  assert.match(ignoredModelReason(openai) ?? "", /no CLARA caller/);
});

test("modelChain de-duplicates a fallback equal to the built-in model", () => {
  const s = normalizeAgentSettings(osData());
  assert.equal(modelChain(s, "claude-sonnet-5").length, 2);
});

test("normalizeProvider maps OS provider names", () => {
  assert.equal(normalizeProvider("google"), "google");
  assert.equal(normalizeProvider("Anthropic"), "anthropic");
  assert.equal(normalizeProvider("openai"), null);
});

test("tool lists are code ∩ allowed − denied, never wider than the code list", () => {
  const code = ["a", "b", "c"];
  assert.deepEqual(filterToolNames(code, { allowed: null, denied: [] }), ["a", "b", "c"]);
  assert.deepEqual(filterToolNames(code, { allowed: ["a", "c", "zzz"], denied: ["c"] }), ["a"]);
  assert.deepEqual(filterToolNames(code, { allowed: [], denied: [] }), [], "an empty allow list allows nothing");
});

test("OS MCP namespace: denied always applies; an allow list naming only intent tools leaves MCP alone", () => {
  const mcp = ["contacts_list", "email_send", "calendar_events_list"];
  assert.deepEqual(filterOsToolNames(mcp, { allowed: ["crm_lookup", "find_email"], denied: ["email_send"] }), ["contacts_list", "calendar_events_list"]);
  assert.deepEqual(filterOsToolNames(mcp, { allowed: ["contacts_list", "crm_lookup"], denied: [] }), ["contacts_list"]);
});

test("statusRefusal: polite refusal for paused/disabled, null when active", () => {
  const s = defaultAgentSettings();
  assert.equal(statusRefusal(s), null);
  assert.match(statusRefusal({ ...s, status: "paused" }) ?? "", /paused.*Nothing was changed/);
  assert.match(statusRefusal({ ...s, status: "disabled" }, "Front Desk") ?? "", /^Front Desk is switched off/);
});

test("voice: an explicit, available OS voice wins; org defaults and bad ids keep the env voice", () => {
  const s = normalizeAgentSettings(osData());
  assert.equal(effectiveVoiceId(s, "envVoice00000000000"), "AbCdEfGhIjKlMnOpQrSt");
  assert.equal(effectiveVoiceId({ ...s, voice: { ...s.voice, source: "org_default" } }, "env"), "env");
  assert.equal(effectiveVoiceId({ ...s, voice: { ...s.voice, available: false } }, "env"), "env");
  assert.equal(effectiveVoiceId({ ...s, voice: { ...s.voice, voice_id: "bad id!" } }, "env"), "env");
  assert.deepEqual(voiceSettingOverrides(s), { stability: 0.4 });
  assert.deepEqual(voiceSettingOverrides({ ...s, voice: { ...s.voice, settings: { stability: 7, style: 0.2, use_speaker_boost: false } } }), { style: 0.2, use_speaker_boost: false });
});

test("MinuteRateLimiter: allows `limit` calls per sliding minute; no limit = unlimited", () => {
  let now = 0;
  const rl = new MinuteRateLimiter(() => now);
  assert.equal(rl.take(2), true);
  assert.equal(rl.take(2), true);
  assert.equal(rl.take(2), false);
  now = 60_001;
  assert.equal(rl.take(2), true);
  for (let i = 0; i < 50; i++) assert.equal(rl.take(null), true);
});

// ── client ─────────────────────────────────────────────────────────────────────────────────────

test("client: POSTs {agent, include_subagents} with the agent JWT to agent-settings-get", async () => {
  const seen: { url: string; init: RequestInit }[] = [];
  const c = new AgentSettingsClient({
    baseUrl: "https://os.example.co/",
    getJwt: async () => "jwt-123",
    anonKey: "anon",
    fetchImpl: (async (url: string, init: RequestInit) => { seen.push({ url, init }); return okResponse(osData()); }) as unknown as typeof fetch,
  });
  const snap = await c.get();
  assert.equal(snap.source, "os");
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, "https://os.example.co/functions/v1/agent-settings-get");
  assert.equal(seen[0].init.method, "POST");
  const h = seen[0].init.headers as Record<string, string>;
  assert.equal(h.Authorization, "Bearer jwt-123");
  assert.equal(h.apikey, "anon");
  assert.deepEqual(JSON.parse(String(seen[0].init.body)), { agent: "clara", include_subagents: true });
});

test("client: caches for the TTL, then serves stale while revalidating in the background", async () => {
  let now = 1_000;
  let calls = 0;
  const c = new AgentSettingsClient({
    getJwt: async () => "j", now: () => now, ttlMs: 60_000,
    fetchImpl: (async () => { calls++; return okResponse(osData({ status: calls === 1 ? "active" : "paused" })); }) as unknown as typeof fetch,
  });
  assert.equal((await c.get()).root.status, "active");
  await c.get();
  assert.equal(calls, 1, "within TTL: no refetch");
  now += 60_000;
  assert.equal((await c.get()).root.status, "active", "stale read returns at once");
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(calls, 2);
  assert.equal((await c.get()).root.status, "paused", "background refresh landed");
});

test("client: concurrent reads share one in-flight fetch", async () => {
  let calls = 0;
  const c = new AgentSettingsClient({
    getJwt: async () => "j",
    fetchImpl: (async () => { calls++; await new Promise((r) => setTimeout(r, 5)); return okResponse(osData()); }) as unknown as typeof fetch,
  });
  await Promise.all([c.get(), c.get(), c.get()]);
  assert.equal(calls, 1);
});

test("client: OS down with no history → built-in defaults; never throws", async () => {
  const logs: string[] = [];
  const c = new AgentSettingsClient({
    getJwt: async () => "j", log: (m) => logs.push(m),
    fetchImpl: (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch,
  });
  const snap = await c.get();
  assert.equal(snap.source, "defaults");
  assert.deepEqual(snap.root, defaultAgentSettings());
  assert.match(snap.error ?? "", /ECONNREFUSED/);
  assert.equal(logs.length, 1);
});

test("client: a failure after a good read keeps the last good settings", async () => {
  let now = 0;
  let fail = false;
  const c = new AgentSettingsClient({
    getJwt: async () => "j", now: () => now, ttlMs: 10,
    fetchImpl: (async () => {
      if (fail) return new Response(JSON.stringify({ success: false, error: "boom" }), { status: 500 });
      return okResponse(osData({ status: "paused" }));
    }) as unknown as typeof fetch,
  });
  assert.equal((await c.get()).root.status, "paused");
  fail = true;
  now = 100;
  const snap = await c.refresh();
  assert.equal(snap.source, "last-good");
  assert.equal(snap.root.status, "paused");
  assert.match(snap.error ?? "", /500: boom/);
});

test("client: not signed in to the OS → defaults, no request made", async () => {
  let calls = 0;
  const c = new AgentSettingsClient({ getJwt: async () => null, fetchImpl: (async () => { calls++; return okResponse(osData()); }) as unknown as typeof fetch });
  assert.equal((await c.get()).source, "defaults");
  assert.equal(calls, 0);
});

test("client: success:false or a non-object data payload is a failure, not settings", async () => {
  const c = new AgentSettingsClient({ getJwt: async () => "j", fetchImpl: (async () => new Response(JSON.stringify({ success: true, data: "x" }))) as unknown as typeof fetch });
  assert.equal((await c.get()).source, "defaults");
});

test("client: the first read waits at most firstWaitMs for a slow OS, then goes on defaults", async () => {
  const c = new AgentSettingsClient({
    getJwt: async () => "j", firstWaitMs: 10,
    fetchImpl: (async () => { await new Promise((r) => setTimeout(r, 200)); return okResponse(osData({ status: "paused" })); }) as unknown as typeof fetch,
  });
  const t0 = Date.now();
  const snap = await c.get();
  assert.ok(Date.now() - t0 < 150, "did not wait for the slow fetch");
  assert.equal(snap.root.status, "active");
});

test("client: a hung OS is cut off by the fetch timeout (15s default, configurable)", async () => {
  const c = new AgentSettingsClient({
    getJwt: async () => "j", timeoutMs: 20, firstWaitMs: 1_000,
    fetchImpl: ((_url: string, init: RequestInit) => new Promise((_, reject) => {
      init.signal?.addEventListener("abort", () => reject(new Error("aborted by timeout")));
    })) as unknown as typeof fetch,
  });
  const snap = await c.get();
  assert.equal(snap.source, "defaults");
  assert.match(snap.error ?? "", /abort/i);
});

test("process-wide getAgentSettings is inert under node --test (defaults, no network)", async () => {
  const snap = await getAgentSettings();
  assert.equal(snap.source, "defaults");
  assert.equal(snap.root.status, "active");
});
