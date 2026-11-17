// Tests for gemini.ts — the Gemini REST caller, against a stubbed fetch (no key, no network).
// Pins the wire format both ways: what CLARA sends Gemini, and how Gemini's reply comes back in the
// Anthropic ContentBlock shape the intent loop and its gates read.

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  geminiGenerateText, geminiCaller, toGeminiSchema, toGeminiContents, fromGeminiParts, geminiApiKey,
  clearGeminiSignatures, GEMINI_API_BASE,
} from "./gemini";

type Seen = { url: string; init: RequestInit; body: Record<string, unknown> };

function stubFetch(reply: unknown, status = 200) {
  const seen: Seen[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    seen.push({ url, init, body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify(reply), { status });
  }) as unknown as typeof fetch;
  return { seen, fetchImpl };
}

const textReply = (text: string, extra: Record<string, unknown> = {}) => ({
  candidates: [{ content: { role: "model", parts: [{ text: "thinking about it", thought: true }, { text }] }, finishReason: "STOP" }],
  usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 7, thoughtsTokenCount: 3, totalTokenCount: 21 },
  ...extra,
});

beforeEach(() => clearGeminiSignatures());

test("geminiApiKey: GEMINI_API_KEY, else GOOGLE_AI_API_KEY, else null", () => {
  assert.equal(geminiApiKey({ GEMINI_API_KEY: " g ", GOOGLE_AI_API_KEY: "x" }), "g");
  assert.equal(geminiApiKey({ GOOGLE_AI_API_KEY: "x" }), "x");
  assert.equal(geminiApiKey({}), null);
});

test("geminiGenerateText: generateContent request shape — key in a header, never the URL", async () => {
  const { seen, fetchImpl } = stubFetch(textReply("Hello Jordan."));
  const out = await geminiGenerateText({
    apiKey: "secret-key", model: "models/gemini-2.5-pro", system: "You are Clara.",
    messages: [{ role: "user", content: "hi" }], maxTokens: 300, temperature: 0.2, json: true, fetchImpl, thinkingTokens: 100,
  });
  assert.equal(out.text, "Hello Jordan.", "thought parts are not part of the answer");
  assert.deepEqual(out.usage, { tokensIn: 11, tokensOut: 10, tokensTotal: 21 });
  assert.equal(seen[0].url, `${GEMINI_API_BASE}/models/gemini-2.5-pro:generateContent`);
  assert.ok(!seen[0].url.includes("secret-key"));
  assert.equal((seen[0].init.headers as Record<string, string>)["x-goog-api-key"], "secret-key");
  assert.deepEqual(seen[0].body.systemInstruction, { parts: [{ text: "You are Clara." }] });
  assert.deepEqual(seen[0].body.contents, [{ role: "user", parts: [{ text: "hi" }] }]);
  assert.deepEqual(seen[0].body.generationConfig, { maxOutputTokens: 400, temperature: 0.2, responseMimeType: "application/json" });
});

test("geminiGenerateText: HTTP errors, blocked prompts and empty answers throw (callers fall back)", async () => {
  await assert.rejects(geminiGenerateText({ apiKey: "k", model: "m", messages: [{ role: "user", content: "x" }], maxTokens: 10, fetchImpl: stubFetch({ error: { message: "bad key" } }, 400).fetchImpl }), /Gemini 400/);
  await assert.rejects(geminiGenerateText({ apiKey: "k", model: "m", messages: [{ role: "user", content: "x" }], maxTokens: 10, fetchImpl: stubFetch({ promptFeedback: { blockReason: "SAFETY" } }).fetchImpl }), /blocked: SAFETY/);
  await assert.rejects(
    geminiGenerateText({ apiKey: "k", model: "m", messages: [{ role: "user", content: "x" }], maxTokens: 10, fetchImpl: stubFetch({ candidates: [{ content: { parts: [{ text: "hmm", thought: true }] }, finishReason: "MAX_TOKENS" }] }).fetchImpl }),
    /no text \(finishReason MAX_TOKENS\)/,
  );
});

test("toGeminiSchema: keeps the OpenAPI subset Gemini accepts, drops the rest", () => {
  const s = toGeminiSchema({
    type: "object",
    additionalProperties: false,
    $schema: "x",
    properties: {
      subagent: { type: "string", enum: ["front-desk", "scheduler"], description: "who" },
      when: { type: ["string", "null"], pattern: "^\\d+$", default: "now" },
      ids: { type: "array", items: { type: "integer" } },
    },
    required: ["subagent", "missing"],
  });
  assert.deepEqual(s, {
    type: "OBJECT",
    properties: {
      subagent: { type: "STRING", enum: ["front-desk", "scheduler"], description: "who" },
      when: { type: "STRING", nullable: true },
      ids: { type: "ARRAY", items: { type: "INTEGER" } },
    },
    required: ["subagent"],
  });
});

