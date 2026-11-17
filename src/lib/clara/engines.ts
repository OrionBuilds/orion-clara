// Clara — engine roster. Direct structural port of FRIDAY's src/lib/friday/engines.ts: same
// complete()/CompleteResult/ServedBrain contract, same engineHealth()/engineHealthDeep() split
// (cheap "is it configured" vs. cached "does it actually authenticate").
//
//   claude      → the owner's own Claude Code CLI login. Clara's default brain (chat/briefs/triage).
//   lmstudio    → local OpenAI-compatible server. Enforced local-only route for sensitivity.ts.
//   codex/antigravity/hermes → wired + health-checked for parity, available for Clara to invoke
//     directly for heavier one-off research/build work, but NOT in the default failover chain —
//     there's no value in silently falling back to a coding agent to "book a restaurant."

import { run, spawnStream, type AgentName, ENGINE_BIN } from "@/lib/runner";
import { lmStudioBaseUrl, lmStudioChatModel } from "./lmstudio";
import { osAuth, osEnabled, OS_MCP_CONFIG_PATH, osCliAllowedTools } from "./osClient";
import type { Engine } from "./sensitivity";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface CompleteOpts {
  system?: string;
  prompt: string;
  engine?: Engine;
  cwd?: string;
  timeoutMs?: number;
  temperature?: number;
  json?: boolean;
  write?: boolean; // allow the agent to modify files / run git — read-only by default
  os?: boolean; // give a dispatched `claude -p` access to the orion MCP (CRM) as the owner's OS account.
  onChunk?: (text: string) => void;
  usageSink?: (u: TokenUsage) => void;
  /** Which job this call belongs to ("sms", "brief", "legal", …) — grouped in the spend report. */
  purpose?: string;
}

export interface TokenUsage { tokensIn?: number; tokensOut?: number; tokensTotal?: number; costUsd?: number }
export interface ServedBrain { engine: Engine; model?: string; fallback: boolean; intended: Engine }
export interface CompleteResult { text: string; served: ServedBrain }

const CLAUDE_MODEL = process.env.CLARA_CLAUDE_MODEL?.trim() || "claude-opus-4-8";

/**
 * The model the `claude` engine runs, from the OS per-agent settings (agentSettings.ts): the first
 * Anthropic entry of primary → fallback, else CLARA_CLAUDE_MODEL. `gemini` is set when the OS
 * primary is a Google model — a plain completion (no OS tools, no file writes) then goes to Gemini
 * first; the CLI cannot run Gemini, so tool/write runs stay on the CLI and its Claude model.
 */
async function engineModels(): Promise<{ claude: string; gemini: string | null }> {
  const { getAgentSettings, modelChain } = await import("./agentSettings");
  const chain = modelChain((await getAgentSettings()).root, CLAUDE_MODEL);
  const claude = chain.find((t) => t.provider === "anthropic")?.model ?? CLAUDE_MODEL;
  const gemini = chain[0]?.provider === "google" ? chain[0].model : null;
  return { claude, gemini };
}

async function completeGemini(opts: CompleteOpts, model: string): Promise<string> {
  const { geminiApiKey, geminiGenerateText } = await import("./gemini");
  const key = geminiApiKey();
  if (!key) throw new Error("GEMINI_API_KEY / GOOGLE_AI_API_KEY not set");
  const { getAgentSettings, narrowIntCap } = await import("./agentSettings");
  const maxTokens = narrowIntCap(4096, (await getAgentSettings()).root.limits.max_tokens);
  const out = await geminiGenerateText({
    apiKey: key, model, system: opts.system, messages: [{ role: "user", content: opts.prompt }],
    maxTokens, temperature: opts.temperature, json: opts.json, timeoutMs: opts.timeoutMs ?? 180_000,
  });
  opts.usageSink?.({ tokensIn: out.usage.tokensIn, tokensOut: out.usage.tokensOut, tokensTotal: out.usage.tokensTotal });
  return out.text;
}

