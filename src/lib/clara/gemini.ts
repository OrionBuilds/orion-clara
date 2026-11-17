// Clara — Google Gemini caller (REST generateContent), used when the OS settings pick a `google` model.
//
// Two entry points, both plain fetch like every other model call in CLARA (no SDK dependency):
//
//   geminiGenerateText — one system prompt + text turns → text. For the direct-call sites
//                        (documents, legal, telephony, SMS, …) via modelCall.ts.
//   geminiCaller       — the intent router's callModel contract: Anthropic-shaped messages and tool
//                        definitions in, Anthropic-shaped ContentBlock[] out, translated to Gemini
//                        function calling both ways so runIntentLoop, its gates and its three
//                        defences never learn which vendor answered.
//
// Credentials: GEMINI_API_KEY, or GOOGLE_AI_API_KEY. The OS stores its own Gemini key sealed and
// agent-settings-get never returns keys, so CLARA brings her own. The key travels in the
// x-goog-api-key header, never in the URL.
//
// Thought signatures: Gemini 3 models attach a signature to function-call parts and reject a later
// turn that replays the call without it. ContentBlock has no field for it, and an extra property
// would be rejected by Anthropic if a turn falls back mid-loop — so signatures are kept in a small
// map keyed by the tool_use id this module minted, and re-attached when that call is replayed.

import type { AnthropicMessage, ContentBlock, ToolResultBlock } from "@autom8ionlab/agent-core";

export const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";

export function geminiApiKey(env: Record<string, string | undefined> = process.env): string | null {
  return env.GEMINI_API_KEY?.trim() || env.GOOGLE_AI_API_KEY?.trim() || null;
}

/** "models/gemini-2.5-pro" and "gemini-2.5-pro" both name the same model. */
export function geminiModelId(model: string): string {
  return model.trim().replace(/^models\//, "");
}

/**
 * Extra output budget for a thinking model's internal reasoning. Gemini counts thinking tokens
 * against maxOutputTokens, so a 240-token phone reply on a thinking model can come back empty.
 * CLARA_GEMINI_THINKING_TOKENS (default 1024; 0 disables) is added on top of the call's own cap.
 */
export function thinkingHeadroom(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.CLARA_GEMINI_THINKING_TOKENS ?? 1024);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 1024;
}

export interface GeminiUsage { tokensIn?: number; tokensOut?: number; tokensTotal?: number }

