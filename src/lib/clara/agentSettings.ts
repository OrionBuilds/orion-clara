// Clara — per-agent settings from the OS (Settings → AI Agents → CLARA).
//
// The OS serves CLARA's effective configuration at agent-settings-get (orion
// supabase/functions/agent-settings-get): status, model + fallback, ElevenLabs voice, persona
// override, allowed/denied tools, numeric limits, and one entry per configured subagent
// (`clara.front-desk`, …). Every field is nullable and null means "keep the built-in default".
//
// Rules this module enforces for everyone who reads it:
//   - It never throws and never blocks CLARA on the OS. A failed fetch keeps the last good
//     snapshot; with none, the built-in defaults (status active, nothing overridden).
//   - Settings only NARROW: limits take the lower of the hard-coded cap and the setting, tool
//     lists are code-list ∩ allowed − denied, require_approval can only add approvals.
//   - Model and voice overrides are honoured only when CLARA (or her parent, for a subagent) was
//     configured explicitly. An org-wide default model/voice (source "org_default") is ignored in
//     favour of CLARA's own built-in defaults, so connecting a provider for some other OS feature
//     can never silently swap her brain or her voice.
//   - The endpoint never returns API keys; vendors are called with CLARA's own env credentials.

export type AgentStatus = "active" | "paused" | "disabled";
export type SettingSource = "agent" | "parent" | "org_default" | "none";
export type SupportedProvider = "anthropic" | "google";

export interface ModelChoice {
  id: string | null;
  model_key: string;
  provider: string | null;
  display_name: string | null;
  max_output_tokens: number | null;
  available: boolean;
  unavailable_reason?: string;
}

export interface AgentLimits {
  daily_budget_usd: number | null;
  max_tokens: number | null;
  max_calls_per_day: number | null;
  rate_limit_per_minute: number | null;
  max_turns: number | null;
}

export interface EffectiveAgentSettings {
  agent_key: string;
  status: AgentStatus;
  model: {
    effective: ModelChoice | null;
    primary: ModelChoice | null;
    primary_source: SettingSource;
    fallback: ModelChoice | null;
    fallback_source: SettingSource;
  };
  voice: {
    voice_id: string | null;
    available: boolean | null;
    source: SettingSource;
    settings: Record<string, unknown>;
  };
  prompts: {
    persona_override: string | null;
    persona_mode: "append" | "replace";
    templates: { id: string; name: string; body: string }[];
  };
  tools: { allowed: string[] | null; denied: string[] };
  limits: AgentLimits;
  require_approval: boolean;
  updated_at: string | null;
}

export interface AgentSettingsSnapshot {
  root: EffectiveAgentSettings;
  /** Keyed by full agent key, e.g. "clara.front-desk". Only subagents with an OS row appear. */
  subagents: Record<string, EffectiveAgentSettings>;
  /** Where this snapshot came from: a fresh OS read, a stale-but-good one, or built-in defaults. */
  source: "os" | "last-good" | "defaults";
  fetchedAt: number;
  error?: string;
}

export const ROOT_AGENT_KEY = "clara";

// ── Defaults + normalisation ───────────────────────────────────────────────────────────────────

const NO_LIMITS: AgentLimits = {
  daily_budget_usd: null, max_tokens: null, max_calls_per_day: null, rate_limit_per_minute: null, max_turns: null,
};

export function defaultAgentSettings(agentKey = ROOT_AGENT_KEY): EffectiveAgentSettings {
  return {
    agent_key: agentKey,
    status: "active",
    model: { effective: null, primary: null, primary_source: "none", fallback: null, fallback_source: "none" },
    voice: { voice_id: null, available: null, source: "none", settings: {} },
    prompts: { persona_override: null, persona_mode: "append", templates: [] },
    tools: { allowed: null, denied: [] },
    limits: { ...NO_LIMITS },
    require_approval: false,
    updated_at: null,
  };
}

