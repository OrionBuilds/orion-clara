// Clara — cross-agent approval federation. Her /inbox is the owner's personal command center, so it
// surfaces FRIDAY's pending approvals alongside her own, and proxies approve/reject to FRIDAY's
// REAL decide spine (`decideApproval` via POST /api/friday/approve) — never a parallel decision path.
//
// Availability model: sibling apps come and go independently of Clara. Every list fetch races a
// 3s abort; success refreshes a per-agent last-good snapshot (agent-proxy-cache.json under her
// dataDir); failure serves that snapshot flagged `fromCache` so the inbox degrades to "stale"
// rather than erroring or silently hiding pending work. No cache at all → graceful [].

import { promises as fs } from "node:fs";
import path from "node:path";
import { interagentAuthHeaders } from "@autom8ionlab/agent-core";
import { loadConfig } from "./config";

export type AgentName = "friday";
export type AgentDecision = "approve" | "reject";

/** Common normalized shape both agents' rows are mapped into. */
export interface AgentApproval {
  agent: AgentName;
  id: string;          // the agent's native approval id (uuid) — decide proxying needs it verbatim
  title: string;       // both apps call this `action` (human-readable "what will happen")
  detail?: string;
  risk: string;        // e.g. low|medium|high — passed through, not re-scored here
  requestedAt: string; // ISO — both apps' field name
  /** FRIDAY's shortCode convention (risk.ts): id minus dashes, last 4, uppercased. Internal only —
   *  never rendered to the owner since the plain-language decisions rail (decisions.ts). */
  code: string;
  // Structured fields the apps attach since 2026-09-24 (owner-comms overhaul) — what decisions.ts
  // phrases the plain-English question from. All optional: an older app version degrades to title.
  kind?: string;
  facts?: unknown;
  headline?: string;
  summary?: string;
  needsDecision?: { question?: string; options?: string[]; approvalId?: string };
  projectId?: string;
  clientId?: string;
  projectName?: string;
  clientName?: string;
  expiresAt?: string;
  amountUsd?: number;
  /** Money echo: what changes from → to (budget/bid rows), when the agent reports it. */
  fromValue?: unknown;
  toValue?: unknown;
  /** The untouched row, for resolvers that need a field this shape doesn't carry. Never rendered. */
  raw: unknown;
}

export interface AgentApprovalsResult {
  agent: AgentName;
  approvals: AgentApproval[];
  fromCache: boolean;       // true → live fetch failed, this is the last-good snapshot (or empty)
  fetchedAt: string | null; // when the served approvals were actually fetched live; null → never
}

const LIST_TIMEOUT_MS = 3_000;
// Decides are deliberately given longer: FRIDAY may execute work inside the decide spine
// (task sync, email release), and aborting the request wouldn't abort that work — it would only
// mis-report a success as a failure.
const DECIDE_TIMEOUT_MS = 15_000;

