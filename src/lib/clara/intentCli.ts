// CLARA — a `callModel` for the intent router that runs on the Claude Code CLI instead of the
// Anthropic API. Ported from FRIDAY's intentCli.ts after the 2026-08-13 API-credit outage silenced
// CLARA's router while FRIDAY (CLI-backed, no API key) sailed on: wired as a RUNTIME fallback in
// intent.ts, so an API failure degrades to subscription billing instead of a dead router.
//
// The CLI has no native tool-calling wire format, so the contract moves into the prompt: the tool
// catalog renders as JSON and the model must answer with a small JSON envelope parsed back into
// the ContentBlocks the shared loop already understands. Safety does NOT live here — gating,
// approvals, and the verbatim tool-result reply all sit in the loop downstream; this function can
// only ever propose. A hallucinated tool name resolves to nothing and is reported, not run.
//
// CLARA's engines lack completeJSON, so this uses complete({json:true}) + agent-core's extractJSON.

import { complete } from "./engines";
import { extractJSON } from "@autom8ionlab/agent-core";
import { OWNER_FIRST } from "./owner";

// Declared structurally rather than imported so this file has no build-order dependency on the
// shared package's type exports.
interface ContentBlock { type: string; text?: string; id?: string; name?: string; input?: unknown }
interface ToolResultBlock { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean }
interface AnthropicMessage { role: "user" | "assistant"; content: string | ContentBlock[] | ToolResultBlock[] }
interface WireTool { name: string; description: string; input_schema: Record<string, unknown> }

/** What the model is required to return. Anything else is treated as plain text. */
interface Envelope {
  text?: string;
  tool_calls?: { name?: string; input?: Record<string, unknown> }[];
}

/** Flatten one message's content into text the CLI can read — tool_use/tool_result included, so a
 *  second turn can see what its own previous call returned. */
function renderContent(content: AnthropicMessage["content"]): string {
  if (typeof content === "string") return content;
  const parts: string[] = [];
  type AnyBlock = { type: string; text?: string; name?: string; input?: unknown; content?: string; is_error?: boolean };
  for (const block of content as AnyBlock[]) {
    if (block.type === "text" && block.text) parts.push(block.text);
    else if (block.type === "tool_use") parts.push(`[called ${block.name} with ${JSON.stringify(block.input ?? {})}]`);
    else if (block.type === "tool_result") {
      const label = block.is_error ? "FAILED" : "returned";
      parts.push(`[${label}: ${String(block.content ?? "").slice(0, 4000)}]`);
    }
  }
  return parts.join("\n");
}

function renderConversation(messages: AnthropicMessage[]): string {
  return messages
    .map((m) => `${m.role === "user" ? OWNER_FIRST : "You"}: ${renderContent(m.content)}`)
    .join("\n\n");
}

function toolContract(tools: WireTool[]): string {
  const catalog = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema }));
  return [
    "You have a set of tools. They are the ONLY way you can affect anything or read live data.",
    "",
    "TOOLS:",
    JSON.stringify(catalog, null, 2),
    "",
    "Reply with ONLY a JSON object, no prose around it, in exactly this shape:",
    `{"text": "<what to say to ${OWNER_FIRST}>", "tool_calls": [{"name": "<tool name>", "input": {<arguments>}}]}`,
    "",
    "Rules:",
    '- To use tools, list them in "tool_calls". Use the exact tool names above and obey each input_schema.',
    '- To just talk, omit "tool_calls" (or pass an empty array) and put your reply in "text".',
    "- NEVER claim you did something unless you called the tool that does it. If you cannot do",
    "  something, say so plainly rather than describing it as done.",
    "- If a previous turn shows a tool result, use those real values in your answer. Do not invent",
    "  numbers, names, dates or outcomes that are not in a tool result.",
  ].join("\n");
}

/**
 * Build a `callModel` backed by the Claude CLI. Returns text-only content on any parse failure —
 * never throws — so a malformed envelope ends the turn honestly instead of crashing the router.
 */
export function cliCaller(timeoutMs = 120_000) {
  return async (input: { system: string; tools: WireTool[]; messages: AnthropicMessage[] }): Promise<ContentBlock[]> => {
    const raw = await complete({
      system: `${input.system}\n\n${toolContract(input.tools)}`,
      prompt: renderConversation(input.messages),
      json: true,
      timeoutMs,
    }).catch(() => "");

    const env = raw ? extractJSON<Envelope>(raw) : null;
    if (!env) return [{ type: "text", text: "" }];

    const blocks: ContentBlock[] = [];
    if (typeof env.text === "string" && env.text.trim()) blocks.push({ type: "text", text: env.text.trim() });

    const known = new Set(input.tools.map((t) => t.name));
    (env.tool_calls ?? []).forEach((call, i) => {
      if (!call?.name || !known.has(call.name)) return; // unknown tools drop here, not downstream
      blocks.push({
        type: "tool_use",
        id: `cli_${Date.now()}_${i}`, // stable within the turn — all the loop needs for pairing
        name: call.name,
        input: call.input ?? {},
      });
    });

    return blocks.length ? blocks : [{ type: "text", text: env.text?.trim() ?? "" }];
  };
}