// ── Health ───────────────────────────────────────────────────────────────
export async function engineHealth(): Promise<Record<Engine, boolean>> {
  const models = await lmStudioModels();
  return {
    claude: Boolean(ENGINE_BIN.claude),
    codex: Boolean(ENGINE_BIN.codex),
    antigravity: Boolean(ENGINE_BIN.antigravity),
    hermes: Boolean(ENGINE_BIN.hermes),
    lmstudio: models.length > 0,
    ollama: false,
  };
}

export interface DeepHealth { configured: boolean; authed: boolean | null; detail?: string }
export type DeepHealthMap = Record<Engine, DeepHealth>;
const deepHealthCache = globalThis as unknown as { __claraDeepHealth?: { at: number; data: DeepHealthMap } };

async function probeCli(bin: AgentName, args: string[], timeoutMs = 8000): Promise<{ ok: boolean; text: string }> {
  try {
    const out = await run(bin, args, { timeoutMs });
    return { ok: out.ok, text: `${out.stdout}\n${out.stderr}` };
  } catch (e) {
    return { ok: false, text: String(e) };
  }
}

// probeCli returns stdout+stderr concatenated, so a CLI that prints a warning alongside its JSON
// would break a strict JSON.parse — pull out the first balanced {...} block instead.
function parseJson<T>(text: string): T | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) {
      try { return JSON.parse(text.slice(start, i + 1)) as T; } catch { return null; }
    }
  }
  return null;
}

export async function engineHealthDeep(): Promise<DeepHealthMap> {
  const cached = deepHealthCache.__claraDeepHealth;
  if (cached && Date.now() - cached.at < 60_000) return cached.data;

  const [models, codexProbe, claudeProbe, agyProbe] = await Promise.all([
    lmStudioModels(),
    ENGINE_BIN.codex ? probeCli("codex", ["login", "status"]) : Promise.resolve(null),
    // `auth status` rather than `--version`: it reports real login state, costs nothing, and is
    // JSON by default. It also proves the binary runs, so it subsumes the old version probe.
    ENGINE_BIN.claude ? probeCli("claude", ["auth", "status", "--json"], 8000) : Promise.resolve(null),
    ENGINE_BIN.antigravity ? probeCli("antigravity", ["--version"], 6000) : Promise.resolve(null),
  ]);

  let codex: DeepHealth = { configured: Boolean(ENGINE_BIN.codex), authed: null };
  if (codexProbe) {
    if (codexProbe.ok && /logged in|authenticated|chatgpt|api key/i.test(codexProbe.text)) codex = { configured: true, authed: true, detail: "codex login ok" };
    else if (/not logged in|logged out|no.*credential|sign ?in|log ?in/i.test(codexProbe.text)) codex = { configured: true, authed: false, detail: "run `codex login`" };
    else codex = { configured: true, authed: codexProbe.ok ? null : false, detail: codexProbe.ok ? "status unclear" : "codex not runnable" };
  }

  // `claude auth status --json` returns {loggedIn, authMethod, email, subscriptionType, ...} and
  // exits 0. This used to require CLARA_DEEP_AUTH_PROBE=1 and a real billed `claude -p` completion
  // on every 60s cache miss — which cost money just to render a dashboard dot, and false-negatived
  // when run from inside a nested Claude session. Login state is now always accurate and free.
  let claude: DeepHealth = { configured: Boolean(ENGINE_BIN.claude), authed: null };
  if (claudeProbe) {
    const st = parseJson<{ loggedIn?: boolean; authMethod?: string; email?: string; subscriptionType?: string }>(claudeProbe.text);
    if (!claudeProbe.ok && !st) claude = { configured: true, authed: false, detail: "claude not runnable" };
    else if (st?.loggedIn === true) {
      const bits = [st.authMethod, st.subscriptionType, st.email].filter(Boolean);
      claude = { configured: true, authed: true, detail: bits.join(" · ") || "logged in" };
    } else if (st?.loggedIn === false) claude = { configured: true, authed: false, detail: "run `claude auth login`" };
    else claude = { configured: true, authed: null, detail: "auth status unreadable" };
  }

  // Opt-in end-to-end check: proves Clara can actually get a completion, not merely that valid
  // credentials exist. Costs a real (tiny) API call, so it stays behind the flag.
  if (claude.authed && process.env.CLARA_DEEP_AUTH_PROBE === "1") {
    const ping = await probeCli("claude", ["-p", "--model", "haiku", "say ok"], 20000);
    claude = { configured: true, authed: ping.ok, detail: ping.ok ? `${claude.detail} · completion ok` : "credentials valid but completion failed" };
  }

  let antigravity: DeepHealth = { configured: Boolean(ENGINE_BIN.antigravity), authed: null };
  if (agyProbe) antigravity = agyProbe.ok ? { configured: true, authed: null, detail: "binary ok — run `agy auth login` to enable" } : { configured: true, authed: false, detail: "agy not runnable" };

  const hermesAuth = path.join(os.homedir(), ".hermes", "auth.json");
  const hermes: DeepHealth = ENGINE_BIN.hermes
    ? (existsSync(hermesAuth) ? { configured: true, authed: null, detail: "creds present (not invoked; ~62s startup)" } : { configured: true, authed: false, detail: "no ~/.hermes/auth.json" })
    : { configured: false, authed: false };

  const data: DeepHealthMap = {
    lmstudio: { configured: true, authed: models.length > 0, detail: `${models.length} model(s)` },
    ollama: { configured: false, authed: false },
    codex, claude, antigravity, hermes,
  };
  deepHealthCache.__claraDeepHealth = { at: Date.now(), data };
  return data;
}

