// Team status — "how's Globex going?" answered by CLARA herself, with provenance.
//
// Before this (2026-09-24) a status question either fell to deal_lookup/crm_lookup (wrong data) or
// was free-texted to a bench's chat through delegate_to_agent — which could create a task and never
// gave a structured answer. FRIDAY (POST /api/friday/status) now
// answers the interagent `status` kind with a StatusResponse: stage, health, recent activity, what's
// open / blocked / next, pending approvals, and a sources[] list saying how fresh each input is.
//
// CLARA's job here is to resolve the subject, ask the bench, remember the last good
// answer per subject (so an unreachable bench degrades to "as of 40m ago" rather than silence), and
// render the result as prose: the answer first, provenance second, detail after. Nothing is filled
// in from the model — every line traces to a bench field or to CLARA's own delegation receipts.

import { promises as fs } from "node:fs";
import path from "node:path";
import { postStatus, type StatusRequest, type StatusResponse, type StatusResult, type StatusSubject, type StatusItem } from "@autom8ionlab/agent-core";
import { loadConfig } from "./config";
import { osClient, osEnabled } from "./osClient";
import type { Delegation } from "./delegations";
import { renderAsk, type Decision } from "./decisions";

export type StatusChannel = "sms" | "voice" | "chat" | "email" | "web";
export type Bench = "friday";

export interface SubjectCandidate { id: string; name: string; client?: string }
export type ResolvedSubject = StatusSubject & { candidates?: SubjectCandidate[] };

export interface StatusParts {
  friday?: StatusResult;
  /** CLARA's own hand-off receipts for this subject (or all, in portfolio mode). */
  delegations?: Delegation[];
  /** Pending decisions touching this subject, rendered via renderAsk. */
  decisions?: Decision[];
  /** Set when a bench answer came from the last-good cache. */
  cached?: Partial<Record<Bench, { fetchedAt: string }>>;
  /** Benches that were asked and returned nothing usable. */
  unreachable?: Bench[];
}

// ── Subject resolution ─────────────────────────────────────────────────────

