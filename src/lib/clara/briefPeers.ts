// Peer brief-section plumbing (extracted from briefs.ts, 2026-09-24, so briefModel.ts and
// briefs.ts can both use it without a circular import).
//
// FRIDAY's GET /api/friday/brief-section (5s timeout)
// with a last-good cache (<dataDir>/brief-section-cache.json) so the brief ALWAYS ships — a dead
// peer renders as "unreachable — cached from {ts}", never as a missing section or a failed brief.
// Queued items may carry structured fields (headline / summary / links / needsDecision) since the
// owner-comms overhaul; `text` remains the always-present fallback line.

import { promises as fs } from "node:fs";
import path from "node:path";
import { loadConfig } from "./config";

export interface PeerLink { label: string; url: string }
export interface PeerNeedsDecision { question: string; options?: string[]; approvalId?: string }
export interface PeerQueuedItem {
  id: string;
  kind: string;
  text: string;
  at: string;
  priority?: string;
  headline?: string;
  summary?: string;
  links?: PeerLink[];
  needsDecision?: PeerNeedsDecision;
}
export interface PeerPendingApproval {
  id: string;
  action: string;
  risk: string;
  requestedAt: string;
  code?: string;
  headline?: string;
  summary?: string;
  links?: PeerLink[];
  needsDecision?: PeerNeedsDecision;
}
export interface PeerSection {
  pendingApprovals: PeerPendingApproval[];
  autonomousActions: Array<{ ts: string; kind: string; text: string; link?: string; links?: PeerLink[] }>;
  anomalies: Array<{ kind: string; text: string }>;
  queued: PeerQueuedItem[];
}
export interface PeerFetch {
  agent: "friday";
  section: PeerSection | null; // null → never fetched successfully AND no cache exists
  fromCache: boolean;
  fetchedAt: string | null;
}

export const PEER_TIMEOUT_MS = 5_000;

export async function peerBriefUrl(_agent: "friday"): Promise<string> {
  const cfg = await loadConfig();
  return `${cfg.fridayBaseUrl}/api/friday/brief-section`;
}

async function peerCachePath(): Promise<string> {
  const cfg = await loadConfig();
  await fs.mkdir(cfg.dataDir, { recursive: true });
  return path.join(cfg.dataDir, "brief-section-cache.json");
}

type PeerCacheFile = Partial<Record<"friday", { fetchedAt: string; section: PeerSection }>>;

export async function fetchPeerSection(agent: "friday"): Promise<PeerFetch> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), PEER_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(await peerBriefUrl(agent), { headers: { accept: "application/json" }, signal: ctrl.signal });
    } finally {
      clearTimeout(t);
    }
    if (!res.ok) throw new Error(`${agent} responded ${res.status}`);
    const raw = (await res.json()) as Partial<PeerSection>;
    // Defensive normalization — a peer mid-deploy must degrade a field, never kill the brief.
    const section: PeerSection = {
      pendingApprovals: Array.isArray(raw.pendingApprovals) ? raw.pendingApprovals : [],
      autonomousActions: Array.isArray(raw.autonomousActions) ? raw.autonomousActions : [],
      anomalies: Array.isArray(raw.anomalies) ? raw.anomalies : [],
      queued: Array.isArray(raw.queued) ? raw.queued : [],
    };
    const fetchedAt = new Date().toISOString();
    try {
      const p = await peerCachePath();
      let file: PeerCacheFile = {};
      try { file = JSON.parse(await fs.readFile(p, "utf8")) as PeerCacheFile; } catch { /* fresh */ }
      file[agent] = { fetchedAt, section };
      await fs.writeFile(p, JSON.stringify(file, null, 2), "utf8");
    } catch { /* cache write is best-effort */ }
    return { agent, section, fromCache: false, fetchedAt };
  } catch {
    try {
      const file = JSON.parse(await fs.readFile(await peerCachePath(), "utf8")) as PeerCacheFile;
      const c = file[agent];
      if (c?.section) return { agent, section: c.section, fromCache: true, fetchedAt: c.fetchedAt ?? null };
    } catch { /* no cache either */ }
    return { agent, section: null, fromCache: true, fetchedAt: null };
  }
}

// POST the consumed queue ids back to a peer AFTER successful delivery. Best-effort: a peer that
// went down between compose and ack keeps its items and re-serves them next brief — its own 24h
// no-ack digest fallback (flushDigest) is the backstop, so nothing is ever lost either way.
export async function ackPeerQueue(agent: "friday", ids: string[] | undefined): Promise<{ sent: number; removed: number | null; ok: boolean }> {
  if (!ids?.length) return { sent: 0, removed: 0, ok: true };
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), PEER_TIMEOUT_MS);
    try {
      const r = await fetch(await peerBriefUrl(agent), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids }),
        signal: ctrl.signal,
      });
      const j = (await r.json().catch(() => ({}))) as { removed?: number; acked?: number };
      const removed = typeof j.removed === "number" ? j.removed : typeof j.acked === "number" ? j.acked : null;
      return { sent: ids.length, removed, ok: r.ok };
    } finally {
      clearTimeout(t);
    }
  } catch { /* peer down — items reappear next brief, digest fallback covers >24h */ }
  return { sent: ids.length, removed: null, ok: false };
}

export function formatAge(iso: string, now: number): string {
  let ms = now - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}