export async function lmStudioModels(baseUrl?: string): Promise<string[]> {
  try {
    const base = baseUrl ?? (await lmStudioBaseUrl());
    const r = await fetch(`${base}/models`, { signal: AbortSignal.timeout(4000) });
    if (!r.ok) return [];
    const j = await r.json();
    return (j.data ?? []).map((m: { id: string }) => m.id);
  } catch {
    return [];
  }
}

// ── LM Studio ────────────────────────────────────────────────────────────
interface ChatMessage { role: "system" | "user" | "assistant"; content: string }

async function completeLMStudio(opts: CompleteOpts): Promise<string> {
  const base = await lmStudioBaseUrl();
  const model = await lmStudioChatModel();
  const messages: ChatMessage[] = [];
  if (opts.system) messages.push({ role: "system", content: opts.system });
  messages.push({ role: "user", content: opts.prompt });
  const r = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages, temperature: opts.temperature ?? 0.3, stream: false }),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000),
  });
  if (!r.ok) throw new Error(`LM Studio HTTP ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}`);
  const j = await r.json();
  if (j.usage) opts.usageSink?.({ tokensIn: j.usage.prompt_tokens, tokensOut: j.usage.completion_tokens, tokensTotal: j.usage.total_tokens });
  return j.choices?.[0]?.message?.content ?? "";
}

// ── Claude Code CLI ──────────────────────────────────────────────────────
// Extra flags + env that let a dispatched `claude -p` reach the orion MCP as the owner's OS account.
interface OsWiring { args: string[]; env: Record<string, string> }
async function osWiring(opts: CompleteOpts): Promise<OsWiring | null> {
  if (!opts.os) return null;
  if (!osEnabled()) {
    console.warn("[engines] os:true requested but Clara isn't signed in to orion — running without OS access (visit /api/os/auth)");
    return null;
  }
  let jwt: string;
  try { jwt = await osAuth.getFreshOsJwt(); }
  catch (e) { console.warn(`[engines] orion JWT mint failed (${String(e).slice(0, 120)}) — running without OS access`); return null; }
  // acceptEdits + explicit allow-list (never --dangerously-skip-permissions, which voids the
  // allow-list). Real controls are server-side RLS + Clara's tiered approval governor.
  return {
    args: [
      "--mcp-config", OS_MCP_CONFIG_PATH,
      "--strict-mcp-config",
      "--permission-mode", "acceptEdits",
      "--allowedTools", osCliAllowedTools(!!opts.write),
    ],
    env: { ORION_JWT: jwt },
  };
}

