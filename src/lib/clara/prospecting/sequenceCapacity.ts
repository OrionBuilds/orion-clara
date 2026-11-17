// sequenceCapacity.ts — local, file-backed send counters for the sequence runner's capacity gate
// (plan §38/PR 14: "capacity[domain ramp, company 1/day & 3/week, contact 1/day, global/day, hourly
// breaker]"). Same convention as outbound.ts's own sent-record log: a rolling JSON file under
// dataDir, read/filtered by timestamp rather than a database table, because there is no OS read
// tool for outreach_events (confirmed while building personalize.ts's cache — see that file's doc
// comment) to derive these counts from instead. recordSend() is the one write; every count function
// is a read-only filter over the same log.

import { promises as fs } from "node:fs";
import path from "node:path";
import { loadConfig } from "../config";

export interface SendRecord {
  ts: number;
  channel: "email" | "sms";
  contactKey: string; // normalized phone for sms, lowercased email for email — whatever "one send/day to this person" should key on
  companyId: string;
  domain?: string; // the sender domain used, for domain-ramp counts
}

const DAY = 86_400_000;
const WEEK = DAY * 7;

async function file(): Promise<string> {
  const cfg = await loadConfig();
  const dir = path.join(cfg.dataDir, "prospecting");
  await fs.mkdir(dir, { recursive: true });
  return path.join(dir, "sequence-sends.json");
}

async function readAll(): Promise<SendRecord[]> {
  try { return JSON.parse(await fs.readFile(await file(), "utf8")) as SendRecord[]; } catch { return []; }
}

export async function recordSend(rec: Omit<SendRecord, "ts"> & { ts?: number }): Promise<void> {
  const f = await file();
  const rows = await readAll();
  rows.push({ ...rec, ts: rec.ts ?? Date.now() });
  const cutoff = Date.now() - WEEK * 2; // keep two weeks — covers the weekly company cap with margin
  await fs.writeFile(f, JSON.stringify(rows.filter((r) => r.ts >= cutoff).slice(-5000), null, 2), "utf8").catch(() => undefined);
}

export interface CapacityCounts {
  globalToday: number;
  contactToday: number;
  companyToday: number;
  companyThisWeek: number;
  domainToday: Record<string, number>;
}

export async function loadCapacityCounts(now: number = Date.now()): Promise<CapacityCounts> {
  const rows = await readAll();
  const todayStart = now - DAY;
  const weekStart = now - WEEK;
  const today = rows.filter((r) => r.ts >= todayStart);
  const domainToday: Record<string, number> = {};
  for (const r of today) if (r.domain) domainToday[r.domain] = (domainToday[r.domain] ?? 0) + 1;
  return {
    globalToday: today.length,
    contactToday: 0, // filled per-contact by the caller via countsForContact (see below) — kept out of the aggregate since it's per-recipient, not global
    companyToday: 0,
    companyThisWeek: 0,
    domainToday,
  };
}

export async function countsForTarget(contactKey: string, companyId: string, now: number = Date.now()): Promise<{ contactToday: number; companyToday: number; companyThisWeek: number }> {
  const rows = await readAll();
  const todayStart = now - DAY;
  const weekStart = now - WEEK;
  return {
    contactToday: rows.filter((r) => r.ts >= todayStart && r.contactKey === contactKey).length,
    companyToday: rows.filter((r) => r.ts >= todayStart && r.companyId === companyId).length,
    companyThisWeek: rows.filter((r) => r.ts >= weekStart && r.companyId === companyId).length,
  };
}

export async function domainSentToday(domain: string, now: number = Date.now()): Promise<number> {
  const rows = await readAll();
  const todayStart = now - DAY;
  return rows.filter((r) => r.ts >= todayStart && r.domain === domain).length;
}
