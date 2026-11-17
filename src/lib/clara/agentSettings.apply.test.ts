// Tests for where the OS per-agent settings are applied: the intent router (model chain, tools,
// require_approval), subagents (roster narrowing) and the persona override. Pure pieces only — no
// model, no OS.

import { test } from "node:test";
import assert from "node:assert/strict";
import { routerModelChain, routerTools, requireApproval, READ_ONLY_TOOLS } from "./intent";
import { applySubagentSettings, SUBAGENTS } from "./subagents";
import { overrideBlock, withAppendedOverride, identityFor, CLARA_BUSINESS_IDENTITY, CLARA_IDENTITY } from "./persona";
import { defaultSnapshot, modelChain, normalizeAgentSettings } from "./agentSettings";

const gemini = { id: "g", model_key: "gemini-2.5-pro", provider: "google", display_name: null, max_output_tokens: null, available: true };

test("router chain: Gemini primary then the built-in Claude model; no Gemini key → Claude only", () => {
  const s = normalizeAgentSettings({});
  s.model.primary = gemini; s.model.primary_source = "agent";
  const chain = modelChain(s, "claude-sonnet-5");
  const withKey = routerModelChain(chain, { anthropicKey: "ak", geminiKey: "gk", maxTokens: 1200 });
  assert.deepEqual(withKey.map((c) => `${c.target.provider}/${c.target.model}`), ["google/gemini-2.5-pro", "anthropic/claude-sonnet-5"]);
  const noKey = routerModelChain(chain, { anthropicKey: "ak", geminiKey: null, maxTokens: 1200 });
  assert.deepEqual(noKey.map((c) => c.target.provider), ["anthropic"]);
  const geminiOnly = routerModelChain(chain, { geminiKey: "gk", maxTokens: 1200 });
  assert.deepEqual(geminiOnly.map((c) => c.target.provider), ["google"], "no Anthropic key: Gemini still routes");
});

test("router chain: the Gemini caller really speaks Gemini function calling", async () => {
  const s = normalizeAgentSettings({});
  s.model.primary = gemini; s.model.primary_source = "agent";
  const [first] = routerModelChain(modelChain(s, "claude-sonnet-5"), { anthropicKey: "ak", geminiKey: "gk", maxTokens: 300 });
  const realFetch = globalThis.fetch;
  let url = "";
  globalThis.fetch = (async (u: string) => {
    url = u;
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ functionCall: { name: "get_weather", args: { city: "Tampa" } } }] }, finishReason: "STOP" }] }));
  }) as unknown as typeof fetch;
  try {
    const blocks = await first.call({ system: "s", tools: [{ name: "get_weather", description: "w", input_schema: { type: "object", properties: {} } }], messages: [{ role: "user", content: "weather" }] });
    assert.match(url, /generativelanguage\.googleapis\.com/);
    assert.equal(blocks[0].type, "tool_use");
    assert.equal(blocks[0].name, "get_weather");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("router tools: catalog ∩ allowed − denied, CLARA's settings first then the subagent's", () => {
  const tools = [{ name: "get_weather" }, { name: "find_email" }, { name: "send_email" }, { name: "cancel_event" }];
  const root = normalizeAgentSettings({ tools: { allowed: null, denied: ["cancel_event"] } });
  assert.deepEqual(routerTools(tools, root).map((t) => t.name), ["get_weather", "find_email", "send_email"]);
  const sub = normalizeAgentSettings({ tools: { allowed: ["find_email", "cancel_event", "not_a_tool"], denied: [] } });
  assert.deepEqual(routerTools(tools, sub, root).map((t) => t.name), ["find_email"], "root deny survives the subagent's allow; unknown names add nothing");
  assert.equal(routerTools(tools, normalizeAgentSettings({})).length, 4, "no settings → catalog unchanged");
});

test("require_approval only adds approvals, and never to pure reads", () => {
  const on = normalizeAgentSettings({ require_approval: true });
  const off = normalizeAgentSettings({});
  const aRead = [...READ_ONLY_TOOLS][0];
  assert.equal(requireApproval("send_email", on), true);
  assert.equal(requireApproval(aRead, on), false);
  assert.equal(requireApproval("send_email", off), false);
  assert.equal(requireApproval("send_email", off, on), true, "CLARA's flag covers her subagents");
  assert.equal(requireApproval("send_email"), false);
});

test("subagent roster: narrowed by CLARA's and the subagent's own tool settings, never widened", () => {
  const def = SUBAGENTS.find((s) => s.id === "scheduler")!;
  const snap = defaultSnapshot();
  assert.deepEqual(applySubagentSettings(def, snap).tools, def.tools, "no settings → roster unchanged");
  snap.root = normalizeAgentSettings({ tools: { allowed: null, denied: ["cancel_event"] } });
  snap.subagents["clara.scheduler"] = normalizeAgentSettings({ agent_key: "clara.scheduler", tools: { allowed: ["list_calendar", "cancel_event", "send_email"], denied: [] } }, "clara.scheduler");
  assert.deepEqual(applySubagentSettings(def, snap).tools, ["list_calendar"]);
  assert.equal(def.tools.includes("cancel_event"), true, "the roster itself is not mutated");
});

test("persona override: append adds an instructions block; nothing set → identical text", () => {
  const none = normalizeAgentSettings({});
  assert.equal(overrideBlock(none), "");
  assert.equal(withAppendedOverride(CLARA_IDENTITY, none), CLARA_IDENTITY);
  const s = normalizeAgentSettings({ prompts: { persona_override: "Keep it short.", persona_mode: "append", templates: [{ id: "t", name: "n", body: "Sign as Clara." }] } });
  assert.equal(overrideBlock(s), "Keep it short.\n\nSign as Clara.");
  const out = withAppendedOverride(CLARA_BUSINESS_IDENTITY, s);
  assert.ok(out.startsWith(CLARA_BUSINESS_IDENTITY), "the sealed business identity is kept whole");
  assert.ok(out.endsWith("Keep it short.\n\nSign as Clara."));
});

test("identityFor is unchanged when the OS has no override (process defaults under test)", () => {
  assert.equal(identityFor("business"), CLARA_BUSINESS_IDENTITY);
  assert.equal(identityFor("principal"), CLARA_IDENTITY);
});
