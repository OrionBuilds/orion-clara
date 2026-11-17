// Clara — memory consolidation.
//
// Periodic job (wired into scheduler.ts, weekly) that reads a principal's raw onboarding Q&A
// transcript and writes a synthesized "profile at a glance" block at the top of their
// contacts/*.md file — the reasoningbank "distill, don't discard" pattern: the raw transcript
// stays intact below, but briefs/gifts/tasks can read a short summary instead of re-parsing
// every Q&A block every time.
//
// Only regenerates when the raw content has actually changed since the last consolidation
// (tracked via an HTML comment hash marker), so this is cheap to run often.

import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { loadConfig } from "./config";
import { classify, pickEngine } from "./sensitivity";
import { CLARA_IDENTITY } from "./persona";
import type { PrincipalId } from "./types";
import { lmStudioBaseUrl, lmStudioChatModel } from "./lmstudio";
import { recordLMStudioCall } from "./usage";

const MARKER_RX = /<!-- consolidated-hash: ([a-f0-9]{40}) -->\n?/;
const SUMMARY_HEADING = "## Profile at a glance";

function hash(text: string): string {
  return crypto.createHash("sha1").update(text).digest("hex");
}

function stripPriorSummary(raw: string): string {
  // Remove a previously-generated marker + summary block (from the marker up to the next "## ").
  const markerMatch = raw.match(MARKER_RX);
  if (!markerMatch) return raw;
  const afterMarker = raw.slice(markerMatch.index! + markerMatch[0].length);
  const headingIdx = afterMarker.indexOf(SUMMARY_HEADING);
  if (headingIdx === -1) return raw.slice(0, markerMatch.index);
  const rest = afterMarker.slice(headingIdx + SUMMARY_HEADING.length);
  const nextHeadingIdx = rest.search(/\n## /);
  const tail = nextHeadingIdx === -1 ? "" : rest.slice(nextHeadingIdx);
  return raw.slice(0, markerMatch.index) + tail.replace(/^\n+/, "\n");
}

async function llmSummarize(rawText: string): Promise<string> {
  const prompt = `Read this onboarding transcript (a series of Q&A pairs about a person) and write a short "profile at a glance" — 5-10 bullet points capturing the durable facts (names, dates, preferences, allergies, key relationships). Skip filler. Return ONLY the bullet list, no heading, no preamble.\n\n${rawText.slice(0, 8000)}`;

  const hint = classify({ text: rawText });
  const engine = pickEngine(hint, "lmstudio");

  try {
    const base = await lmStudioBaseUrl();
    const model = await lmStudioChatModel();
    const r = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [{ role: "system", content: CLARA_IDENTITY }, { role: "user", content: prompt }],
        temperature: 0.2,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (r.ok) {
      const j = await r.json() as { choices: { message: { content: string } }[] };
      void recordLMStudioCall(j, { purpose: "consolidate" });
      const text = j.choices?.[0]?.message?.content?.trim();
      if (text) return text;
    }
  } catch { /* fall through, unless sensitive */ }

  if (hint.sensitive || engine === "lmstudio" || engine === "ollama") {
    throw new Error("consolidation requires local LM Studio and it's unreachable — skipping this pass");
  }

  // OS model setting (agentSettings.ts) → its fallback → this site's built-in model.
  const { callModelText } = await import("./modelCall");
  const out = await callModelText({ site: "consolidate", purpose: "consolidate", defaultModel: "claude-opus-4-8", system: CLARA_IDENTITY, prompt, maxTokens: 500 });
  if (out) return out.text;
  throw new Error("no LLM available for consolidation");
}

export async function consolidateProfile(principal: PrincipalId): Promise<{ changed: boolean; reason?: string }> {
  const cfg = await loadConfig();
  const file = path.join(cfg.vaultRoot, "contacts", `${principal}.md`);
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    return { changed: false, reason: "no profile file yet" };
  }

  const bodyOnly = stripPriorSummary(raw);
  const currentHash = hash(bodyOnly);
  const existingMarker = raw.match(MARKER_RX);
  if (existingMarker && existingMarker[1] === currentHash) {
    return { changed: false, reason: "unchanged since last consolidation" };
  }

  let summary: string;
  try {
    summary = await llmSummarize(bodyOnly);
  } catch (e) {
    return { changed: false, reason: (e as Error).message };
  }

  // Insert marker + summary right after the first line (the "# Name" header), before the raw
  // Q&A transcript — which stays fully intact below.
  const lines = bodyOnly.split("\n");
  const headerEnd = lines.findIndex((l) => l.startsWith("# ")) + 1;
  const before = lines.slice(0, headerEnd).join("\n");
  const after = lines.slice(headerEnd).join("\n");
  const rebuilt = [
    before,
    "",
    `<!-- consolidated-hash: ${currentHash} -->`,
    SUMMARY_HEADING,
    "",
    summary,
    after,
  ].join("\n");

  await fs.writeFile(file, rebuilt, "utf8");
  return { changed: true };
}

export async function consolidateAll(): Promise<Record<PrincipalId, { changed: boolean; reason?: string }>> {
  const owner = await consolidateProfile("owner");
  return { owner };
}
