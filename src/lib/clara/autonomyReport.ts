// Clara — Wave 6 weekly AUTONOMY report, a section of the Sunday weekly review.
//
// Answers "what did the agents do on their own this week?" in one compact block: per agent —
// auto-executed count (with est $/day totals where the agent reports them), the top 5 lines, the
// shadow "would have auto-executed" count, format grants/revokes, and guardrail/breaker trips.
//
// Peer data comes from the Wave-6 `?report=weekly` extension of FRIDAY's authority API:
//   FRIDAY : GET {fridayBaseUrl}/api/friday/authority?report=weekly
// Same availability model as agentProxy.ts (mirrored, not shared — its fetch helper is module-
// private): 5s abort per fetch, last-good snapshot per agent in <dataDir>/autonomy-report-cache.json;
// a dead peer renders as "unreachable — skipped (cached from {ts})" or, with no cache, a one-line
// skip. The section ALWAYS renders — briefs.ts appends whatever this returns.
//
// CLARA has no authority API of her own: her block is her append-only ledger tail filtered to
// autonomous actions (kind "action", actor "clara") in the same 7-day window.

import { promises as fs } from "node:fs";
import path from "node:path";
import { loadConfig } from "./config";
import { readAll as readLedger } from "./ledger";

const REPORT_TIMEOUT_MS = 5_000;
const WEEK_MS = 7 * 24 * 3600_000;

// ── Peer report shape (every field normalized defensively) ──

interface ReportLine { ts: string; kind: string; client?: string; clientId?: string; text: string }
interface FormatLine { ts: string; client?: string; clientId?: string; formatKind: string; reason?: string }
export interface PeerAutonomyReport {
  autoExecuted: ReportLine[];
  wouldHave: ReportLine[];
  formatsGranted: FormatLine[];
  formatsRevoked: FormatLine[];
  trips: ReportLine[];
  /** Optional est $/day impact totals, when the agent reports them. */
  totals?: { autoExecutedCents?: number; wouldHaveCents?: number };
}
interface PeerFetch {
  agent: "friday";
  report: PeerAutonomyReport | null; // null → live fetch failed AND no cache exists
  fromCache: boolean;
  fetchedAt: string | null;
}

