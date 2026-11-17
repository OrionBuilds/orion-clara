// Clara — one text-generation call, honouring the OS per-agent settings.
//
// The direct-call sites (documents, legal, consolidate, travel, telephony, SMS, business/inbound
// call brains, routine email replies, call summaries, mail triage, prospecting tiers) each used to
// hand-roll an Anthropic fetch with a pinned model. They now come through here, which:
//
//   1. refuses (returns null) when the OS has CLARA paused/disabled — every site already has a
//      polite canned fallback for "no model answered", so a pause degrades exactly like an outage;
//   2. honours rate_limit_per_minute and, when the OS sets one, daily_budget_usd;
//   3. narrows max_tokens to the OS limit (never raises it);
//   4. tries the OS model (primary, then fallback) and finally the site's own built-in model, so a
//      bad setting or a missing Gemini key costs a log line, never a reply;
//   5. meters every success in usage.ts like the old per-site record*Call lines did.
//
// It never throws. `null` means "no model answered" and the caller does what it did before.

import {
  getAgentSettings, settingsFor, modelChain, narrowIntCap, takeModelCallSlot, ignoredModelReason,
  type AgentSettingsSnapshot, type ModelTarget, type SupportedProvider,
} from "./agentSettings";
import { geminiApiKey, geminiGenerateText } from "./gemini";

export interface ModelTextOpts {
  /** Log label, e.g. "documents". */
  site: string;
  /** Ledger purpose (usage.ts) — grouped in the spend report. */
  purpose: string;
  /** The site's built-in Anthropic model — used when the OS sets none, and as the last resort. */
  defaultModel: string;
  system?: string;
  prompt: string;
  maxTokens: number;
  timeoutMs?: number;
  temperature?: number;
  /** Ask the model for a JSON object (Gemini: responseMimeType). Callers still parse defensively. */
  json?: boolean;
  /**
   * false for cost-tier sites (mail-triage Haiku, prospecting tier 1/2): they keep their pinned
   * cheap model even when the OS picks a bigger one. Status, budget, rate and max_tokens still apply.
   */
  honourModelSetting?: boolean;
  /** Subagent id when the call runs on a subagent's behalf (uses its OS entry when it has one). */
  subagent?: string;
}

export interface ModelTextResult {
  text: string;
  provider: SupportedProvider;
  model: string;
  usage: { tokensIn?: number; tokensOut?: number };
  /** True when the OS model failed and a later entry in the chain answered. */
  fellBack: boolean;
  raw: unknown;
}

export interface ModelCallDeps {
  fetchImpl?: typeof fetch;
  settings?: () => Promise<AgentSettingsSnapshot>;
  env?: Record<string, string | undefined>;
  /** Ledger write for a successful call. */
  record?: (row: { engine: string; model: string; purpose: string; json: unknown; usage: { tokensIn?: number; tokensOut?: number } }) => Promise<void>;
  /** True when spend is still under the OS daily budget (only consulted when one is set). */
  withinBudget?: (purpose: string) => Promise<boolean>;
  rateSlot?: (limit: number | null) => boolean;
  log?: (msg: string) => void;
}

const warned = new Set<string>();
function warnOnce(log: (m: string) => void, key: string, msg: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  if (warned.size > 200) warned.clear();
  log(msg);
}

let lastReportedStatus = "active";
/** Ledger one line when CLARA starts (and stops) refusing work because of the OS status. */
export async function reportStatusChange(status: string, where: string): Promise<void> {
  if (status === lastReportedStatus) return;
  lastReportedStatus = status;
  try {
    const { append } = await import("./ledger");
    await append({
      kind: "action", actor: "clara",
      what: status === "active"
        ? "OS settings: CLARA active again — taking new work"
        : `OS settings: CLARA is ${status} — refusing new work (first seen in ${where})`,
      meta: { agentSettingsStatus: status },
    });
  } catch { /* the ledger is best-effort */ }
}

async function defaultRecord(row: Parameters<NonNullable<ModelCallDeps["record"]>>[0]): Promise<void> {
  const u = await import("./usage");
  if (row.engine === "anthropic") return u.recordAnthropicCall(row.json, { model: row.model, purpose: row.purpose });
  return u.recordModelCall({
    engine: row.engine, model: row.model, purpose: row.purpose,
    tokensIn: row.usage.tokensIn, tokensOut: row.usage.tokensOut,
    tokensTotal: ((row.usage.tokensIn ?? 0) + (row.usage.tokensOut ?? 0)) || undefined,
  });
}

async function defaultWithinBudget(purpose: string): Promise<boolean> {
  const u = await import("./usage");
  return u.isProspectPurpose(purpose) ? u.withinProspectDayBudget() : u.withinSpendBudget();
}

