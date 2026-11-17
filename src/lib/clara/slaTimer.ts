// Clara — generalized SLA age-threshold timer.
//
// Autonomy Spec v0.1, item #5: lifted out of scheduler.ts's runApprovalNudge(), which had this
// logic inlined and specific to one kind-based split (call.business > 4h, everything else > 24h).
// The owner's new numbers split on a different axis — business-hours (2h) vs. a client actively
// waiting (30min) — and item #8's out-of-scope-work escalation needs the identical bucket+stamp
// mechanics on a different item shape (a client SMS thread, not an approval row). Rather than
// duplicate the sidecar/stamp/prune dance a second time, both now go through this.
//
// Same durable-sidecar pattern as everywhere else in this codebase (alert-state.json,
// approval-nudges.json, approval-batch.json): dataDir/<filename>, tmp+rename, pruned to whatever
// ids are still live so the file can't grow without bound.

import { promises as fs } from "node:fs";
import path from "node:path";
import { loadConfig } from "./config";

export type SlaStamps = Record<string, Record<string, string>>; // id -> thresholdKey -> ISO fired-at

export interface SlaThreshold<T> {
  key: string;                 // stamp key, e.g. "businessHours2h", "clientWaiting30m"
  ms: number;                  // age threshold
  appliesTo?: (item: T) => boolean; // omit = applies to everything
}

export interface SlaCrossing<T> {
  item: T;
  id: string;
  key: string;
  ageMs: number;
}

async function sidecarFile(filename: string): Promise<string> {
  const cfg = await loadConfig();
  await fs.mkdir(cfg.dataDir, { recursive: true });
  return path.join(cfg.dataDir, filename);
}

export async function loadSlaStamps(filename: string): Promise<SlaStamps> {
  try { return JSON.parse(await fs.readFile(await sidecarFile(filename), "utf8")); }
  catch { return {}; }
}

/** Prunes stamps for ids no longer in `liveIds`, then writes tmp+rename. */
export async function saveSlaStamps(filename: string, stamps: SlaStamps, liveIds: Set<string>): Promise<void> {
  for (const id of Object.keys(stamps)) if (!liveIds.has(id)) delete stamps[id];
  const f = await sidecarFile(filename);
  const tmp = `${f}.tmp`;
  try {
    await fs.writeFile(tmp, JSON.stringify(stamps, null, 2), "utf8");
    await fs.rename(tmp, f);
  } catch (e) {
    console.error(`[sla-timer] ${filename} persist failed:`, e);
  }
}

/**
 * Finds items that have crossed a threshold not yet stamped. Thresholds are checked in the order
 * given and only the FIRST unstamped crossing per item fires this pass — same "one nudge per
 * tick" discipline the original approval-nudge had, so a long-idle item doesn't fire every
 * threshold at once the moment it's first scanned.
 */
export function findCrossings<T>(opts: {
  items: T[];
  getId: (item: T) => string;
  getAgeMs: (item: T) => number;
  thresholds: SlaThreshold<T>[];
  stamps: SlaStamps;
}): SlaCrossing<T>[] {
  const { items, getId, getAgeMs, thresholds, stamps } = opts;
  const out: SlaCrossing<T>[] = [];
  for (const item of items) {
    const id = getId(item);
    const age = getAgeMs(item);
    const already = stamps[id] ?? {};
    for (const t of thresholds) {
      if (t.appliesTo && !t.appliesTo(item)) continue;
      if (age <= t.ms) continue;
      if (already[t.key]) continue;
      out.push({ item, id, key: t.key, ageMs: age });
      break; // one crossing per item per pass
    }
  }
  return out;
}

export function stampCrossings<T>(stamps: SlaStamps, crossings: SlaCrossing<T>[], at = new Date().toISOString()): void {
  for (const c of crossings) {
    stamps[c.id] = { ...(stamps[c.id] ?? {}), [c.key]: at };
  }
}

/** 9am–5pm local, Mon–Fri. Simple and matches how the rest of this codebase treats "business hours". */
export function isBusinessHours(d: Date = new Date()): boolean {
  const day = d.getDay();
  const hour = d.getHours();
  return day >= 1 && day <= 5 && hour >= 9 && hour < 17;
}