function unwrap(content: unknown): unknown {
  if (Array.isArray(content)) {
    const first = content.find((c) => c && typeof c === "object" && "text" in (c as object));
    if (first && typeof (first as { text?: unknown }).text === "string") {
      try { return JSON.parse((first as { text: string }).text); } catch { return (first as { text: string }).text; }
    }
  }
  return content;
}
function rowsOf<T>(v: unknown): T[] {
  if (Array.isArray(v)) return v as T[];
  if (v && typeof v === "object") {
    for (const k of ["data", "projects", "contacts", "rows", "items", "results"]) {
      const inner = (v as Record<string, unknown>)[k];
      if (Array.isArray(inner)) return inner as T[];
    }
  }
  return [];
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const tokens = (s: string) => norm(s).split(" ").filter((t) => t.length > 1);

interface OsProject { id: string; name?: string; status?: string; contact?: { name?: string; company?: string; company_name?: string } | null; client_name?: string; company?: string }
interface OsContact { id: string; name?: string; first_name?: string; last_name?: string; company?: string; company_name?: string }

function projectClient(p: OsProject): string | undefined {
  return p.client_name ?? p.company ?? p.contact?.company ?? p.contact?.company_name ?? p.contact?.name ?? undefined;
}

/** Pure: rank rows by name match against the query. Exact > starts-with > contains > token overlap. */
export function rankByName<T extends { name: string }>(query: string, rows: T[]): T[] {
  const q = norm(query);
  if (!q) return [];
  const qt = tokens(query);
  const scored = rows.map((r) => {
    const n = norm(r.name);
    let score = 0;
    if (n === q) score = 100;
    else if (n.startsWith(q)) score = 85;      // the owner typed the start of the name
    else if (q.startsWith(n)) score = 65;      // the name is a prefix of what the owner typed — weaker
    else if (n.includes(q) || q.includes(n)) score = 60;
    else {
      const nt = new Set(tokens(r.name));
      const overlap = qt.filter((t) => nt.has(t)).length;
      if (overlap) score = 20 + overlap * 10;
    }
    return { r, score };
  }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score);
  if (!scored.length) return [];
  // A clear winner beats the pack by ≥20 points; otherwise it's ambiguous and all top-tier rows return.
  const top = scored[0].score;
  if (top === 100) return scored.filter((x) => x.score === 100).map((x) => x.r); // an exact name wins outright
  return scored.filter((x) => x.score >= top - 19).map((x) => x.r);
}

/**
 * Resolve a spoken/typed name to a status subject: OS projects first (their names are what the owner uses),
 * then contacts/companies for client-level questions. Ambiguity returns `candidates` instead of a guess.
 */
export async function resolveSubject(query: string): Promise<ResolvedSubject> {
  const q = query.trim();
  if (!q) return { type: "portfolio" };
  if (/^(everything|all projects|the team|the portfolio|all clients|overall)$/i.test(q)) return { type: "portfolio" };
  if (!osEnabled()) return { type: "project", name: q };

  const projects = rowsOf<OsProject>(unwrap(await osClient.callTool("projects_list", {}).catch(() => null)))
    .filter((p) => p && typeof p.id === "string" && typeof p.name === "string")
    .map((p) => ({ id: p.id, name: p.name as string, client: projectClient(p), status: p.status }));
  const active = projects.filter((p) => !p.status || /active|in_progress|open|review/i.test(p.status));
  let hits = rankByName(q, active);
  if (!hits.length) hits = rankByName(q, projects);
  if (hits.length === 1) return { type: "project", id: hits[0].id, name: hits[0].name };
  if (hits.length > 1) {
    return { type: "project", name: q, candidates: hits.slice(0, 4).map((h) => ({ id: h.id, name: h.name, ...(h.client ? { client: h.client } : {}) })) };
  }

  const contacts = rowsOf<OsContact>(unwrap(await osClient.callTool("contacts_list", { search: q, limit: 10 }).catch(() => null)))
    .filter((c) => c && typeof c.id === "string")
    .map((c) => ({ id: c.id, name: (c.company ?? c.company_name ?? c.name ?? [c.first_name, c.last_name].filter(Boolean).join(" ")) as string }))
    .filter((c) => c.name);
  const chits = rankByName(q, contacts);
  if (chits.length === 1) return { type: "client", id: chits[0].id, name: chits[0].name };
  if (chits.length > 1) return { type: "client", name: q, candidates: chits.slice(0, 4).map((c) => ({ id: c.id, name: c.name })) };
  // Nothing in the OS — let the benches try their own registries by name.
  return { type: "project", name: q };
}

// ── Fetch with last-good cache ─────────────────────────────────────────────

const CACHE_FILE = "status-cache.json";
type Cache = Record<string, { fetchedAt: string; result: StatusResponse }>;

async function cachePath(): Promise<string> {
  const cfg = await loadConfig();
  await fs.mkdir(cfg.dataDir, { recursive: true });
  return path.join(cfg.dataDir, CACHE_FILE);
}
async function loadCache(): Promise<Cache> {
  try { return JSON.parse(await fs.readFile(await cachePath(), "utf8")) as Cache; } catch { return {}; }
}
async function saveCache(c: Cache): Promise<void> {
  const p = await cachePath();
  const cutoff = Date.now() - 7 * 24 * 3600_000;
  for (const [k, v] of Object.entries(c)) if (Date.parse(v.fetchedAt) < cutoff) delete c[k];
  const tmp = `${p}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(c, null, 2), "utf8");
  await fs.rename(tmp, p);
}
const cacheKey = (bench: Bench, s: StatusSubject) => `${bench}:${s.type}:${(s.id ?? s.name ?? "").toLowerCase()}`;

export interface FetchedStatuses {
  friday?: StatusResult;
  cached: Partial<Record<Bench, { fetchedAt: string }>>;
  unreachable: Bench[];
  errors: string[];
}

/** Ask the bench; an unreachable bench falls back to its last good answer. */
export async function fetchStatuses(subject: StatusSubject, since?: string, opts: { timeoutMs?: number } = {}): Promise<FetchedStatuses> {
  const cfg = await loadConfig();
  const req: StatusRequest = { from: "clara", kind: "status", subject: { type: subject.type, ...(subject.id ? { id: subject.id } : {}), ...(subject.name ? { name: subject.name } : {}) }, ...(since ? { since } : {}) };
  const timeoutMs = opts.timeoutMs ?? 8_000;
  const [f] = await Promise.allSettled([
    postStatus(cfg.fridayBaseUrl.replace(/\/+$/, ""), req, { path: "/api/friday/status", timeoutMs }),
  ]);
  const out: FetchedStatuses = { cached: {}, unreachable: [], errors: [] };
  const cache = await loadCache().catch(() => ({} as Cache));
  let dirty = false;
  for (const [bench, settled] of [["friday", f]] as const) {
    const r: StatusResult | null = settled.status === "fulfilled" ? settled.value : null;
    const reason = settled.status === "rejected" ? String(settled.reason).slice(0, 120) : (r && !r.ok ? r.error : "");
    // "not found" / "ambiguous" are real answers, not outages — keep them. Transport errors are outages.
    const transportError = !r || (!r.ok && /timeout|fetch|ECONN|abort|malformed|unauthori|HTTP \d|→ \d{3}/i.test(r.error ?? ""));
    if (r && r.ok) {
      out[bench] = r;
      cache[cacheKey(bench, subject)] = { fetchedAt: new Date().toISOString(), result: r };
      dirty = true;
      continue;
    }
    if (r && !r.ok && !transportError) { out[bench] = r; continue; }
    out.unreachable.push(bench);
    if (reason) out.errors.push(`${bench}: ${reason}`);
    const last = cache[cacheKey(bench, subject)];
    if (last) { out[bench] = last.result; out.cached[bench] = { fetchedAt: last.fetchedAt }; }
  }
  if (dirty) await saveCache(cache).catch(() => {});
  return out;
}

// ── Rendering (pure) ───────────────────────────────────────────────────────

const stripEmoji = (s: string) => s.replace(/[\p{Extended_Pictographic}️‍]/gu, "").replace(/\s{2,}/g, " ").trim();
const stripCodes = (s: string) => s.replace(/\s*[\[(]#[0-9A-Z]{3,8}[\])]\s*/g, " ").replace(/\bapprove\s+#\S+/gi, "").replace(/\s+/g, " ").trim();
const clean = (s: string) => stripCodes(stripEmoji(s));

export function ago(iso: string, now: number): string {
  let ms = now - Date.parse(iso);
  if (!Number.isFinite(ms)) return "unknown";
  if (ms < 0) ms = 0;
  const m = Math.floor(ms / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return d === 1 ? "yesterday" : `${d} days ago`;
}

function clock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

const HEALTH_WORD: Record<StatusResponse["summary"]["health"], string> = { green: "on track", amber: "needs attention", red: "in trouble", unknown: "status unclear" };

function item(i: StatusItem, now: number, links: boolean): string {
  const when = i.when ? ` (${ago(i.when, now)})` : "";
  const link = links && i.link ? ` ${i.link}` : "";
  return `- ${clean(i.headline)}${when}${link}`;
}

function provenance(sr: StatusResponse | undefined, bench: Bench, now: number, cachedAt?: string, unreachable?: boolean): string {
  const label = bench.toUpperCase();
  if (!sr) return unreachable ? `${label} unreachable and I have nothing on file` : "";
  if (cachedAt) return `${label} unreachable — last I saw was ${ago(cachedAt, now)}`;
  const ok = sr.sources.filter((s) => s.ok);
  const dead = sr.sources.filter((s) => !s.ok).map((s) => s.name);
  const fresh = ok.slice(0, 3).map((s) => `${s.name} ${ago(s.fetchedAt, now)}`).join(", ");
  const parts = [fresh, dead.length ? `${dead.join(", ")} unreachable` : ""].filter(Boolean).join("; ");
  return `per ${label}: ${parts || "no sources reported"}`;
}

function benchLines(sr: StatusResponse, opts: { now: number; short: boolean; links: boolean }): string[] {
  const lines: string[] = [];
  const cap = opts.short ? 3 : 8;
  if (sr.recent.length) {
    lines.push(opts.short ? "Recent:" : "Recent activity:");
    for (const i of sr.recent.slice(0, cap)) lines.push(item(i, opts.now, opts.links));
  }
  if (sr.blocked.length) {
    lines.push("Blocked:");
    for (const i of sr.blocked.slice(0, opts.short ? 2 : 5)) lines.push(item(i, opts.now, opts.links));
  }
  if (!opts.short && sr.open.length) {
    lines.push("In flight:");
    for (const i of sr.open.slice(0, 5)) lines.push(item(i, opts.now, opts.links));
  }
  if (sr.nextUp.length) {
    lines.push("Next up:");
    for (const i of sr.nextUp.slice(0, opts.short ? 2 : 4)) lines.push(item(i, opts.now, opts.links));
  }
  return lines;
}

const SMS_MAX_LINES = 6;
const SMS_MAX_CHARS = 600;

function fitShort(lines: string[]): string {
  const kept: string[] = [];
  let chars = 0;
  for (const l of lines) {
    if (kept.length >= SMS_MAX_LINES) break;
    if (chars + l.length + 1 > SMS_MAX_CHARS) {
      const room = SMS_MAX_CHARS - chars - 1;
      if (room > 40) kept.push(`${l.slice(0, room - 1)}…`);
      break;
    }
    kept.push(l);
    chars += l.length + 1;
  }
  return kept.join("\n");
}

function delegationLines(rows: Delegation[], now: number, short: boolean): string[] {
  if (!rows.length) return [];
  const lines = ["Hand-offs:"];
  for (const d of rows.slice(0, short ? 2 : 6)) {
    const state = d.status === "open" ? "in progress" : d.status;
    lines.push(`- ${d.bench.toUpperCase()} — ${clean(d.summary)}: ${state} (${ago(d.lastPolledAt ?? d.createdAt, now)})`);
  }
  return lines;
}

/**
 * Render the answer. Line 1 answers the question; line 2 says where it came from and how fresh;
 * everything else is detail. SMS/voice: ≤6 lines, ≤600 chars; voice never reads links aloud.
 */
export function renderStatus(parts: StatusParts, opts: { channel: StatusChannel; now?: number }): string {
  const now = opts.now ?? Date.now();
  const short = opts.channel === "sms" || opts.channel === "voice";
  const links = opts.channel !== "voice";
  const fr = parts.friday && parts.friday.ok ? parts.friday : undefined;
  const ambiguous = [parts.friday].find((r) => r && !r.ok && r.error === "ambiguous" && r.candidates?.length);
  if (!fr && ambiguous && !ambiguous.ok && ambiguous.candidates) {
    const names = ambiguous.candidates.slice(0, 3).map((c) => (c.client ? `${c.name} (${c.client})` : c.name));
    return names.length === 2 ? `Which one — ${names[0]}, or ${names[1]}?` : `Which one — ${names.slice(0, -1).join(", ")}, or ${names[names.length - 1]}?`;
  }

  const primary = fr;
  const lines: string[] = [];
  if (!primary) {
    const who = (parts.unreachable ?? []).map((b) => b.toUpperCase()).join(" and ");
    const notFound = [parts.friday].some((r) => r && !r.ok && /not found/i.test(r.error));
    lines.push(notFound ? "I don't have a project or client by that name on the bench." : `I couldn't reach ${who || "the team"} and have nothing on file for that yet.`);
    lines.push(...delegationLines(parts.delegations ?? [], now, short));
    return short ? fitShort(lines) : lines.join("\n");
  }

  // Portfolio: one line per project (worst first), then per-bench provenance.
  if (primary.subject.type === "portfolio") {
    lines.push(`Across the board: ${clean(primary.summary.headline)}`);
    lines.push(`As of ${clock(primary.asOf)} today — ${[provenance(fr, "friday", now, parts.cached?.friday?.fetchedAt, parts.unreachable?.includes("friday"))].filter(Boolean).join("; ")}.`);
    for (const sr of [fr]) if (sr) for (const i of sr.recent.slice(0, short ? 3 : 8)) lines.push(item(i, now, links));
    for (const sr of [fr]) if (sr && sr.blocked.length) { lines.push("Blocked:"); for (const i of sr.blocked.slice(0, 3)) lines.push(item(i, now, links)); }
    lines.push(...delegationLines(parts.delegations ?? [], now, short));
    return short ? fitShort(lines) : lines.join("\n");
  }

  // Single subject.
  const name = primary.subject.name;
  const stage = primary.summary.stage ? ` is in ${primary.summary.stage} and` : " is";
  const healthWord = HEALTH_WORD[primary.summary.health] ?? primary.summary.health;
  const headline = clean(primary.summary.headline);
  lines.push(`${name}${stage} ${healthWord}${headline ? ` — ${headline.replace(/[.]+$/, "")}.` : "."}`.replace(/\s+/g, " "));
  const prov = [
    provenance(fr, "friday", now, parts.cached?.friday?.fetchedAt, parts.unreachable?.includes("friday")),
  ].filter(Boolean).join("; ");
  lines.push(`As of ${clock(primary.asOf)} today, ${prov}.`);
  lines.push(...benchLines(primary, { now, short, links }));

  lines.push(...delegationLines(parts.delegations ?? [], now, short));
  const asks = parts.decisions ?? [];
  const pending = primary.approvalsPending;
  if (asks.length) {
    lines.push("Waiting on you:");
    for (const d of asks.slice(0, short ? 1 : 3)) lines.push(`- ${renderAsk(d, short ? "sms" : "chat")}`);
  } else if (pending.length) {
    lines.push("Waiting on you:");
    for (const i of pending.slice(0, short ? 1 : 3)) lines.push(`- ${clean(i.headline)}${i.detail ? ` — ${clean(i.detail)}` : ""}`);
  }
  return short ? fitShort(lines) : lines.join("\n");
}