async function callAnthropic(t: ModelTarget, o: ModelTextOpts, maxTokens: number, key: string, fetchImpl: typeof fetch) {
  const r = await fetchImpl("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: t.model,
      max_tokens: maxTokens,
      ...(o.system ? { system: o.system } : {}),
      ...(typeof o.temperature === "number" ? { temperature: o.temperature } : {}),
      messages: [{ role: "user", content: o.prompt }],
    }),
    signal: AbortSignal.timeout(o.timeoutMs ?? 90_000),
  });
  if (!r.ok) throw new Error(`anthropic ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}`);
  const j = await r.json() as { content?: { type?: string; text?: string }[]; usage?: { input_tokens?: number; output_tokens?: number } };
  // Opus 5/5.5 can return ["thinking","text"]; take the text block, not blindly content[0].
  const text = (j.content?.find((c) => c.type === "text")?.text ?? j.content?.[0]?.text ?? "").trim();
  return { text, json: j as unknown, usage: { tokensIn: j.usage?.input_tokens, tokensOut: j.usage?.output_tokens } };
}

/** One completion through the OS-configured model chain. Never throws; null = no model answered. */
export async function callModelText(o: ModelTextOpts, deps: ModelCallDeps = {}): Promise<ModelTextResult | null> {
  // eslint-disable-next-line no-console
  const log = deps.log ?? ((m: string) => console.warn(m));
  const env = deps.env ?? process.env;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const snap = await (deps.settings ?? getAgentSettings)();
  const s = settingsFor(snap, o.subagent);

  if (s.status !== "active") {
    warnOnce(log, `status:${s.status}:${o.site}`, `[model-call] ${o.site}: CLARA is ${s.status} in the OS settings — not calling a model`);
    if (!deps.settings) await reportStatusChange(s.status, o.site);
    return null;
  }
  if (!deps.settings) await reportStatusChange("active", o.site);

  if (s.limits.rate_limit_per_minute && !(deps.rateSlot ?? takeModelCallSlot)(s.limits.rate_limit_per_minute)) {
    log(`[model-call] ${o.site}: over the OS rate limit (${s.limits.rate_limit_per_minute}/min) — skipped`);
    return null;
  }
  if (s.limits.daily_budget_usd) {
    const ok = await (deps.withinBudget ?? defaultWithinBudget)(o.purpose).catch(() => true);
    if (!ok) {
      warnOnce(log, `budget:${o.purpose}:${new Date().toDateString()}`, `[model-call] ${o.site}: today's spend is at the OS daily budget ($${s.limits.daily_budget_usd}) — skipped`);
      return null;
    }
  }

  const maxTokens = narrowIntCap(o.maxTokens, s.limits.max_tokens);
  const chain = o.honourModelSetting === false
    ? [{ provider: "anthropic" as const, model: o.defaultModel, via: "default" as const }]
    : modelChain(s, o.defaultModel);
  const ignored = o.honourModelSetting === false ? null : ignoredModelReason(s);
  if (ignored) warnOnce(log, `ignored:${ignored}`, `[model-call] OS model setting not used: ${ignored} — using built-in defaults`);

  let fellBack = false;
  for (const t of chain) {
    try {
      let out: { text: string; json: unknown; usage: { tokensIn?: number; tokensOut?: number } };
      if (t.provider === "google") {
        const key = geminiApiKey(env);
        if (!key) {
          warnOnce(log, "gemini:nokey", `[model-call] OS picked Gemini (${t.model}) but GEMINI_API_KEY / GOOGLE_AI_API_KEY is not set — falling back`);
          fellBack = true;
          continue;
        }
        const g = await geminiGenerateText({
          apiKey: key, model: t.model, system: o.system, messages: [{ role: "user", content: o.prompt }],
          maxTokens, temperature: o.temperature, json: o.json, timeoutMs: o.timeoutMs, fetchImpl,
        });
        out = { text: g.text, json: g.raw, usage: g.usage };
      } else {
        const key = env.ANTHROPIC_API_KEY?.trim();
        if (!key) { fellBack = true; continue; }
        out = await callAnthropic(t, o, maxTokens, key, fetchImpl);
      }
      const engine = t.provider === "google" ? "google" : "anthropic";
      await (deps.record ?? defaultRecord)({ engine, model: t.model, purpose: o.purpose, json: out.json, usage: out.usage }).catch(() => {});
      return { text: out.text, provider: t.provider, model: t.model, usage: out.usage, fellBack, raw: out.json };
    } catch (e) {
      log(`[model-call] ${o.site}: ${t.provider}/${t.model} (${t.via}) failed — ${String((e as Error)?.message ?? e).slice(0, 160)}`);
      fellBack = true;
    }
  }
  return null;
}