interface GeminiPart {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  inlineData?: { mimeType: string; data: string };
  functionCall?: { id?: string; name: string; args?: Record<string, unknown> };
  functionResponse?: { id?: string; name: string; response: Record<string, unknown> };
}
interface GeminiContent { role: "user" | "model"; parts: GeminiPart[] }
interface GeminiResponse {
  candidates?: { content?: { parts?: GeminiPart[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number; totalTokenCount?: number };
}

export function usageFrom(json: unknown): GeminiUsage {
  const u = (json as GeminiResponse)?.usageMetadata;
  if (!u) return {};
  const out = (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0);
  return { tokensIn: u.promptTokenCount, tokensOut: out || undefined, tokensTotal: u.totalTokenCount };
}

interface RequestOpts {
  apiKey: string;
  model: string;
  body: Record<string, unknown>;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

async function generateContent(o: RequestOpts): Promise<GeminiResponse> {
  const url = `${GEMINI_API_BASE}/models/${encodeURIComponent(geminiModelId(o.model))}:generateContent`;
  const r = await (o.fetchImpl ?? fetch)(url, {
    method: "POST",
    headers: { "x-goog-api-key": o.apiKey, "content-type": "application/json" },
    body: JSON.stringify(o.body),
    signal: AbortSignal.timeout(o.timeoutMs ?? 90_000),
  });
  if (!r.ok) throw new Error(`Gemini ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}`);
  const j = await r.json() as GeminiResponse;
  if (!j.candidates?.length) {
    throw new Error(`Gemini returned no candidates${j.promptFeedback?.blockReason ? ` (blocked: ${j.promptFeedback.blockReason})` : ""}`);
  }
  return j;
}

function visibleText(parts: GeminiPart[] | undefined): string {
  return (parts ?? []).filter((p) => typeof p.text === "string" && !p.thought).map((p) => p.text as string).join("");
}

// ── Plain text generation ──────────────────────────────────────────────────────────────────────

export interface GeminiTextOpts {
  apiKey: string;
  model: string;
  system?: string;
  messages: { role: "user" | "assistant"; content: string }[];
  maxTokens: number;
  temperature?: number;
  /** Ask for a JSON object back (responseMimeType application/json). */
  json?: boolean;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  thinkingTokens?: number;
}

export async function geminiGenerateText(o: GeminiTextOpts): Promise<{ text: string; usage: GeminiUsage; raw: unknown }> {
  const body: Record<string, unknown> = {
    contents: o.messages.filter((m) => m.content).map((m): GeminiContent => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })),
    generationConfig: {
      maxOutputTokens: o.maxTokens + (o.thinkingTokens ?? thinkingHeadroom()),
      ...(typeof o.temperature === "number" ? { temperature: o.temperature } : {}),
      ...(o.json ? { responseMimeType: "application/json" } : {}),
    },
  };
  if (o.system) body.systemInstruction = { parts: [{ text: o.system }] };
  const j = await generateContent({ apiKey: o.apiKey, model: o.model, body, timeoutMs: o.timeoutMs, fetchImpl: o.fetchImpl });
  const cand = j.candidates?.[0];
  const text = visibleText(cand?.content?.parts).trim();
  if (!text) throw new Error(`Gemini returned no text (finishReason ${cand?.finishReason ?? "unknown"})`);
  return { text, usage: usageFrom(j), raw: j };
}

// ── Tool calling (intent router) ───────────────────────────────────────────────────────────────

/** JSON Schema keys Gemini's function-declaration schema (an OpenAPI subset) accepts. */
const SCHEMA_KEYS = new Set(["type", "format", "description", "nullable", "enum", "properties", "required", "items", "minItems", "maxItems", "minimum", "maximum", "anyOf"]);

/**
 * Narrow a tool's JSON Schema to what Gemini accepts. Unknown keys (additionalProperties, default,
 * $schema, pattern, …) are dropped rather than sent, because Gemini rejects the whole request over
 * one of them. ["string","null"] becomes type STRING + nullable.
 */
export function toGeminiSchema(schema: unknown): Record<string, unknown> {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) return { type: "OBJECT", properties: {} };
  const s = schema as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(s)) {
    if (!SCHEMA_KEYS.has(k)) continue;
    if (k === "type") {
      const types = (Array.isArray(v) ? v : [v]).filter((t): t is string => typeof t === "string");
      const real = types.filter((t) => t !== "null");
      if (real[0]) out.type = real[0].toUpperCase();
      if (types.includes("null")) out.nullable = true;
    } else if (k === "properties" && typeof v === "object" && v !== null) {
      out.properties = Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([pk, pv]) => [pk, toGeminiSchema(pv)]));
    } else if (k === "items") {
      out.items = toGeminiSchema(v);
    } else if (k === "anyOf" && Array.isArray(v)) {
      out.anyOf = v.map(toGeminiSchema);
    } else if (k === "enum" && Array.isArray(v)) {
      out.enum = v.filter((e) => e !== null).map(String);
    } else {
      out[k] = v;
    }
  }
  if (out.enum && !out.type) out.type = "STRING";
  if (Array.isArray(out.required) && out.properties && typeof out.properties === "object") {
    const props = out.properties as Record<string, unknown>;
    out.required = (out.required as unknown[]).filter((r): r is string => typeof r === "string" && r in props);
  }
  if (!out.type && out.properties) out.type = "OBJECT";
  return out;
}

const SIGNATURES = new Map<string, string>();
const SIGNATURES_MAX = 500;
function rememberSignature(id: string, sig: string): void {
  SIGNATURES.set(id, sig);
  if (SIGNATURES.size > SIGNATURES_MAX) SIGNATURES.delete(SIGNATURES.keys().next().value as string);
}
/** Test seam. */
export function clearGeminiSignatures(): void { SIGNATURES.clear(); }

/**
 * Gemini 3 validates a signature on every function call replayed from the current turn. A call this
 * module did not mint (an Anthropic turn before a mid-loop switch) has none, so it carries the
 * documented validator-skip value instead. Older models ignore signatures entirely.
 */
const SKIP_SIGNATURE = "skip_thought_signature_validator";

