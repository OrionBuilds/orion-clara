// Client-email triage bookkeeping. v1 was a flat array of ids that was written BEFORE the work, so a
// message whose draft failed was retired forever with nothing to show for it (2026-09-14). v2 keeps
// three lists: handled (success only), noted (unknown senders already mentioned to the owner), and failed
// attempts — retried up to MAX_ATTEMPTS, then given up loudly.

import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";

export interface TriageState {
  v: 2;
  handled: string[];
  noted: string[];
  failed: Record<string, { attempts: number; lastAt: string }>;
}

export const MAX_ATTEMPTS = 3;
const BOUND = 2000;
export const STATE_FILE = path.join(os.homedir(), ".agentic-os", "clara", "client-triage-processed.json");

export function emptyState(): TriageState {
  return { v: 2, handled: [], noted: [], failed: {} };
}

/** Accepts the v1 array or a v2 object; anything else starts fresh. */
export function migrate(raw: unknown): TriageState {
  if (Array.isArray(raw)) return { v: 2, handled: raw.filter((x): x is string => typeof x === "string"), noted: [], failed: {} };
  if (raw && typeof raw === "object" && (raw as { v?: unknown }).v === 2) {
    const s = raw as Partial<TriageState>;
    return { v: 2, handled: Array.isArray(s.handled) ? s.handled : [], noted: Array.isArray(s.noted) ? s.noted : [], failed: s.failed && typeof s.failed === "object" ? s.failed : {} };
  }
  return emptyState();
}

export function isHandled(s: TriageState, id: string): boolean { return s.handled.includes(id); }
export function isNoted(s: TriageState, id: string): boolean { return s.noted.includes(id); }

export function markHandled(s: TriageState, id: string): TriageState {
  const { [id]: _drop, ...failed } = s.failed;
  return bound({ ...s, handled: [...s.handled.filter((x) => x !== id), id], failed });
}

export function markNoted(s: TriageState, id: string): TriageState {
  return bound({ ...s, noted: [...s.noted.filter((x) => x !== id), id] });
}

/** Count a failure; after MAX_ATTEMPTS the id is retired to `handled` and `gaveUp` is true. */
export function markFailed(s: TriageState, id: string, now = new Date().toISOString()): { state: TriageState; gaveUp: boolean } {
  const attempts = (s.failed[id]?.attempts ?? 0) + 1;
  if (attempts >= MAX_ATTEMPTS) return { state: markHandled(s, id), gaveUp: true };
  return { state: { ...s, failed: { ...s.failed, [id]: { attempts, lastAt: now } } }, gaveUp: false };
}

export function bound(s: TriageState): TriageState {
  return { ...s, handled: s.handled.slice(-BOUND), noted: s.noted.slice(-BOUND) };
}

export async function loadTriageState(file = STATE_FILE): Promise<TriageState> {
  try { return migrate(JSON.parse(await fs.readFile(file, "utf8"))); } catch { return emptyState(); }
}

export async function saveTriageState(s: TriageState, file = STATE_FILE): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true }).catch(() => {});
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(bound(s)), "utf8");
  await fs.rename(tmp, file);
}