// Mirrors agentProxy.ts's module-private fetchWithTimeout (its helper isn't exported; owner rule
// keeps these modules independently editable).
async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { headers: { accept: "application/json" }, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

function asLines(v: unknown): ReportLine[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((r): r is Record<string, unknown> => typeof r === "object" && r !== null)
    .filter((r) => typeof r.text === "string")
    .map((r) => ({
      ts: typeof r.ts === "string" ? r.ts : "",
      kind: typeof r.kind === "string" ? r.kind : "unknown",
      client: typeof r.client === "string" ? r.client : undefined,
      clientId: typeof r.clientId === "string" ? r.clientId : undefined,
      text: r.text as string,
    }));
}

function asFormats(v: unknown): FormatLine[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((r): r is Record<string, unknown> => typeof r === "object" && r !== null)
    .filter((r) => typeof r.formatKind === "string")
    .map((r) => ({
      ts: typeof r.ts === "string" ? r.ts : "",
      client: typeof r.client === "string" ? r.client : undefined,
      clientId: typeof r.clientId === "string" ? r.clientId : undefined,
      formatKind: r.formatKind as string,
      reason: typeof r.reason === "string" ? r.reason : undefined,
    }));
}

function normalize(raw: Record<string, unknown>): PeerAutonomyReport {
  const totals = typeof raw.totals === "object" && raw.totals !== null ? (raw.totals as Record<string, unknown>) : undefined;
  return {
    autoExecuted: asLines(raw.autoExecuted),
    wouldHave: asLines(raw.wouldHave),
    formatsGranted: asFormats(raw.formatsGranted),
    formatsRevoked: asFormats(raw.formatsRevoked),
    trips: asLines(raw.trips),
    totals: totals
      ? {
          autoExecutedCents: typeof totals.autoExecutedCents === "number" ? totals.autoExecutedCents : undefined,
          wouldHaveCents: typeof totals.wouldHaveCents === "number" ? totals.wouldHaveCents : undefined,
        }
      : undefined,
  };
}

// ── Last-good cache (agentProxy pattern: per-agent snapshot, best-effort writes) ──

type CacheFile = Partial<Record<"friday", { fetchedAt: string; report: PeerAutonomyReport }>>;

async function cachePath(): Promise<string> {
  const cfg = await loadConfig();
  await fs.mkdir(cfg.dataDir, { recursive: true });
  return path.join(cfg.dataDir, "autonomy-report-cache.json");
}

async function fetchPeerReport(agent: "friday"): Promise<PeerFetch> {
  const cfg = await loadConfig();
  const url = `${cfg.fridayBaseUrl}/api/friday/authority?report=weekly`;
  try {
    const res = await fetchWithTimeout(url, REPORT_TIMEOUT_MS);
    if (!res.ok) throw new Error(`${agent} responded ${res.status}`);
    const raw = (await res.json()) as Record<string, unknown>;
    // A running build that predates ?report=weekly answers with the DEFAULT authority report —
    // no autoExecuted/wouldHave/trips arrays. Treat that as unreachable-for-this-purpose rather
    // than rendering an all-zero week as fact.
    if (!Array.isArray(raw.autoExecuted) || !Array.isArray(raw.wouldHave)) {
      throw new Error(`${agent} authority API predates ?report=weekly`);
    }
    const report = normalize(raw);
    const fetchedAt = new Date().toISOString();
    try {
      const p = await cachePath();
      let file: CacheFile = {};
      try { file = JSON.parse(await fs.readFile(p, "utf8")) as CacheFile; } catch { /* fresh */ }
      file[agent] = { fetchedAt, report };
      await fs.writeFile(p, JSON.stringify(file, null, 2), "utf8");
    } catch { /* cache write is best-effort */ }
    return { agent, report, fromCache: false, fetchedAt };
  } catch {
    try {
      const file = JSON.parse(await fs.readFile(await cachePath(), "utf8")) as CacheFile;
      const c = file[agent];
      if (c?.report) return { agent, report: normalize(c.report as unknown as Record<string, unknown>), fromCache: true, fetchedAt: c.fetchedAt ?? null };
    } catch { /* no cache either */ }
    return { agent, report: null, fromCache: true, fetchedAt: null };
  }
}

// ── Rendering ───────────────────────────────────────────────────────────────

function usd(cents: number): string {
  return `$${(Math.abs(cents) / 100).toFixed(2)}`;
}

function peerBlock(label: string, pf: PeerFetch): string[] {
  const out: string[] = [`### ${label}`];
  if (!pf.report) {
    out.push(`- ${label} unreachable — skipped (no cached report yet).`);
    return out;
  }
  if (pf.fromCache) out.push(`- ⚠️ ${label} unreachable — cached report from ${pf.fetchedAt ?? "unknown"}.`);
  const r = pf.report;

  const money = r.totals?.autoExecutedCents ? ` (est ${usd(r.totals.autoExecutedCents)}/day total impact)` : "";
  out.push(`- **Auto-executed: ${r.autoExecuted.length}**${money}`);
  for (const a of r.autoExecuted.slice(0, 5)) out.push(`  - ${a.text}`);
  if (r.autoExecuted.length > 5) out.push(`  - …and ${r.autoExecuted.length - 5} more.`);

  const wouldMoney = r.totals?.wouldHaveCents ? ` (est ${usd(r.totals.wouldHaveCents)}/day total impact)` : "";
  out.push(`- Would have auto-executed (shadow): ${r.wouldHave.length}${wouldMoney}`);

  if (r.formatsGranted.length || r.formatsRevoked.length) {
    const granted = r.formatsGranted.map((g) => `${g.formatKind} → ${g.client ?? g.clientId ?? "?"}`).join(", ");
    const revoked = r.formatsRevoked.map((g) => `${g.formatKind} × ${g.client ?? g.clientId ?? "?"}`).join(", ");
    out.push(`- Formats: ${r.formatsGranted.length} granted${granted ? ` (${granted})` : ""}, ${r.formatsRevoked.length} revoked${revoked ? ` (${revoked})` : ""}`);
  } else {
    out.push("- Formats: no grants or revokes this week.");
  }

  if (r.trips.length) {
    out.push(`- **Guardrail/breaker trips: ${r.trips.length}**`);
    for (const t of r.trips.slice(0, 5)) out.push(`  - ${t.text}`);
  } else {
    out.push("- Guardrail/breaker trips: none.");
  }
  return out;
}

/**
 * The full "## Autonomy report" markdown section (header included) for the Sunday weekly review.
 * Never throws: each peer degrades to an "unreachable — skipped" line, and Clara's own block
 * falls back to a ledger-unreadable note. briefs.ts appends the returned block verbatim.
 */
export async function composeAutonomyReport(now: Date = new Date()): Promise<string> {
  const nowMs = now.getTime();
  // FRIDAY is the only peer report.
  const [friday, ledger] = await Promise.all([
    fetchPeerReport("friday"),
    readLedger().catch(() => null),
  ]);

  // Clara's own autonomous week: ledger "action" rows by actor clara, last 7 days.
  const claraBlock: string[] = ["### CLARA"];
  if (ledger === null) {
    claraBlock.push("- Ledger unreadable — own actions skipped.");
  } else {
    const own = ledger.filter((l) => l.kind === "action" && l.actor === "clara" && nowMs - Date.parse(l.ts) < WEEK_MS);
    claraBlock.push(`- **Auto actions: ${own.length}**`);
    for (const l of own.slice(-5).reverse()) claraBlock.push(`  - ${l.what.slice(0, 200)}`);
    if (own.length > 5) claraBlock.push(`  - …and ${own.length - 5} more in the ledger.`);
  }

  return [
    `## Autonomy report (last 7 days)`,
    ...peerBlock("FRIDAY", friday),
    ...claraBlock,
  ].join("\n");
}