/** Anthropic-shaped turns → Gemini contents. Exported for tests. */
export function toGeminiContents(messages: AnthropicMessage[], model: string): GeminiContent[] {
  const needsSignature = /^gemini-3/.test(geminiModelId(model));
  const toolNames = new Map<string, string>();
  const out: GeminiContent[] = [];
  for (const m of messages) {
    const role = m.role === "assistant" ? "model" : "user";
    if (typeof m.content === "string") {
      if (m.content) out.push({ role, parts: [{ text: m.content }] });
      continue;
    }
    const parts: GeminiPart[] = [];
    let firstCall = true;
    for (const b of m.content as (ContentBlock | ToolResultBlock)[]) {
      if (b.type === "text" && typeof (b as ContentBlock).text === "string" && (b as ContentBlock).text) {
        parts.push({ text: (b as ContentBlock).text });
      } else if (b.type === "image" && (b as ContentBlock).source?.data) {
        const src = (b as ContentBlock).source!;
        parts.push({ inlineData: { mimeType: src.media_type, data: src.data } });
      } else if (b.type === "tool_use") {
        const cb = b as ContentBlock;
        const id = String(cb.id ?? "");
        const name = String(cb.name ?? "");
        toolNames.set(id, name);
        const part: GeminiPart = { functionCall: { name, args: (cb.input ?? {}) as Record<string, unknown> } };
        const sig = SIGNATURES.get(id);
        if (sig) part.thoughtSignature = sig;
        // Only the first call of a parallel batch carries a signature in Gemini's own output.
        else if (needsSignature && firstCall) part.thoughtSignature = SKIP_SIGNATURE;
        firstCall = false;
        parts.push(part);
      } else if (b.type === "tool_result") {
        const tr = b as ToolResultBlock;
        const name = toolNames.get(tr.tool_use_id) ?? "tool";
        parts.push({ functionResponse: { name, response: tr.is_error ? { error: tr.content } : { content: tr.content } } });
      }
    }
    if (parts.length) out.push({ role, parts });
  }
  return out;
}

/** Gemini response parts → Anthropic ContentBlock[] (text + tool_use). Exported for tests. */
export function fromGeminiParts(parts: GeminiPart[] | undefined): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  const text = visibleText(parts);
  if (text.trim()) blocks.push({ type: "text", text });
  for (const p of parts ?? []) {
    if (!p.functionCall?.name) continue;
    const id = p.functionCall.id || `gm_${Math.random().toString(36).slice(2, 12)}`;
    if (p.thoughtSignature) rememberSignature(id, p.thoughtSignature);
    blocks.push({ type: "tool_use", id, name: p.functionCall.name, input: p.functionCall.args ?? {} });
  }
  return blocks;
}

type CallInput = {
  system: string;
  tools: { name: string; description: string; input_schema: Record<string, unknown> }[];
  messages: AnthropicMessage[];
  toolChoice?: "auto" | "none";
};

/** Same contract as agent-core's anthropicCaller, against Gemini. */
export function geminiCaller(apiKey: string, model: string, maxTokens = 1200, opts: { fetchImpl?: typeof fetch; timeoutMs?: number; thinkingTokens?: number; onToken?: (t: string) => void } = {}) {
  return async (input: CallInput): Promise<ContentBlock[]> => {
    const body: Record<string, unknown> = {
      contents: toGeminiContents(input.messages, model),
      generationConfig: { maxOutputTokens: maxTokens + (opts.thinkingTokens ?? thinkingHeadroom()) },
    };
    if (input.system) body.systemInstruction = { parts: [{ text: input.system }] };
    if (input.tools.length) {
      body.tools = [{
        functionDeclarations: input.tools.map((t) => ({ name: t.name, description: t.description, parameters: toGeminiSchema(t.input_schema) })),
      }];
      body.toolConfig = { functionCallingConfig: { mode: input.toolChoice === "none" ? "NONE" : "AUTO" } };
    }
    const j = await generateContent({ apiKey, model, body, timeoutMs: opts.timeoutMs, fetchImpl: opts.fetchImpl });
    const cand = j.candidates?.[0];
    const blocks = fromGeminiParts(cand?.content?.parts);
    // An empty turn that didn't finish cleanly (MALFORMED_FUNCTION_CALL, SAFETY, MAX_TOKENS spent on
    // thinking) is a failure, not an answer — throw so the router's fallback chain takes over.
    if (!blocks.length && cand?.finishReason && cand.finishReason !== "STOP") {
      throw new Error(`Gemini returned an empty turn (finishReason ${cand.finishReason})`);
    }
    // Streaming parity with lmStudioStreamingCaller: no partial frames (a mis-assembled tool call
    // would be a wrong real-world action), the whole text once it lands.
    const text = blocks.filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n");
    if (text && opts.onToken) { try { opts.onToken(text); } catch { /* a broken consumer must not kill the turn */ } }
    return blocks;
  };
}