export function defaultSnapshot(error?: string): AgentSettingsSnapshot {
  return { root: defaultAgentSettings(), subagents: {}, source: "defaults", fetchedAt: 0, ...(error ? { error } : {}) };
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
const SOURCES: SettingSource[] = ["agent", "parent", "org_default", "none"];
const source = (v: unknown): SettingSource => (SOURCES.includes(v as SettingSource) ? (v as SettingSource) : "none");

/** A positive finite number, or null. Zero/negative limits are treated as unset, never as "0 allowed". */
function posNum(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

function strList(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  return Array.from(new Set(v.filter((t): t is string => typeof t === "string").map((t) => t.trim()).filter(Boolean)));
}

function modelChoice(v: unknown): ModelChoice | null {
  if (!isObj(v)) return null;
  const key = str(v.model_key);
  if (!key) return null;
  return {
    id: str(v.id),
    model_key: key.trim(),
    provider: str(v.provider)?.trim().toLowerCase() ?? null,
    display_name: str(v.display_name),
    max_output_tokens: posNum(v.max_output_tokens),
    available: v.available !== false,
    ...(str(v.unavailable_reason) ? { unavailable_reason: String(v.unavailable_reason) } : {}),
  };
}

/** Parse one agent entry from the OS. Anything malformed degrades to the built-in default for that field. */
export function normalizeAgentSettings(raw: unknown, fallbackKey = ROOT_AGENT_KEY): EffectiveAgentSettings {
  const d = defaultAgentSettings(fallbackKey);
  if (!isObj(raw)) return d;
  const model = isObj(raw.model) ? raw.model : {};
  const voice = isObj(raw.voice) ? raw.voice : {};
  const prompts = isObj(raw.prompts) ? raw.prompts : {};
  const tools = isObj(raw.tools) ? raw.tools : {};
  const limits = isObj(raw.limits) ? raw.limits : {};
  const status = raw.status === "paused" || raw.status === "disabled" ? raw.status : "active";
  const templates = Array.isArray(prompts.templates)
    ? prompts.templates.filter(isObj).map((t) => ({ id: String(t.id ?? ""), name: String(t.name ?? ""), body: str(t.body) ?? "" })).filter((t) => t.body.trim())
    : [];
  return {
    agent_key: str(raw.agent_key) ?? fallbackKey,
    status,
    model: {
      effective: modelChoice(model.effective),
      primary: modelChoice(model.primary),
      primary_source: source(model.primary_source),
      fallback: modelChoice(model.fallback),
      fallback_source: source(model.fallback_source),
    },
    voice: {
      voice_id: str(voice.voice_id)?.trim() ?? null,
      available: typeof voice.available === "boolean" ? voice.available : null,
      source: source(voice.source),
      settings: isObj(voice.settings) ? voice.settings : {},
    },
    prompts: {
      persona_override: str(prompts.persona_override),
      persona_mode: prompts.persona_mode === "replace" ? "replace" : "append",
      templates,
    },
    tools: { allowed: strList(tools.allowed), denied: strList(tools.denied) ?? [] },
    limits: {
      daily_budget_usd: posNum(limits.daily_budget_usd),
      max_tokens: posNum(limits.max_tokens),
      max_calls_per_day: posNum(limits.max_calls_per_day),
      rate_limit_per_minute: posNum(limits.rate_limit_per_minute),
      max_turns: posNum(limits.max_turns),
    },
    require_approval: raw.require_approval === true,
    updated_at: str(raw.updated_at),
  };
}

/**
 * The `data` object of an agent-settings-get response → snapshot. `subagents` arrives as an array
 * (each entry carries its own agent_key); an object keyed by agent key is accepted too.
 */
export function normalizeSnapshot(data: unknown, fetchedAt: number): AgentSettingsSnapshot {
  const root = normalizeAgentSettings(data, ROOT_AGENT_KEY);
  const subagents: Record<string, EffectiveAgentSettings> = {};
  const rawSubs = isObj(data) ? data.subagents : undefined;
  const entries: [string | null, unknown][] = Array.isArray(rawSubs)
    ? rawSubs.map((s) => [null, s])
    : isObj(rawSubs) ? Object.entries(rawSubs) : [];
  for (const [k, v] of entries) {
    const key = (isObj(v) && str(v.agent_key)) || k;
    if (!key || !key.startsWith(`${ROOT_AGENT_KEY}.`)) continue;
    subagents[key] = normalizeAgentSettings(v, key);
  }
  return { root, subagents, source: "os", fetchedAt };
}

// ── Pure policy helpers (what call sites actually use) ──────────────────────────────────────────

/** Settings for one subagent id ("front-desk") — its own OS entry when it has one, else the parent's. */
export function settingsFor(snap: AgentSettingsSnapshot, subagentId?: string | null): EffectiveAgentSettings {
  if (!subagentId) return snap.root;
  return snap.subagents[`${ROOT_AGENT_KEY}.${subagentId}`] ?? snap.root;
}

/** A hard-coded cap narrowed by a setting: the lower wins, and a setting can never raise it. */
export function narrowCap(hardCap: number, setting: number | null | undefined): number {
  return typeof setting === "number" && Number.isFinite(setting) && setting > 0 ? Math.min(hardCap, setting) : hardCap;
}

/** Integer form of narrowCap (turns, tokens, calls): floors the setting, never below 1. */
export function narrowIntCap(hardCap: number, setting: number | null | undefined): number {
  const n = narrowCap(hardCap, setting);
  return n === hardCap ? hardCap : Math.max(1, Math.floor(n));
}

export function normalizeProvider(p: string | null | undefined): SupportedProvider | null {
  const v = (p ?? "").trim().toLowerCase();
  if (v === "anthropic" || v === "claude") return "anthropic";
  if (v === "google" || v === "gemini" || v === "google_ai" || v === "google_gemini") return "google";
  return null;
}

export interface ModelTarget {
  provider: SupportedProvider;
  model: string;
  /** "primary"/"fallback" = an OS setting; "default" = the call site's built-in model. */
  via: "primary" | "fallback" | "default";
}

const EXPLICIT: SettingSource[] = ["agent", "parent"];

function settingTarget(m: ModelChoice | null, src: SettingSource, via: "primary" | "fallback"): ModelTarget | null {
  if (!m || !m.available || !EXPLICIT.includes(src)) return null;
  const provider = normalizeProvider(m.provider);
  if (!provider) return null;
  const model = provider === "google" ? m.model_key.replace(/^models\//, "") : m.model_key;
  return model ? { provider, model, via } : null;
}

/**
 * Ordered models to try for one call site: the OS primary, the OS fallback, then the site's own
 * built-in Anthropic model. Settings from the org default, unavailable models, and providers CLARA
 * has no caller for (anything but anthropic/google) are skipped. Duplicates collapse.
 */
export function modelChain(s: EffectiveAgentSettings, defaultModel: string): ModelTarget[] {
  const out: ModelTarget[] = [];
  const push = (t: ModelTarget | null) => {
    if (t && !out.some((o) => o.provider === t.provider && o.model === t.model)) out.push(t);
  };
  push(settingTarget(s.model.primary, s.model.primary_source, "primary"));
  push(settingTarget(s.model.fallback, s.model.fallback_source, "fallback"));
  push({ provider: "anthropic", model: defaultModel, via: "default" });
  return out;
}

/** Why a configured model was not used — for one log line, so a silent ignore is never silent. */
export function ignoredModelReason(s: EffectiveAgentSettings): string | null {
  const m = s.model.primary;
  if (!m) return null;
  if (!EXPLICIT.includes(s.model.primary_source)) return null; // org default: ignored by design
  if (!m.available) return `${m.model_key} unavailable (${m.unavailable_reason ?? "unknown"})`;
  if (!normalizeProvider(m.provider)) return `${m.model_key}: provider "${m.provider}" has no CLARA caller`;
  return null;
}

/**
 * Code list ∩ allowed − denied. `allowed: null` means no OS-side restriction. Never adds a name the
 * code list does not already carry.
 */
export function filterToolNames(code: readonly string[], tools: { allowed: string[] | null; denied: string[] }): string[] {
  const denied = new Set(tools.denied);
  const allowed = tools.allowed ? new Set(tools.allowed) : null;
  return code.filter((t) => !denied.has(t) && (!allowed || allowed.has(t)));
}

export function filterTools<T extends { name: string }>(code: readonly T[], tools: { allowed: string[] | null; denied: string[] }): T[] {
  const keep = new Set(filterToolNames(code.map((t) => t.name), tools));
  return code.filter((t) => keep.has(t.name));
}

/**
 * The same filter for the OS MCP namespace (CLARA_OS_TOOLS). The OS settings UI offers CLARA's
 * intent-tool names (crm_lookup, find_email, …), and those tools call MCP tools underneath — so an
 * allowed list that names NO MCP tool at all is an intent-level restriction and must not switch off
 * every MCP call. `denied` always applies; `allowed` applies only when it names at least one MCP tool.
 */
export function filterOsToolNames(code: readonly string[], tools: { allowed: string[] | null; denied: string[] }): string[] {
  const inNamespace = tools.allowed?.some((t) => code.includes(t)) ?? false;
  return filterToolNames(code, { allowed: inNamespace ? tools.allowed : null, denied: tools.denied });
}

/** Polite refusal when the OS has CLARA (or a subagent) paused or disabled; null when active. */
export function statusRefusal(s: EffectiveAgentSettings, who = "I"): string | null {
  if (s.status === "active") return null;
  const subject = who === "I" ? "I'm" : `${who} is`;
  return s.status === "paused"
    ? `${subject} paused in the OS settings right now, so I'm not starting anything new. Nothing was changed. Unpause CLARA under Settings → AI Agents and ask again.`
    : `${subject} switched off in the OS settings, so I'm not taking on any work. Nothing was changed. Re-enable CLARA under Settings → AI Agents to turn me back on.`;
}

/** ElevenLabs voice id: an explicitly configured, available OS voice wins; otherwise the env/default. */
export function effectiveVoiceId(s: EffectiveAgentSettings, envOrDefault: string): string {
  const v = s.voice.voice_id;
  if (!v || !EXPLICIT.includes(s.voice.source) || s.voice.available === false) return envOrDefault;
  return /^[A-Za-z0-9]{16,}$/.test(v) ? v : envOrDefault;
}

/** Numeric ElevenLabs voice_settings overrides from the OS (stability, similarity_boost, style, use_speaker_boost). */
export function voiceSettingOverrides(s: EffectiveAgentSettings): { stability?: number; similarity_boost?: number; style?: number; use_speaker_boost?: boolean } {
  const v = s.voice.settings;
  const unit = (x: unknown) => (typeof x === "number" && Number.isFinite(x) && x >= 0 && x <= 1 ? x : undefined);
  const out: { stability?: number; similarity_boost?: number; style?: number; use_speaker_boost?: boolean } = {};
  const st = unit(v.stability); if (st !== undefined) out.stability = st;
  const sim = unit(v.similarity_boost ?? v.similarity); if (sim !== undefined) out.similarity_boost = sim;
  const sty = unit(v.style); if (sty !== undefined) out.style = sty;
  if (typeof v.use_speaker_boost === "boolean") out.use_speaker_boost = v.use_speaker_boost;
  return out;
}

// ── Rate limit (rate_limit_per_minute) ─────────────────────────────────────────────────────────

/** Sliding 60s window over model calls. Process-local, like every other CLARA limiter. */
export class MinuteRateLimiter {
  private hits: number[] = [];
  constructor(private readonly now: () => number = Date.now) {}
  /** Records a call and returns true, or returns false (recording nothing) when `limit` is reached. */
  take(limit: number | null | undefined): boolean {
    const t = this.now();
    this.hits = this.hits.filter((h) => t - h < 60_000);
    if (typeof limit === "number" && limit > 0 && this.hits.length >= Math.floor(limit)) return false;
    this.hits.push(t);
    if (this.hits.length > 10_000) this.hits.splice(0, this.hits.length - 10_000);
    return true;
  }
}

// ── Client: fetch + cache + last-good ──────────────────────────────────────────────────────────

// Placeholder only — the real Orion Supabase URL comes from ORION_SUPABASE_URL (see the client factory below).
export const DEFAULT_OS_SUPABASE_URL = "https://your-project-ref.supabase.co";
const TIMEOUT_MS = 15_000;
const TTL_MS = 60_000;
const FIRST_WAIT_MS = 2_500;

export interface AgentSettingsClientOpts {
  fetchImpl?: typeof fetch;
  /** CLARA's OS access token, or null when she isn't signed in to the OS. */
  getJwt?: () => Promise<string | null>;
  baseUrl?: string;
  anonKey?: string;
  timeoutMs?: number;
  ttlMs?: number;
  /** How long the very first read waits for the OS before using defaults. */
  firstWaitMs?: number;
  now?: () => number;
  /** When false, peek() never starts a background fetch (tests, CLARA_AGENT_SETTINGS=off). */
  autoRefresh?: boolean;
  log?: (msg: string) => void;
}

export class AgentSettingsClient {
  private snap: AgentSettingsSnapshot = defaultSnapshot();
  private lastGood: AgentSettingsSnapshot | null = null;
  private lastAttempt = -Infinity;
  private inFlight: Promise<AgentSettingsSnapshot> | null = null;
  private lastError: string | null = null;
  /** True once any fetch has finished (either way) — after that, reads never wait. */
  private settled = false;

  constructor(private readonly opts: AgentSettingsClientOpts = {}) {}

  private now(): number { return (this.opts.now ?? Date.now)(); }
  private ttl(): number { return this.opts.ttlMs ?? TTL_MS; }
  private stale(): boolean { return this.now() - this.lastAttempt >= this.ttl(); }

  /** The current snapshot without waiting. Starts a background refresh when stale (if allowed). */
  peek(): AgentSettingsSnapshot {
    if (this.opts.autoRefresh !== false && this.stale() && !this.inFlight) void this.refresh();
    return this.snap;
  }

  /**
   * Cached snapshot, refreshed at most once per TTL. Never throws, never rejects.
   *
   * Stale-while-revalidate: once a first fetch has been attempted, a stale cache is returned at once
   * and refreshed in the background, so a live call never waits on the OS. Only the very first read
   * waits, and at most `firstWaitMs` (2.5s), before going ahead on the defaults.
   */
  async get(): Promise<AgentSettingsSnapshot> {
    if (this.opts.autoRefresh === false && !this.opts.getJwt) return this.snap;
    const pending = this.inFlight ?? (this.stale() ? this.refresh() : null);
    if (!pending || this.settled) return this.snap;
    const wait = this.opts.firstWaitMs ?? FIRST_WAIT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<AgentSettingsSnapshot>((resolve) => { timer = setTimeout(() => resolve(this.snap), wait); });
    try {
      return await Promise.race([pending, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Force one fetch now (deduped with any in flight). Never rejects. */
  refresh(): Promise<AgentSettingsSnapshot> {
    if (this.inFlight) return this.inFlight;
    this.lastAttempt = this.now();
    this.inFlight = this.fetchOnce()
      .then((fresh) => {
        this.snap = fresh;
        this.lastGood = fresh;
        if (this.lastError) this.opts.log?.("[agent-settings] OS settings reachable again");
        this.lastError = null;
        return fresh;
      })
      .catch((e: unknown) => {
        const error = String((e as Error)?.message ?? e).slice(0, 200);
        if (error !== this.lastError) {
          this.opts.log?.(`[agent-settings] fetch failed (${error}) — using ${this.lastGood ? "last good settings" : "built-in defaults"}`);
        }
        this.lastError = error;
        this.snap = this.lastGood ? { ...this.lastGood, source: "last-good", error } : defaultSnapshot(error);
        return this.snap;
      })
      .finally(() => { this.inFlight = null; this.settled = true; });
    return this.inFlight;
  }

  private async fetchOnce(): Promise<AgentSettingsSnapshot> {
    const jwt = this.opts.getJwt ? await this.opts.getJwt() : null;
    if (!jwt) throw new Error("not signed in to the OS");
    const base = (this.opts.baseUrl || DEFAULT_OS_SUPABASE_URL).replace(/\/+$/, "");
    const headers: Record<string, string> = { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" };
    if (this.opts.anonKey) headers.apikey = this.opts.anonKey;
    const r = await (this.opts.fetchImpl ?? fetch)(`${base}/functions/v1/agent-settings-get`, {
      method: "POST",
      headers,
      // `agent` is explicit so the same call works for the clara@ agent account (pinned to its own
      // tree) and an owner session with ai.settings.view (admin preview of "clara").
      body: JSON.stringify({ agent: ROOT_AGENT_KEY, include_subagents: true }),
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? TIMEOUT_MS),
    });
    const body = await r.json().catch(() => null) as { success?: boolean; data?: unknown; error?: string } | null;
    if (!r.ok || !body?.success || !isObj(body.data)) {
      throw new Error(`agent-settings-get ${r.status}${body?.error ? `: ${String(body.error).slice(0, 120)}` : ""}`);
    }
    return normalizeSnapshot(body.data, this.now());
  }
}

// ── The process-wide instance ──────────────────────────────────────────────────────────────────

/** CLARA's OS JWT: the clara@ agent session (ClaraAgent role) when signed in, else her main OS session. */
async function claraOsJwt(): Promise<string | null> {
  try {
    const agent = await import("./osAgentClient");
    if (agent.osAgentEnabled()) return await agent.osAgentAuth.getFreshOsJwt();
  } catch { /* fall through to the main session */ }
  try {
    const main = await import("./osClient");
    if (main.osEnabled()) return await main.osAuth.getFreshOsJwt();
  } catch { /* not signed in */ }
  return null;
}

const disabled = () =>
  (process.env.CLARA_AGENT_SETTINGS ?? "on").trim().toLowerCase() === "off" || Boolean(process.env.NODE_TEST_CONTEXT);

const g = globalThis as unknown as { __claraAgentSettings?: AgentSettingsClient };

function client(): AgentSettingsClient {
  if (!g.__claraAgentSettings) {
    // Off (CLARA_AGENT_SETTINGS=off, or inside `node --test`): built-in defaults, no network.
    g.__claraAgentSettings = disabled()
      ? new AgentSettingsClient({ autoRefresh: false })
      : new AgentSettingsClient({
        getJwt: claraOsJwt,
        baseUrl: process.env.ORION_SUPABASE_URL?.trim() || DEFAULT_OS_SUPABASE_URL,
        anonKey: process.env.ORION_SUPABASE_ANON_KEY?.trim() || undefined,
        // eslint-disable-next-line no-console
        log: (m) => console.warn(m),
      });
  }
  return g.__claraAgentSettings;
}

/** Effective settings (cached ~60s). Never throws; only the first read of the process waits (≤2.5s). */
export function getAgentSettings(): Promise<AgentSettingsSnapshot> {
  return client().get();
}

/** Synchronous read of the current snapshot for sync call sites (voice id, tool predicates). */
export function peekAgentSettings(): AgentSettingsSnapshot {
  return client().peek();
}

/** Test seam: swap the process-wide client. */
export function setAgentSettingsClientForTests(c: AgentSettingsClient | null): void {
  g.__claraAgentSettings = c ?? undefined;
}

const limiter = new MinuteRateLimiter();
/** One model call against the OS rate_limit_per_minute (no limit set → always true). */
export function takeModelCallSlot(limit: number | null | undefined): boolean {
  return limiter.take(limit);
}