test("geminiCaller: tools become functionDeclarations; toolChoice none → mode NONE", async () => {
  const { seen, fetchImpl } = stubFetch(textReply("Done thinking."));
  const call = geminiCaller("k", "gemini-2.5-flash", 500, { fetchImpl, thinkingTokens: 0 });
  const tools = [{ name: "get_weather", description: "Weather", input_schema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } }];
  await call({ system: "sys", tools, messages: [{ role: "user", content: "weather?" }] });
  await call({ system: "sys", tools, messages: [{ role: "user", content: "weather?" }], toolChoice: "none" });
  const decl = (seen[0].body.tools as { functionDeclarations: unknown[] }[])[0].functionDeclarations;
  assert.deepEqual(decl, [{ name: "get_weather", description: "Weather", parameters: { type: "OBJECT", properties: { city: { type: "STRING" } }, required: ["city"] } }]);
  assert.deepEqual(seen[0].body.toolConfig, { functionCallingConfig: { mode: "AUTO" } });
  assert.deepEqual(seen[1].body.toolConfig, { functionCallingConfig: { mode: "NONE" } });
  assert.deepEqual(seen[0].body.generationConfig, { maxOutputTokens: 500 });
});

test("geminiCaller: a functionCall comes back as an Anthropic tool_use block", async () => {
  const { fetchImpl } = stubFetch({
    candidates: [{ content: { role: "model", parts: [
      { text: "Checking the forecast." },
      { functionCall: { name: "get_weather", args: { city: "Tampa" } }, thoughtSignature: "sig-abc" },
    ] }, finishReason: "STOP" }],
  });
  const blocks = await geminiCaller("k", "gemini-3-pro", 500, { fetchImpl })({ system: "", tools: [], messages: [{ role: "user", content: "x" }] });
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks[0], { type: "text", text: "Checking the forecast." });
  assert.equal(blocks[1].type, "tool_use");
  assert.equal(blocks[1].name, "get_weather");
  assert.deepEqual(blocks[1].input, { city: "Tampa" });
  assert.match(String(blocks[1].id), /^gm_/);
});

test("round trip: tool_use/tool_result map to functionCall/functionResponse, signature replayed", () => {
  const [_text, use] = fromGeminiParts([{ text: "ok" }, { functionCall: { name: "find_email", args: { q: "invoice" } }, thoughtSignature: "SIG1" }]);
  const contents = toGeminiContents([
    { role: "user", content: "find the invoice" },
    { role: "assistant", content: [{ type: "text", text: "ok" }, use] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: String(use.id), content: "3 matches" }, { type: "text", text: "Answer now." }] as never },
  ], "gemini-3-pro");
  assert.deepEqual(contents[0], { role: "user", parts: [{ text: "find the invoice" }] });
  assert.deepEqual(contents[1], { role: "model", parts: [{ text: "ok" }, { functionCall: { name: "find_email", args: { q: "invoice" } }, thoughtSignature: "SIG1" }] });
  assert.deepEqual(contents[2], { role: "user", parts: [{ functionResponse: { name: "find_email", response: { content: "3 matches" } } }, { text: "Answer now." }] });
});

test("round trip: an Anthropic-minted tool call replayed to Gemini 3 carries the validator-skip signature; errors map to {error}", () => {
  const contents = toGeminiContents([
    { role: "user", content: "x" },
    { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "a", input: {} }, { type: "tool_use", id: "toolu_2", name: "b", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "nope", is_error: true }] as never },
  ], "gemini-3-flash");
  const parts = contents[1].parts;
  assert.equal(parts[0].thoughtSignature, "skip_thought_signature_validator");
  assert.equal(parts[1].thoughtSignature, undefined, "only the first call of a batch");
  assert.deepEqual(contents[2].parts[0], { functionResponse: { name: "a", response: { error: "nope" } } });
  // Older models never get a synthetic signature.
  const old = toGeminiContents([{ role: "assistant", content: [{ type: "tool_use", id: "t", name: "a", input: {} }] }], "gemini-2.5-pro");
  assert.equal(old[0].parts[0].thoughtSignature, undefined);
});

test("images on the live turn become inlineData parts", () => {
  const contents = toGeminiContents([{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }, { type: "text", text: "what's this" }] }], "gemini-2.5-pro");
  assert.deepEqual(contents[0].parts, [{ inlineData: { mimeType: "image/png", data: "AAAA" } }, { text: "what's this" }]);
});

test("geminiCaller: an empty, unclean turn throws so the router falls back; onToken gets the whole text once", async () => {
  const bad = stubFetch({ candidates: [{ content: { parts: [] }, finishReason: "MALFORMED_FUNCTION_CALL" }] });
  await assert.rejects(geminiCaller("k", "gemini-2.5-pro", 100, { fetchImpl: bad.fetchImpl })({ system: "", tools: [], messages: [{ role: "user", content: "x" }] }), /MALFORMED_FUNCTION_CALL/);
  const tokens: string[] = [];
  const good = stubFetch(textReply("All set."));
  await geminiCaller("k", "gemini-2.5-pro", 100, { fetchImpl: good.fetchImpl, onToken: (t) => tokens.push(t) })({ system: "", tools: [], messages: [{ role: "user", content: "x" }] });
  assert.deepEqual(tokens, ["All set."]);
});
