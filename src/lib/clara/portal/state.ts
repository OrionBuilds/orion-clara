// Portal triage cursor + seen set (dataDir/portal-triage-state.json). The cursor is the newest
// created_at seen minus a one-hour overlap, so a ticket that lands with a slightly old timestamp is
// still picked up; `seen` de-duplicates inside the overlap and is bounded.

import { promises as fs } from "node:fs";
import path from "node:path";
import { loadConfig } from "../config";

export interface PortalState { v: 1; since: string; seen: string[] }

const OVERLAP_MS = 60 * 60_000;
const BOUND = 2000;

export function initialState(now = new Date()): PortalState {
  // First run looks back a day so a fresh install doesn't route the entire history.
  return { v: 1, since: new Date(now.getTime() - 24 * 60 * 60_000).toISOString(), seen: [] };
}

export function advanceCursor(s: PortalState, tickets: Array<{ id: string; created_at?: string | null }>): PortalState {
  let newest = Date.parse(s.since) + OVERLAP_MS;
  for (const t of tickets) {
    const c = Date.parse(t.created_at ?? "");
    if (Number.isFinite(c) && c > newest) newest = c;
  }
  const seen = [...s.seen, ...tickets.map((t) => t.id).filter((id) => !s.seen.includes(id))].slice(-BOUND);
  return { v: 1, since: new Date(newest - OVERLAP_MS).toISOString(), seen };
}

export function isSeen(s: PortalState, id: string): boolean { return s.seen.includes(id); }
export function markSeen(s: PortalState, id: string): PortalState {
  return { ...s, seen: [...s.seen.filter((x) => x !== id), id].slice(-BOUND) };
}

async function file(): Promise<string> {
  const cfg = await loadConfig();
  await fs.mkdir(cfg.dataDir, { recursive: true });
  return path.join(cfg.dataDir, "portal-triage-state.json");
}

export async function loadPortalState(): Promise<PortalState> {
  try {
    const j = JSON.parse(await fs.readFile(await file(), "utf8")) as Partial<PortalState>;
    if (j.v === 1 && typeof j.since === "string" && Array.isArray(j.seen)) return j as PortalState;
  } catch { /* fresh */ }
  return initialState();
}

export async function savePortalState(s: PortalState): Promise<void> {
  const p = await file();
  const tmp = `${p}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(s), "utf8");
  await fs.rename(tmp, p);
}