async function completeClaude(opts: CompleteOpts, model: string = CLAUDE_MODEL): Promise<string> {
  const os = await osWiring(opts);
  const args = ["-p", "--model", model];
  if (opts.write && !os) args.push("--dangerously-skip-permissions");
  if (opts.system) args.push("--append-system-prompt", opts.system);
  if (os) args.push(...os.args);
  args.push(opts.prompt);
  const out = await run("claude", args, { cwd: opts.cwd, timeoutMs: opts.timeoutMs ?? 180_000, extraEnv: os?.env });
  if (!out.ok) throw new Error(`claude CLI failed (code ${out.code}): ${(out.stderr || out.stdout).slice(0, 300)}`);
  return out.stdout.trim();
}

// ── Codex CLI ────────────────────────────────────────────────────────────
async function completeCodex(opts: CompleteOpts): Promise<string> {
  const args = ["exec", "--json"];
  if (opts.system) args.push("--append-system-prompt", opts.system);
  args.push(opts.prompt);
  const out = await run("codex", args, { cwd: opts.cwd, timeoutMs: opts.timeoutMs ?? 180_000 });
  if (!out.ok) throw new Error(`codex CLI failed (code ${out.code}): ${(out.stderr || out.stdout).slice(0, 300)}`);
  return out.stdout.trim();
}

// ── Antigravity CLI (`agy`) ──────────────────────────────────────────────
async function completeAntigravity(opts: CompleteOpts): Promise<string> {
  const args: string[] = [];
  if (opts.system) args.push("--system", opts.system);
  args.push(opts.prompt);
  const out = await run("antigravity", args, { cwd: opts.cwd, timeoutMs: opts.timeoutMs ?? 180_000 });
  if (!out.ok) throw new Error(`antigravity CLI failed (code ${out.code}): ${(out.stderr || out.stdout).slice(0, 300)}`);
  return out.stdout.trim();
}

// ── Hermes CLI (own provider chain — LM Studio primary → Claude fallback) ─
async function completeHermes(opts: CompleteOpts): Promise<string> {
  const args = ["--yolo"];
  if (opts.system) args.push("--system", opts.system);
  args.push(opts.prompt);
  const out = await run("hermes", args, { cwd: opts.cwd, timeoutMs: opts.timeoutMs ?? 180_000 });
  if (!out.ok) throw new Error(`hermes CLI failed (code ${out.code}): ${(out.stderr || out.stdout).slice(0, 300)}`);
  return out.stdout.trim();
}

// ── Dispatch + failover ──────────────────────────────────────────────────
// Default failover chain for Clara's everyday EA work. 2026-08-23 owner directive: LM Studio
// (local, free) is now the primary brain; Claude is the failover, not the default. Codex/
// antigravity/hermes are reachable via an explicit opts.engine pick (heavier one-off research/
// build asks) but are deliberately NOT in this chain — falling back to a coding agent for a
// travel-itinerary draft would be a silent, confusing downgrade.
const DEFAULT_CHAIN: Engine[] = ["lmstudio", "claude"];

async function runOne(engine: Engine, opts: CompleteOpts, models?: { claude: string }): Promise<string> {
  switch (engine) {
    case "claude": return completeClaude(opts, models?.claude ?? CLAUDE_MODEL);
    case "codex": return completeCodex(opts);
    case "antigravity": return completeAntigravity(opts);
    case "hermes": return completeHermes(opts);
    case "lmstudio": return completeLMStudio(opts);
    case "ollama": throw new Error("ollama engine not wired");
  }
}

