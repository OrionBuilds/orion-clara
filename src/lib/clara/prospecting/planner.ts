// planner.ts — §6 natural-language → JobSpec. Tier 3 (Anthropic Messages API) only: this runs once
// per plan ask, never in a volume loop, so the API's quality is worth the small, metered cost.
// Grounded on the ICP snapshot (knowledge/sources.json's "ICP" entry) via knowledge.ts's
// `refreshKnowledgeSource`, refreshed when the on-disk snapshot is more than 7 days old.

import { promises as fs } from "node:fs";
import path from "node:path";
import { normalizeJobSpec, describeSpec, type NormalizeResult } from "./jobSpec";
import { runTier, type RunTierOpts, type RunTierResult } from "./llm";
import { BUSINESS_NAME } from "./branding";

/** The ICP doc's Drive id (the knowledge/sources.json entry aliased "ICP"), from CLARA_ICP_DRIVE_ID.
 *  Read from env rather than parsed out of that file at runtime — it's one id, and the planner must
 *  still run (ungrounded) if that file is ever reorganized. Unset → no ICP grounding. */
export const ICP_SOURCE_ID = (process.env.CLARA_ICP_DRIVE_ID ?? "").trim();

const MAX_ICP_CHARS = 6_000;
const STALE_MS = 7 * 24 * 3600_000;

function knowledgeDir(): string {
  return process.env.CLARA_KNOWLEDGE_DIR ?? path.join(process.cwd(), "knowledge");
}

/**
 * The ICP snapshot text, refreshing it first if the on-disk copy is >7 days old (or missing). A
 * refresh failure (no Drive access, deleted doc, offline…) falls back to whatever snapshot already
 * exists, and to "" if there is none — the planner runs ungrounded rather than failing the plan.
 */
export async function icpSnapshot(): Promise<string> {
  if (!ICP_SOURCE_ID) return "";
  const file = path.join(knowledgeDir(), "sources", `${ICP_SOURCE_ID}.md`);
  let stale = true;
  try {
    const st = await fs.stat(file);
    stale = Date.now() - st.mtimeMs > STALE_MS;
  } catch {
    stale = true;
  }
  if (stale) {
    try {
      const { refreshKnowledgeSource } = await import("../knowledge");
      await refreshKnowledgeSource(ICP_SOURCE_ID, { notify: false });
    } catch {
      /* best-effort — fall through to whatever snapshot is already on disk */
    }
  }
  try {
    let text = await fs.readFile(file, "utf8");
    text = text.replace(/^---[\s\S]*?---\n\n/, "");
    return text.length > MAX_ICP_CHARS ? text.slice(0, MAX_ICP_CHARS) : text;
  } catch {
    return "";
  }
}

export function buildPlannerPrompt(requestText: string, icp: string, todayIso: string): string {
  return [
    "You turn a plain-English prospecting request into a JSON job spec for Clara's research engine.",
    "",
    "Return ONLY a JSON object, no prose, matching this shape:",
    '{"title": string, "industry": string[], "location": {"label": string, "city"?: string, "state"?: string, "radius_miles"?: number}, "requirements": {"estimated_revenue_min"?: number, "estimated_revenue_max"?: number, "min_rating"?: number, "min_reviews"?: number, "min_employees"?: number, "max_employees"?: number}, "enrichments": string[], "sources": string[], "max_records"?: number, "gates"?: {"deep_research_min"?: number, "contact_search_min"?: number, "mobile_search_min"?: number, "allow_mobile"?: boolean}, "queries"?: string[]}',
    "",
    "Rules:",
    "- industry and location are required; infer a sensible radius when none is given (default 100 miles).",
    "- enrichments: choose from website, google_rating, review_count, owner, email, mobile, employees, technology, advertising, hiring, revenue. Only include what the request actually implies (plus website/rating/employees/technology as sensible defaults) — don't add email/mobile unless the person wants to contact someone.",
    "- Never invent a gate number below the system floor; only set gates.* when the person named a specific number.",
    "- max_records defaults to 5000 — set it lower only if the person asked for a short list.",
    "",
    icp
      ? `Reference — ${BUSINESS_NAME}'s Ideal Customer Profile notes (use only to recognize a loosely-named vertical, e.g. "home services"; never let it override what the person actually asked for):\n<<<ICP\n${icp}\nICP>>>`
      : "",
    "",
    `Today's date: ${todayIso}.`,
    "",
    `Request: "${requestText}"`,
  ].filter((l) => l !== "").join("\n");
}

export interface PlanResult extends NormalizeResult {
  requestText: string;
  raw?: unknown;
  engineError?: string;
}

function extractJsonObject(text: string): unknown {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("no JSON object in the model's answer");
  return JSON.parse(m[0]);
}

export type PlannerRunFn = (tier: 3, prompt: string, opts: RunTierOpts) => Promise<RunTierResult>;

/** NL → JobSpec. `opts.run`/`opts.icp` are injection points for tests — production callers omit
 *  both and get the real tier-3 model + the live ICP snapshot. */
export async function planFromText(
  requestText: string,
  now: Date = new Date(),
  opts: { run?: PlannerRunFn; icp?: string } = {},
): Promise<PlanResult> {
  const run = opts.run ?? runTier;
  const icp = opts.icp ?? (await icpSnapshot().catch(() => ""));
  const prompt = buildPlannerPrompt(requestText, icp, now.toISOString().slice(0, 10));
  const r = await run(3, prompt, { purpose: "prospect:plan", json: true, maxTokens: 1024, temperature: 0.1 });
  if (!r.ok || !r.text) {
    return { ok: false, errors: [r.error ?? "the planner model didn't answer"], warnings: [], requestText, engineError: r.error };
  }
  let raw: unknown;
  try {
    raw = extractJsonObject(r.text);
  } catch (e) {
    return { ok: false, errors: [`the planner model's answer wasn't valid JSON: ${e instanceof Error ? e.message : String(e)}`], warnings: [], requestText };
  }
  const normalized = normalizeJobSpec(raw);
  return { ...normalized, requestText, raw };
}

export { describeSpec };
