// Clara — "have I digested this meeting already?" ledger.
//
// Two keys per entry. `sourceKey` is exact (source + id) and catches re-polls. `fuzzyKey` catches
// the SAME meeting arriving from a second source — Wispr and a Gemini notes doc for one call — by
// calendar event id when a source gives one, else by a normalised title, and only counts as a
// duplicate when the start times sit within a window (10 min by default). Same title a week apart
// is a recurring meeting, not a dup. File writes are tmp+rename like every other dataDir store.

import { promises as fs } from "node:fs";
import path from "node:path";
import { loadConfig } from "../config";
import type { MeetingRecord, MeetingSource } from "./types";

export interface SeenEntry {
  sourceKey: string;
  fuzzyKey: string;
  startedAt: string;
  source: MeetingSource;
  notePath?: string;
  digestedAt: string;
}
export interface SeenFile {
  entries: SeenEntry[];
}

const FILE = "meetings-ingested.json";
const MAX_ENTRIES = 2000;
export const DUP_WINDOW_MS = 10 * 60_000;

export function sourceKey(rec: Pick<MeetingRecord, "source" | "sourceId">): string {
  return `${rec.source}:${rec.sourceId}`;
}

const SUFFIX_WORDS_RX = /\b(notes by gemini|gemini notes|meeting notes|transcript|notes)\b/gi;

// Safety net for titles that still carry a Meet/Gemini timestamp ("… - 2026/09/11 14:55 EDT").
const STAMP_WORDS_RX = /\b\d{4}\/\d{1,2}\/\d{1,2}\s+\d{1,2}:\d{2}(\s*[a-z]{2,5})?\b/gi;

export function normaliseTitle(title: string): string {
  return title
    .replace(STAMP_WORDS_RX, " ")
    .toLowerCase()
    .replace(SUFFIX_WORDS_RX, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function fuzzyKey(rec: Pick<MeetingRecord, "title" | "calendarEventId">): string {
  if (rec.calendarEventId) return `cal:${rec.calendarEventId}`;
  const t = normaliseTitle(rec.title ?? "");
  return t ? `title:${t}` : "";
}

export function isDuplicate(
  rec: Pick<MeetingRecord, "source" | "sourceId" | "title" | "calendarEventId" | "startedAt">,
  entries: SeenEntry[],
  windowMs: number = DUP_WINDOW_MS,
): boolean {
  const sk = sourceKey(rec);
  const fk = fuzzyKey(rec);
  const start = new Date(rec.startedAt).getTime();
  return entries.some((e) => {
    if (e.sourceKey === sk) return true;
    if (!fk || e.fuzzyKey !== fk) return false;
    const es = new Date(e.startedAt).getTime();
    if (Number.isNaN(start) || Number.isNaN(es)) return false;
    return Math.abs(start - es) <= windowMs;
  });
}

async function file(): Promise<string> {
  const cfg = await loadConfig();
  await fs.mkdir(cfg.dataDir, { recursive: true });
  return path.join(cfg.dataDir, FILE);
}

export async function loadSeen(): Promise<SeenFile> {
  try {
    const j = JSON.parse(await fs.readFile(await file(), "utf8")) as SeenFile;
    return { entries: Array.isArray(j.entries) ? j.entries : [] };
  } catch {
    return { entries: [] };
  }
}

async function save(s: SeenFile): Promise<void> {
  const p = await file();
  const tmp = `${p}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(s, null, 2), "utf8");
  await fs.rename(tmp, p);
}

export async function markSeen(entry: Omit<SeenEntry, "digestedAt"> & { digestedAt?: string }): Promise<void> {
  const s = await loadSeen();
  const next = s.entries.filter((e) => e.sourceKey !== entry.sourceKey);
  next.push({ ...entry, digestedAt: entry.digestedAt ?? new Date().toISOString() });
  await save({ entries: next.slice(-MAX_ENTRIES) });
}
