// llm.ts — the three inference tiers prospecting uses.
//
// Tier 1: LM Studio (free), cheap classification. Tier 2: LM Studio by default, or Haiku 4.5 when
// CLARA_PROSPECT_TIER2_ENGINE=haiku or LM Studio is down — bulk extraction/qualification. Tier 3:
// the Anthropic Messages API directly (same direct-fetch pattern as business-call-brain.ts), metered
// via usage.ts under a `prospect:*` purpose. Never the `claude` CLI — too slow and unmetered for
// volume, and the CLI's spend isn't exempt from the general caps the way `prospect:*` purposes are.

import { lmStudioBaseUrl, lmStudioChatModel } from "../lmstudio";
import { recordLMStudioCall, costFromUsage } from "../usage";
import { currentSpendContext, recordProviderCall } from "./ledger";

export type Tier = 1 | 2 | 3;

export interface RunTierOpts {
  system?: string;
  maxTokens?: number;
  temperature?: number;
  /** "prospect:plan" | "prospect:classify" | "prospect:extract" | "prospect:qualify" | "prospect:adjudicate" | … */
  purpose: string;
  json?: boolean;
}

export interface RunTierResult {
  ok: boolean;
  text?: string;
  engine: string;
  model?: string;
  error?: string;
}

function extractJsonBlock(s: string): string {
  const m = s.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
  return m ? m[0] : s;
}

export function tier2Engine(): "lmstudio" | "haiku" {
  const v = (process.env.CLARA_PROSPECT_TIER2_ENGINE ?? "lmstudio").trim().toLowerCase();
  return v === "haiku" ? "haiku" : "lmstudio";
}

// §32: "claude-opus-5" ($5/$25/MTok) for tier 3, "claude-haiku-4-5" ($1/$5/MTok) for tier 2's paid
// fallback — see usage.ts's MODEL_PRICES for the actual numbers these ids are billed at.
export const OPUS_MODEL = process.env.CLARA_PROSPECT_OPUS_MODEL?.trim() || "claude-opus-5";
export const HAIKU_MODEL = process.env.CLARA_PROSPECT_HAIKU_MODEL?.trim() || "claude-haiku-4-5";

async function callLmStudio(prompt: string, opts: RunTierOpts): Promise<RunTierResult> {
  try {
    const base = await lmStudioBaseUrl();
    const model = await lmStudioChatModel();
    const r = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [...(opts.system ? [{ role: "system", content: opts.system }] : []), { role: "user", content: prompt }],
        temperature: opts.temperature ?? 0.2,
        ...(opts.json ? { response_format: { type: "json_object" } } : {}),
        max_tokens: opts.maxTokens ?? 500,
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!r.ok) return { ok: false, engine: "lmstudio", error: `lmstudio ${r.status}` };
    const j = (await r.json()) as { choices?: { message?: { content?: string } }[] };
    void recordLMStudioCall(j, { purpose: opts.purpose, model });
    const content = j.choices?.[0]?.message?.content ?? "";
    return { ok: true, engine: "lmstudio", model, text: opts.json ? extractJsonBlock(content) : content };
  } catch (e) {
    return { ok: false, engine: "lmstudio", error: e instanceof Error ? e.message : String(e) };
  }
}

/** Bill a paid model call to the job the current stage handler is running for, so the OS budget
 *  trigger counts AI spend too. Outside a job (replies, call briefs) usage.ts's own ledger is the
 *  only record, as before. */
async function billJob(tier: Tier, engine: string, model: string, usage: { tokensIn?: number; tokensOut?: number }): Promise<void> {
  const ctx = currentSpendContext();
  if (!ctx?.jobId) return;
  const costUsd = costFromUsage(engine, { model, tokensIn: usage.tokensIn ?? 0, tokensOut: usage.tokensOut ?? 0 }) ?? 0;
  await recordProviderCall({ provider: `llm_t${tier}`, jobId: ctx.jobId, companyId: ctx.companyId, costUsd, cached: false, status: "ok" });
}

/**
 * The paid tier, through modelCall.ts so the OS per-agent settings apply. Tier 3 honours the OS
 * model (primary → fallback → OPUS_MODEL); the Haiku paths (tier 2 paid engine, tier 1/2 fallback)
 * are a cost tier and keep HAIKU_MODEL. Status, budget, rate and max_tokens limits apply to both.
 */
async function callAnthropic(prompt: string, opts: RunTierOpts, model: string, tier: Tier): Promise<RunTierResult> {
  const { callModelText } = await import("../modelCall");
  const out = await callModelText({
    site: `prospect-t${tier}`, purpose: opts.purpose, defaultModel: model,
    system: opts.system, prompt, maxTokens: opts.maxTokens ?? 1024, json: opts.json, timeoutMs: 30_000,
    honourModelSetting: tier === 3 && model === OPUS_MODEL,
  });
  if (!out) return { ok: false, engine: "anthropic", model, error: "no paid model answered (see [model-call] log)" };
  const engine = out.provider === "google" ? "google" : "anthropic";
  await billJob(tier, engine, out.model, out.usage).catch(() => undefined);
  return { ok: true, engine, model: out.model, text: opts.json ? extractJsonBlock(out.text) : out.text };
}

/**
 * Run one prompt at the given tier. Tiers 1 and 2 fall back to Haiku when LM Studio fails. Tier 2 tries LM Studio first unless
 * `tier2Engine()` says `haiku`, and falls back to Haiku if LM Studio fails. Tier 3 is always the
 * Anthropic API at `OPUS_MODEL`.
 */
export async function runTier(tier: Tier, prompt: string, opts: RunTierOpts): Promise<RunTierResult> {
  if (tier === 3) return callAnthropic(prompt, opts, OPUS_MODEL, 3);
  if (tier === 2 && tier2Engine() === "haiku") {
    const viaHaiku = await callAnthropic(prompt, opts, HAIKU_MODEL, 2);
    if (viaHaiku.ok) return viaHaiku;
  }
  const local = await callLmStudio(prompt, opts);
  if (local.ok) return local;
  // Tier 1 falls back too (2026-10-07): with LM Studio down, every stage-30 classify returned
  // "no model resolved", was read as "not in industry", and 379 companies were silently dropped.
  return callAnthropic(prompt, opts, HAIKU_MODEL, tier);
}