// ── Convenience: one call from a tool ─────────────────────────────────────

const subjectTouches = (d: Delegation, name: string): boolean => {
  const n = norm(name);
  return !!n && (norm(d.summary).includes(n) || norm(d.client?.name ?? "").includes(n));
};

/** Resolve + fetch + render. Returns the prose and, for tools, the parts it was built from. */
export async function answerStatus(query: string, channel: StatusChannel, opts: { since?: string; kind?: "project" | "client" } = {}): Promise<{ text: string; subject: ResolvedSubject; parts: StatusParts }> {
  const subject = await resolveSubject(query);
  if (subject.candidates?.length) {
    const names = subject.candidates.map((c) => (c.client ? `${c.name} (${c.client})` : c.name));
    const text = names.length === 2 ? `Which one — ${names[0]}, or ${names[1]}?` : `Which one — ${names.slice(0, -1).join(", ")}, or ${names[names.length - 1]}?`;
    return { text, subject, parts: {} };
  }
  if (opts.kind && subject.type !== "portfolio") subject.type = opts.kind;
  const fetched = await fetchStatuses(subject, opts.since);
  const { readAll } = await import("./delegations");
  const all = await readAll().catch(() => [] as Delegation[]);
  const cutoff = Date.now() - 48 * 3600_000;
  const delegations = all.filter((d) => (d.status === "open" || d.status === "parked" || Date.parse(d.lastPolledAt ?? d.createdAt) > cutoff))
    .filter((d) => subject.type === "portfolio" || subjectTouches(d, subject.name ?? ""))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  let decisions: Decision[] = [];
  try {
    const { listPendingDecisions } = await import("./decisions");
    const pd = await listPendingDecisions();
    const n = norm(subject.name ?? "");
    decisions = subject.type === "portfolio" ? pd.decisions.slice(0, 3) : pd.decisions.filter((d) => n && (norm(d.subject?.project ?? "").includes(n) || norm(d.subject?.client ?? "").includes(n) || norm(d.title).includes(n)));
  } catch { /* decisions are additive */ }
  const parts: StatusParts = { friday: fetched.friday, delegations, decisions, cached: fetched.cached, unreachable: fetched.unreachable };
  let text = renderStatus(parts, { channel });
  // FRIDAY's own vault memory for this project/client ("where it was left off").
  // Chat/email only — SMS and voice stay short.
  if (subject.type !== "portfolio" && subject.name && channel !== "sms" && channel !== "voice") {
    const { peerMemory } = await import("./vaultMemory");
    const peer = await peerMemory(subject.name).catch(() => "");
    if (peer) text = `${text}\n\nFrom their notes: ${peer}`;
  }
  return { text, subject, parts };
}