function shortCode(id: string): string {
  return id.replace(/-/g, "").slice(-4).toUpperCase();
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

// ── Last-good cache ─────────────────────────────────────────────────────────

interface CacheEntry { fetchedAt: string; approvals: AgentApproval[] }
type CacheFile = Partial<Record<AgentName, CacheEntry>>;

async function cachePath(): Promise<string> {
  const cfg = await loadConfig();
  await fs.mkdir(cfg.dataDir, { recursive: true });
  return path.join(cfg.dataDir, "agent-proxy-cache.json");
}

async function readCache(): Promise<CacheFile> {
  try {
    return JSON.parse(await fs.readFile(await cachePath(), "utf8")) as CacheFile;
  } catch { return {}; }
}

async function writeCache(agent: AgentName, entry: CacheEntry): Promise<void> {
  try {
    const file = await readCache();
    file[agent] = entry;
    await fs.writeFile(await cachePath(), JSON.stringify(file, null, 2), "utf8");
  } catch { /* cache is best-effort — a failed write must never break the live result */ }
}

// ── Normalizers ─────────────────────────────────────────────────────────────

// Both apps respond {approvals:[...]} (verified live 2026-07-30); rows are treated as untrusted
// and normalized defensively — a missing field degrades one row, never the whole fetch.
interface RawApprovalRow {
  id?: unknown; action?: unknown; detail?: unknown; risk?: unknown;
  requestedAt?: unknown; status?: unknown;
  kind?: unknown; facts?: unknown; headline?: unknown; summary?: unknown; needsDecision?: unknown;
  projectId?: unknown; clientId?: unknown; projectName?: unknown; clientName?: unknown;
  expiresAt?: unknown; amountUsd?: unknown; fromValue?: unknown; toValue?: unknown;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

export function normalizeRow(agent: AgentName, r: RawApprovalRow): AgentApproval | null {
  if (typeof r.id !== "string" || !r.id) return null;
  const nd = r.needsDecision && typeof r.needsDecision === "object" ? (r.needsDecision as { question?: unknown; options?: unknown; approvalId?: unknown }) : undefined;
  const facts = r.facts && typeof r.facts === "object" ? (r.facts as Record<string, unknown>) : undefined;
  return {
    agent,
    id: r.id,
    title: str(r.action) ?? str(r.headline) ?? `${agent} approval ${shortCode(r.id)}`,
    detail: str(r.detail),
    risk: typeof r.risk === "string" ? r.risk : "unknown",
    requestedAt: typeof r.requestedAt === "string" ? r.requestedAt : new Date(0).toISOString(),
    code: shortCode(r.id),
    kind: str(r.kind) ?? (facts ? str(facts.kind) : undefined),
    facts: r.facts,
    headline: str(r.headline),
    summary: str(r.summary),
    needsDecision: nd ? {
      question: str(nd.question),
      options: Array.isArray(nd.options) ? nd.options.filter((o): o is string => typeof o === "string") : undefined,
      approvalId: str(nd.approvalId),
    } : undefined,
    projectId: str(r.projectId),
    clientId: str(r.clientId),
    projectName: str(r.projectName) ?? (facts ? str(facts.projectName) : undefined),
    clientName: str(r.clientName) ?? (facts ? str(facts.clientName) : undefined),
    expiresAt: str(r.expiresAt),
    amountUsd: typeof r.amountUsd === "number" ? r.amountUsd : undefined,
    fromValue: r.fromValue,
    toValue: r.toValue,
    raw: r,
  };
}

async function listWithCache(
  agent: AgentName,
  url: string,
  pendingOnly: (rows: RawApprovalRow[]) => RawApprovalRow[],
): Promise<AgentApprovalsResult> {
  try {
    const res = await fetchWithTimeout(url, { headers: { accept: "application/json" } }, LIST_TIMEOUT_MS);
    if (!res.ok) throw new Error(`${agent} responded ${res.status}`);
    const json = (await res.json()) as { approvals?: RawApprovalRow[] };
    const rows = Array.isArray(json.approvals) ? json.approvals : [];
    const approvals = pendingOnly(rows)
      .map((r) => normalizeRow(agent, r))
      .filter((a): a is AgentApproval => a !== null);
    const fetchedAt = new Date().toISOString();
    await writeCache(agent, { fetchedAt, approvals });
    return { agent, approvals, fromCache: false, fetchedAt };
  } catch {
    const cached = (await readCache())[agent];
    return { agent, approvals: cached?.approvals ?? [], fromCache: true, fetchedAt: cached?.fetchedAt ?? null };
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

/** FRIDAY: GET /api/friday/approve?filter=pending — the server filters, so rows pass through. */
export async function fetchFridayApprovals(): Promise<AgentApprovalsResult> {
  const cfg = await loadConfig();
  return listWithCache("friday", `${cfg.fridayBaseUrl}/api/friday/approve?filter=pending`, (rows) => rows);
}


/**
 * Proxy a decision to the owning app's decide spine, translating Clara's approve|reject into its
 * verb dialect:
 *   FRIDAY : POST {base}/api/friday/approve      body {id, decision: "approved"|"rejected"}
 * Returns {ok,status} — non-2xx and network failures both come back ok:false so callers can leave
 * the item visible for retry instead of losing the approval.
 */
export async function decideAgentApproval(
  agent: AgentName,
  id: string,
  decision: AgentDecision,
  meta: { source?: string; decidedBy?: string; note?: string } = {},
): Promise<{ ok: boolean; status: number }> {
  const cfg = await loadConfig();
  // Provenance travels with the decision (owner-comms overhaul): the owning app stamps
  // decidedBy on its row so "owner via clara/sms" is visible in its own dashboard and logs.
  const prov = { source: meta.source ?? "clara", decidedBy: meta.decidedBy ?? "owner via clara", ...(meta.note ? { note: meta.note } : {}) };
  void agent; // FRIDAY is the only federated agent
  const target = {
    url: `${cfg.fridayBaseUrl}/api/friday/approve`,
    body: { id, decision: decision === "approve" ? "approved" : "rejected", ...prov },
  };
  try {
    const res = await fetchWithTimeout(target.url, {
      method: "POST",
      // The decide spine is interagent-gated; loopback used to clear it by accident of Host.
      headers: { "content-type": "application/json", ...interagentAuthHeaders() },
      body: JSON.stringify(target.body),
    }, DECIDE_TIMEOUT_MS);
    return { ok: res.ok, status: res.status };
  } catch {
    return { ok: false, status: 0 };
  }
}

// ── Morning-brief hook ──────────────────────────────────────────────────────

export interface AgentApprovalsSummary {
  counts: { friday: number };
  /** Per-agent staleness so the brief can say "FRIDAY unreachable — cached from {ts}". */
  fromCache: { friday: boolean };
  /** Top 5 oldest pending, oldest first. */
  oldest: Array<{ agent: AgentName; code: string; title: string; requestedAt: string; age: string }>;
}

function formatAge(ms: number): string {
  if (ms < 0) ms = 0;
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/**
 * Small, brief-ready rollup of FRIDAY's pending queue. NOT wired into briefs.ts here —
 * Wave 4's executive-brief composer calls it. `now` is injectable for unit tests.
 */
export async function summarizeAgentApprovals(now: number = Date.now()): Promise<AgentApprovalsSummary> {
  const friday = await fetchFridayApprovals();
  const all = [...friday.approvals]
    .sort((a, b) => a.requestedAt.localeCompare(b.requestedAt));
  return {
    counts: { friday: friday.approvals.length },
    fromCache: { friday: friday.fromCache },
    oldest: all.slice(0, 5).map((a) => ({
      agent: a.agent, code: a.code, title: a.title, requestedAt: a.requestedAt,
      age: formatAge(now - Date.parse(a.requestedAt)),
    })),
  };
}
