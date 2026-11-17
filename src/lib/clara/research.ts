// Clara — source-grounded research and the weekly audio digest.
//
// This used to drive the owner's personal Google NotebookLM account through the `notebooklm` CLI.
// That is gone. NotebookLM was the worst-behaved dependency in the stack: per the library's own
// keepalive notes, Google's `__Secure-1PSIDTS` cookie has a MINUTES-TO-HOURS validity window and
// only rotates when something exercises an authenticated client, so it needed a 6h keepalive job
// just to stay alive — and when it lapsed, the only repair was the owner at a browser. It could not be
// fixed from a phone, and it was filling the morning brief with the same "session is no longer
// valid" alert sixteen times in a single run.
//
// The two capabilities it provided are preserved, on things Clara already has:
//
//   • researchTopic — fetch the sources, hand them to Clara's own brain (engines.complete), and
//     return a grounded answer. Same signature, same tier gate, same prompt-injection treatment,
//     so travel.ts / briefs.ts / /api/research/run did not have to change.
//   • generateAudioDigest — ElevenLabs TTS via the existing elevenTTSAudio() in channels.ts,
//     already configured with Clara's voice. No new provider, no new key.
//
// Nothing here shells out, nothing holds a browser cookie, and nothing can expire.

import { promises as fs } from "node:fs";
import path from "node:path";
import { detectPromptInjection } from "./injection";
import { notifyOwner } from "./notify";
import { can } from "./tiers";
import { complete } from "./engines";
import { elevenTTSAudio } from "./channels";
import type { PrincipalId } from "./types";
import { OWNER_FIRST } from "./owner";

/** How much of any single source we feed the model. Keeps one huge page from crowding the prompt. */
const MAX_SOURCE_CHARS = 20_000;
/** Total across all sources. */
const MAX_TOTAL_CHARS = 60_000;

export interface ResearchTopicRequest {
  title: string;
  sources: string[]; // URLs, file paths, or inline text — auto-detected below
  question: string;
  /** Defaults to "owner". Routes must pass the verified session principal, never a body value. */
  requestor?: PrincipalId;
}
export interface ResearchTopicResult {
  ok: boolean;
  /** Retained for callers that stored it; no longer a NotebookLM id, just a local correlation id. */
  notebookId?: string;
  answer?: string;
  error?: string;
}

interface LoadedSource { label: string; text: string }

/**
 * Resolve one source to text. A source is a URL, a local file path, or literal text — the same
 * three shapes the old CLI auto-detected, so callers are unchanged.
 */
async function loadSource(src: string): Promise<LoadedSource> {
  const s = src.trim();

  if (/^https?:\/\//i.test(s)) {
    try {
      const r = await fetch(s, { signal: AbortSignal.timeout(20_000), redirect: "follow" });
      if (!r.ok) return { label: s, text: `[could not fetch: HTTP ${r.status}]` };
      const raw = await r.text();
      // Crude de-tagging is deliberate: this is context for a model, not something we render.
      const text = raw
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      return { label: s, text: text.slice(0, MAX_SOURCE_CHARS) };
    } catch (e) {
      return { label: s, text: `[could not fetch: ${e instanceof Error ? e.message : String(e)}]` };
    }
  }

  // A path only counts if it actually exists; otherwise treat the string as inline text, which is
  // what a caller passing a paragraph expects.
  if (/[\\/]/.test(s) || /\.\w{1,5}$/.test(s)) {
    try {
      const text = await fs.readFile(s, "utf8");
      return { label: path.basename(s), text: text.slice(0, MAX_SOURCE_CHARS) };
    } catch {
      /* fall through to inline */
    }
  }

  return { label: "inline", text: s.slice(0, MAX_SOURCE_CHARS) };
}