export async function completeWithMeta(opts: CompleteOpts): Promise<CompleteResult> {
  const intended = opts.engine ?? DEFAULT_CHAIN[0];
  // Ledger every call. `usageSink` has existed on CompleteOpts since 2.2 and completeLMStudio has
  // always called it — but nothing ever PASSED one, so it was dead code and Clara ran with no cost
  // accounting at all. Reset per attempt so a failed engine's usage can never be attributed to
  // whichever engine actually served.
  let usage: TokenUsage | null = null;
  const o: CompleteOpts = { ...opts, usageSink: (u) => { usage = u; } };
  const ledger = async (engine: string, model?: string) => {
    const { recordModelCall } = await import("./usage");
    await recordModelCall({
      engine, model, purpose: opts.purpose,
      tokensIn: usage?.tokensIn, tokensOut: usage?.tokensOut,
      tokensTotal: usage?.tokensTotal, costUsd: usage?.costUsd,
    });
  };

  // OS per-agent settings: which Claude model the CLI runs, and whether a Gemini model goes first
  // for the hosted step (see engineModels). Status paused/disabled is enforced by the callers that
  // take on work (router, scheduler, channels), not here, so an in-flight job can still finish.
  const models = await engineModels().catch(() => ({ claude: CLAUDE_MODEL, gemini: null }));
  /** The hosted ("claude") step: Gemini first when the OS picked it and the run needs no tools. */
  const hosted = async (): Promise<{ text: string; model: string; engineLedger: string }> => {
    if (models.gemini && !o.os && !o.write) {
      try {
        usage = null;
        return { text: await completeGemini(o, models.gemini), model: models.gemini, engineLedger: "google" };
      } catch (e) {
        console.warn(`[engines] Gemini (${models.gemini}) failed (${String(e).slice(0, 120)}) — falling back to the claude CLI`);
      }
    }
    usage = null;
    return { text: await runOne("claude", o, models), model: models.claude, engineLedger: "claude" };
  };

  // An explicit engine pick (e.g. The owner asking for codex/antigravity/hermes by name) never fails
  // over — a silent swap to a different brain for a deliberately-chosen engine would be surprising.
  if (opts.engine && opts.engine !== DEFAULT_CHAIN[0]) {
    if (opts.engine === "claude") {
      const h = await hosted();
      await ledger(h.engineLedger, h.model);
      return { text: h.text, served: { engine: "claude", model: h.model, fallback: false, intended } };
    }
    usage = null;
    const text = await runOne(opts.engine, o, models);
    await ledger(opts.engine);
    return { text, served: { engine: opts.engine, fallback: false, intended } };
  }
  let lastErr: unknown;
  for (let i = 0; i < DEFAULT_CHAIN.length; i++) {
    const engine = DEFAULT_CHAIN[i];
    try {
      if (engine === "claude") {
        const h = await hosted();
        await ledger(h.engineLedger, h.model);
        return { text: h.text, served: { engine, model: h.model, fallback: i > 0, intended } };
      }
      usage = null;
      const text = await runOne(engine, o, models);
      await ledger(engine);
      return { text, served: { engine, fallback: i > 0, intended } };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export async function complete(opts: CompleteOpts): Promise<string> {
  return (await completeWithMeta(opts)).text;
}

// Live-streaming variant for the chat UI (mirrors FRIDAY's spawnStream usage) — Claude only, since
// that's Clara's interactive chat brain; other engines run buffered via complete().
export async function streamClaude(opts: CompleteOpts, onEvent: (chunk: string) => void, model: string = CLAUDE_MODEL) {
  const os = await osWiring(opts);
  const args = ["-p", "--model", model];
  if (opts.write && !os) args.push("--dangerously-skip-permissions");
  if (opts.system) args.push("--append-system-prompt", opts.system);
  if (os) args.push(...os.args);
  args.push(opts.prompt);
  const child = spawnStream("claude", args, { cwd: opts.cwd, extraEnv: os?.env });
  child.stdout.on("data", (b: Buffer) => onEvent(b.toString()));
  return child;
}
