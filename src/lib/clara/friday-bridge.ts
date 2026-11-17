// Clara → FRIDAY delegation bridge.
//
// When Clara needs deep back-office work (research report, doc drafting, code, SEO analysis),
// she hands the task to FRIDAY over HTTP. Clara stays the front-of-house; FRIDAY is the shop
// floor.
//
// FRIDAY's local API surface has many endpoints; this bridge tries them in order of
// preference (talk → hermes chat → chat → memory note as fallback) so Clara isn't tightly
// coupled to a single FRIDAY route contract.

import { loadConfig } from "./config";
import { append as ledgerAppend } from "./ledger";
import { interagentAuthHeaders } from "@autom8ionlab/agent-core";

export interface DelegateOpts {
  kind?: "research" | "draft" | "code" | "seo" | "generic";
  history?: { role: "user" | "assistant"; text: string }[];
  timeoutMs?: number;
}

export interface DelegateResult {
  ok: boolean;
  via: string;                // which endpoint served it
  reply?: string;
  audio?: string;
  error?: string;
  /** What FRIDAY actually queued, when she queued anything — see DispatchResult in routing.ts. */
  taskIds?: string[];
  runId?: string;
  /** FRIDAY answered 401/403 — the interagent secret was rejected; nothing was tried further. */
  authFailed?: boolean;
}

async function friday(): Promise<string> {
  const cfg = await loadConfig();
  return cfg.fridayBaseUrl.replace(/\/$/, "");
}

// Try friday endpoints in priority order. First one that responds 2xx with usable body wins.
// All three carry the interagent shared-secret header (no-op unless INTERAGENT_SHARED_SECRET is
// configured on both sides — see @autom8ionlab/agent-core's interagent module).
const CANDIDATES: Array<(base: string, prompt: string, opts: DelegateOpts) => Promise<Response | null>> = [
  // 1. hermes/talk — short, fast, voice-shaped. Good for quick "look this up".
  async (base, prompt, opts) => {
    if (opts.kind && opts.kind !== "generic" && opts.kind !== "research") return null;
    return fetch(`${base}/api/hermes/talk`, {
      method: "POST",
      headers: { "content-type": "application/json", ...interagentAuthHeaders() },
      body: JSON.stringify({ text: prompt, history: opts.history ?? [] }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000),
    }).catch(() => null);
  },
  // 2. friday/chat — the real contract is { message: string, from?, channel?, history? }, NOT an
  //    OpenAI-shaped `messages` array (that mismatch used to 400 on every call — fixed here).
  async (base, prompt, opts) => {
    return fetch(`${base}/api/friday/chat`, {
      method: "POST",
      headers: { "content-type": "application/json", ...interagentAuthHeaders() },
      body: JSON.stringify({ message: prompt, from: "clara", channel: "web", history: opts.history ?? [] }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
    }).catch(() => null);
  },
  // (The old third candidate, POST /api/memory/log, was dropped 2026-09-14: a note in FRIDAY's memory
  //  is not a delegation, but its `{ok:true}` used to be counted as "Created 1 task for FRIDAY".)
];

/** Ids out of a `tasks`/`runs` field holding ids, objects with an id, or nothing. */
function idsFrom(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((x) => (typeof x === "string" ? x : (x as { id?: unknown } | null)?.id))
    .filter((x): x is string => typeof x === "string" && x.length > 0);
}

async function extract(r: Response, endpoint: string): Promise<{ reply?: string; audio?: string; taskIds?: string[]; runId?: string } | null> {
  try {
    return interpretFridayResponse(await r.json(), endpoint);
  } catch {
    return null;
  }
}

/** Pure: what a FRIDAY endpoint's JSON means. Exported for tests. */
export function interpretFridayResponse(json: unknown, endpoint: string): { reply?: string; audio?: string; taskIds?: string[]; runId?: string } | null {
  {
    const j = (json ?? {}) as {
      reply?: string; text?: string; content?: string | { text?: string }[]; audio?: string; ok?: boolean;
      tasks?: unknown; runs?: unknown; taskIds?: unknown; runId?: unknown;
    };
    // /api/friday/chat answers { reply, intent, tasks, runs, approvals } — `tasks` is what
    // orchestrate() materialised, and [] on the router path (a tool ran inline instead).
    const taskIds = idsFrom(j.tasks ?? j.taskIds);
    const runIds = idsFrom(j.runs);
    const runId = typeof j.runId === "string" ? j.runId : runIds[0];
    if (j.reply) return { reply: String(j.reply), audio: j.audio, taskIds, runId };
    if (j.text)  return { reply: String(j.text), taskIds, runId };
    if (Array.isArray(j.content)) {
      const t = j.content.map((b) => (typeof b === "string" ? b : b.text ?? "")).join(" ").trim();
      if (t) return { reply: t };
    }
    if (typeof j.content === "string") return { reply: j.content };
    // A bare {ok:true} (memory/log-style) is an acknowledgement, not an answer: no reply, no receipt.
    void endpoint;
    return null;
  }
}

export async function delegate(prompt: string, opts: DelegateOpts = {}): Promise<DelegateResult> {
  const base = await friday();
  for (const attempt of CANDIDATES) {
    const r = await attempt(base, prompt, opts);
    if (!r) continue;
    if (r.status === 401 || r.status === 403) {
      // Do not walk the remaining candidates: they carry the same header and would 401 the same way,
      // and the result must read as "our secret is wrong", not "FRIDAY is unreachable".
      return { ok: false, via: new URL(r.url).pathname, authFailed: true, error: `FRIDAY rejected the interagent secret (HTTP ${r.status}) — check INTERAGENT_SHARED_SECRET on both sides` };
    }
    if (!r.ok) continue;
    const parsed = await extract(r, r.url);
    if (!parsed) continue;
    // FRIDAY has the work at this point; a ledger hiccup must not turn that into "nothing ran".
    await ledgerAppend({
      kind: "action",
      actor: "clara",
      what: `delegated to FRIDAY (${new URL(r.url).pathname}): "${prompt.slice(0, 100)}"`,
      meta: { kind: opts.kind ?? "generic", taskIds: parsed.taskIds ?? [] },
    }).catch(() => {});
    return { ok: true, via: new URL(r.url).pathname, ...parsed };
  }
  return { ok: false, via: "none", error: "FRIDAY unreachable at " + base + " (tried talk, chat)" };
}

// Health check — is FRIDAY online at all?
export async function fridayHealth(): Promise<{ ok: boolean; base: string; error?: string }> {
  const base = await friday();
  try {
    const r = await fetch(`${base}/`, { signal: AbortSignal.timeout(3000) });
    return { ok: r.ok, base };
  } catch (e) {
    return { ok: false, base, error: (e as Error).message };
  }
}