export async function researchTopic(req: ResearchTopicRequest): Promise<ResearchTopicResult> {
  // Enforced here rather than at the route so every path — /api/research/run, travel.ts, the
  // scheduler — goes through the tier table. Same placement as google-drive.ts:178.
  const decision = await can(req.requestor ?? "owner", "research.run");
  if (!decision.allow) return { ok: false, error: `blocked by tier: ${decision.reason}` };

  if (!req.sources.length) return { ok: false, error: "at least one source is required" };

  const loaded: LoadedSource[] = [];
  let budget = MAX_TOTAL_CHARS;
  for (const src of req.sources) {
    if (budget <= 0) break;
    const s = await loadSource(src);
    const clipped: LoadedSource = { ...s, text: s.text.slice(0, budget) };
    budget -= clipped.text.length;
    loaded.push(clipped);
  }
  if (!loaded.some((s) => s.text && !s.text.startsWith("[could not fetch"))) {
    return { ok: false, error: "none of the sources could be read" };
  }

  const corpus = loaded
    .map((s, i) => `--- SOURCE ${i + 1}: ${s.label} ---\n${s.text}`)
    .join("\n\n");

  let answer: string;
  try {
    answer = await complete({
      system:
        "You answer strictly from the SOURCES provided. Cite the source number inline like [1] for " +
        "every claim. If the sources do not contain the answer, say so plainly rather than filling " +
        "the gap from memory. Be concrete and brief.",
      prompt: `Research topic: ${req.title}\n\nQuestion: ${req.question}\n\n${corpus}`,
      timeoutMs: 120_000,
    });
  } catch (e) {
    return { ok: false, error: `research failed: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!answer?.trim()) return { ok: false, error: "research produced an empty answer" };

  // The answer is synthesized from web/Drive sources Clara didn't write — same untrusted-content
  // treatment as inbound SMS/email. Callers (travel.ts, briefs.ts, /api/research/run) feed this
  // into approval drafts, briefs, and the UI, so it's flagged here once rather than at every site.
  const correlationId = `research-${Date.now().toString(36)}`;
  const verdict = detectPromptInjection(answer);
  if (verdict.triggered) {
    await notifyOwner({
      kind: "injection.detected",
      priority: "critical",
      text: `Possible prompt injection in research findings ("${req.title}"): ${verdict.reasons.join(", ")}.`,
      dedupeKey: `injection:research:${correlationId}:${new Date().toISOString().slice(0, 10)}`,
    }).catch(() => {});
  }
  if (verdict.hardBlock) {
    return {
      ok: false,
      notebookId: correlationId,
      error: `Refusing to return research findings for "${req.title}" — confirmed prompt-injection marker (${verdict.reasons.join(", ")}). ${OWNER_FIRST}'s been paged.`,
    };
  }

  return { ok: true, notebookId: correlationId, answer };
}

export interface AudioDigestRequest {
  /** Ignored — retained so existing callers compile unchanged. */
  notebookId?: string;
  /** The text to speak. Previously a prompt for NotebookLM; now the script itself. */
  prompt: string;
  format?: "deep-dive" | "brief" | "critique" | "debate";
  outPath: string; // absolute path to save the audio
}
export interface AudioDigestResult { ok: boolean; path?: string; bytes?: number; error?: string }

/**
 * Speak `prompt` to a file. ElevenLabs rather than a NotebookLM audio overview: the voice is
 * already configured for Clara's calls, so this needs no new provider and cannot expire.
 *
 * Semantic change callers should know about — NotebookLM generated a two-host discussion ABOUT
 * the sources; this reads the supplied text aloud. briefs.ts therefore passes the composed weekly
 * review itself, not a prompt describing it.
 */
export async function generateAudioDigest(req: AudioDigestRequest): Promise<AudioDigestResult> {
  const script = req.prompt?.trim();
  if (!script) return { ok: false, error: "nothing to narrate" };

  const { buf, error } = await elevenTTSAudio(script);
  if (error || !buf) return { ok: false, error: error ?? "text-to-speech returned no audio" };

  try {
    await fs.mkdir(path.dirname(req.outPath), { recursive: true });
    await fs.writeFile(req.outPath, buf);
    const st = await fs.stat(req.outPath);
    // A zero-byte write would otherwise be reported as success and the /brief player would render
    // a dead <audio> element.
    if (st.size === 0) return { ok: false, error: `wrote an empty audio file at ${req.outPath}` };
    return { ok: true, path: req.outPath, bytes: st.size };
  } catch (e) {
    return { ok: false, error: `could not write audio: ${e instanceof Error ? e.message : String(e)}` };
  }
}