/** "Did FRIDAY finish that?" — CLARA's own receipts, no bench call needed. */
export function renderDelegations(rows: Delegation[], query: string | undefined, channel: StatusChannel, now = Date.now()): string {
  const short = channel === "sms" || channel === "voice";
  const q = norm(query ?? "");
  const cutoff = now - 48 * 3600_000;
  const matched = rows
    .filter((d) => d.status === "open" || d.status === "parked" || Date.parse(d.lastPolledAt ?? d.createdAt) > cutoff)
    .filter((d) => !q || subjectTouches(d, q) || norm(d.bench).includes(q))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  if (!matched.length) return q ? `I haven't handed anything matching "${query}" to FRIDAY in the last two days.` : "Nothing handed to FRIDAY is open right now, and nothing finished in the last two days.";
  const open = matched.filter((d) => d.status === "open" || d.status === "parked");
  const done = matched.filter((d) => d.status === "done");
  const other = matched.filter((d) => d.status === "failed" || d.status === "stale");
  const lines: string[] = [];
  lines.push(`${open.length} in progress, ${done.length} finished, ${other.length} stuck.`);
  const fmt = (d: Delegation) => `- ${d.bench.toUpperCase()} — ${clean(d.summary)}: ${d.status === "open" ? "in progress" : d.status}${d.benchTaskIds.length ? "" : " (no task id yet)"} (${ago(d.lastPolledAt ?? d.createdAt, now)})`;
  for (const d of [...open, ...done, ...other].slice(0, short ? 4 : 10)) lines.push(fmt(d));
  return short ? fitShort(lines) : lines.join("\n");
}
