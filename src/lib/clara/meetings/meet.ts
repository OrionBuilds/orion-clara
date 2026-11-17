// Clara — Google Meet / Gemini notes as a meeting source (Drive-based).
//
// Meet writes "<title> - Transcript" and Gemini writes "<title> - Notes by Gemini" / "Meeting
// notes" Google Docs into the organiser's Drive. This mirrors FRIDAY's Drive fallback query
// exactly (src/lib/friday/google/meet.ts) so both agents see the same set of docs — but ONLY
// CLARA digests them now. Docs younger than 90 minutes are skipped on purpose: Wispr finalises
// within minutes of a meeting ending and is the richer record (speaker-attributed, attendee
// emails), so giving it a head start means the Drive copy dedupes against the Wispr digest via
// seen.ts's fuzzy key instead of racing it.
//
// The Meet REST API branch (conferenceRecords → transcripts) is behind CLARA_MEET_API=on and is
// a stub: it needs the meetings.space.readonly scope on the work token, which isn't granted today.

import { listDriveByQuery, readAsText, type DriveFile } from "../ms-files";
import type { MeetingRecord } from "./types";

const DOC_MIME = "application/vnd.google-apps.document";
const MIN_AGE_MS = 90 * 60_000;
const MAX_CHARS = 120_000;

const SUFFIX_RX = /\s*[-–—:|]\s*(transcript|notes by gemini|gemini notes|meeting notes)\s*$/i;
const PREFIX_RX = /^\s*(notes by gemini|meeting notes|transcript)\s*[-–—:|]\s*/i;

// Meet/Gemini embed the scheduled start in the doc name:
//   "Dana Sample - 2026/09/11 14:55 EDT - Notes by Gemini"
// Without parsing it, the title keeps the timestamp and startedAt falls back to the doc's
// createdTime (written ~30 min after the call started), so the same meeting from Wispr and from
// Drive would never dedupe. US zone abbreviations cover the owner's calendar; unknown ones → no start.
const STAMP_RX = /\s*[-–—]\s*(\d{4})\/(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})\s*([A-Z]{2,5})?\s*$/;
const TZ_OFFSET_H: Record<string, number> = {
  UTC: 0, GMT: 0, EDT: -4, EST: -5, CDT: -5, CST: -6, MDT: -6, MST: -7, PDT: -7, PST: -8, AKDT: -8, AKST: -9, HST: -10,
};

/** Pure — tested. Title without suffix/timestamp, plus the scheduled start when the name carries one. */
export function parseMeetName(name: string): { title: string; startedAt?: string } {
  let t = name.trim();
  for (let i = 0; i < 2; i++) t = t.replace(SUFFIX_RX, "").replace(PREFIX_RX, "").trim();
  let startedAt: string | undefined;
  const m = t.match(STAMP_RX);
  if (m) {
    const [, y, mo, d, h, mi, tz] = m;
    const off = tz ? TZ_OFFSET_H[tz] : undefined;
    if (off !== undefined) {
      const ms = Date.UTC(+y, +mo - 1, +d, +h - off, +mi);
      if (Number.isFinite(ms)) startedAt = new Date(ms).toISOString();
    }
    t = t.slice(0, m.index).trim();
  }
  return { title: t || name.trim(), startedAt };
}

/** "Weekly sync - Notes by Gemini" → "Weekly sync". Pure — tested. */
export function meetTitle(name: string): string {
  return parseMeetName(name).title;
}

/** FRIDAY's exact name query plus the modifiedTime bound. */
export function meetDriveQuery(sinceISO: string): string {
  return `(name contains 'Transcript' or name contains 'Notes by Gemini' or name contains 'Meeting notes')`
    + ` and mimeType = '${DOC_MIME}' and modifiedTime > '${sinceISO}' and trashed = false`;
}

export interface MeetNoteMeta { id: string; name: string; title: string; createdTime: string; startedAt?: string; modifiedTime?: string; webViewLink?: string }

/** Candidate Meet/Gemini docs modified since `sinceISO` and at least 90 minutes old, oldest first. */
export async function listRecentMeetNotes(sinceISO: string, opts: { max?: number; now?: Date } = {}): Promise<MeetNoteMeta[]> {
  if (process.env.CLARA_MEET_API?.trim().toLowerCase() === "on") {
    console.log("[clara/meetings] CLARA_MEET_API=on but the Meet API branch is not enabled — using the Drive docs path");
  }
  const now = (opts.now ?? new Date()).getTime();
  const files: DriveFile[] = await listDriveByQuery(meetDriveQuery(sinceISO), { max: opts.max ?? 50 });
  return files
    .filter((f) => f.mimeType === DOC_MIME && !f.trashed)
    .map((f) => { const p = parseMeetName(f.name); return { id: f.id, name: f.name, title: p.title, startedAt: p.startedAt, createdTime: f.createdTime ?? f.modifiedTime ?? "", modifiedTime: f.modifiedTime, webViewLink: f.webViewLink }; })
    .filter((f) => f.createdTime && now - new Date(f.createdTime).getTime() >= MIN_AGE_MS)
    .sort((a, b) => a.createdTime.localeCompare(b.createdTime));
}

/** Read one Meet/Gemini doc into a MeetingRecord. Null when the doc is empty or unreadable. */
export async function getMeetNote(fileId: string, meta?: Partial<MeetNoteMeta>): Promise<MeetingRecord | null> {
  const r = await readAsText(fileId, { maxChars: MAX_CHARS });
  if (!r.ok || !r.text.trim()) return null;
  const { getFile } = await import("../ms-files");
  const f = meta?.createdTime ? null : await getFile(fileId).catch(() => null);
  const name = meta?.name ?? f?.name ?? "Meeting";
  return {
    source: "meet",
    sourceId: fileId,
    title: meta?.title ?? meetTitle(name),
    attendees: [],
    // Scheduled start from the doc name beats createdTime (written after the call began).
    startedAt: meta?.startedAt ?? parseMeetName(name).startedAt ?? meta?.createdTime ?? f?.createdTime ?? f?.modifiedTime ?? new Date().toISOString(),
    transcript: r.text,
    shareLink: meta?.webViewLink ?? f?.webViewLink,
  };
}
