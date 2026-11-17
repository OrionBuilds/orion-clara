// Clara — meeting ingestion loop: Wispr Flow first, Google Meet/Gemini docs as the fallback,
// Clara's own phone calls through the same digest.
//
// Gate: CLARA_MEETING_INGEST = off | shadow | active (default shadow). Shadow digests and writes
// the vault note + a "SHADOW:" notice but files/dispatches nothing — flip to active once the notes
// look right. Each run is capped so one tick can't sit on the model for an hour; the Wispr cursor
// only advances past meetings actually handled, so a capped or failed run resumes where it stopped.

import { append as ledgerAppend } from "../ledger";
import { digestMeeting } from "./digest";
import { fileAndDispatch, renderNote, resolveItems, type FileResult } from "./file";
import { getMeetNote, listRecentMeetNotes } from "./meet";
import { loadRoster } from "./resolve";
import { fuzzyKey, isDuplicate, loadSeen, markSeen, sourceKey } from "./seen";
import { getMeeting, listRecentMeetings, readSession, recordPoll, wisprConfigured, wisprConnected } from "./wispr";
import type { IngestMode, MeetingDigest, MeetingRecord } from "./types";

export function meetingIngestMode(): IngestMode {
  const v = process.env.CLARA_MEETING_INGEST?.trim().toLowerCase();
  return v === "off" || v === "active" ? v : "shadow";
}

const WISPR_OVERLAP_MS = 5 * 60_000;
const FIRST_RUN_LOOKBACK_MS = 24 * 3_600_000;
const MEET_WINDOW_MS = 72 * 3_600_000;
const MAX_DIGESTS_PER_RUN = 6;

export type IngestStatus = "digested" | "duplicate" | "empty" | "digest-failed" | "error" | "ignored";

export interface IngestOutcome {
  sourceKey: string;
  title: string;
  status: IngestStatus;
  mode: IngestMode;
  dryRun?: boolean;
  digest?: MeetingDigest;
  /** dryRun only: the note that WOULD be written. */
  notePreview?: string;
  result?: FileResult;
  error?: string;
}

/**
 * Digest one record and act on it per mode. `mode` defaults to the env gate; "off" is honoured by
 * the scheduler, not here — an explicit call (route, phone call) in off mode runs as shadow.
 */
// Meetings the owner told CLARA to leave alone (e.g. a side venture's standups, trainings, demos).
// Checked BEFORE the digest so nothing is filed, dispatched or even summarised; the meeting
// is marked seen so it isn't re-evaluated every poll. CLARA_MEETING_IGNORE overrides the keyword
// list (comma-separated, case-insensitive); unset or "" means nothing is ignored.
const DEFAULT_IGNORE = "";
export function ignoreKeywords(): string[] {
  const raw = process.env.CLARA_MEETING_IGNORE ?? DEFAULT_IGNORE;
  return raw.split(",").map((k) => k.trim().toLowerCase()).filter(Boolean);
}
/** Pure — tested. Reason string when the meeting should be ignored, else null. */
export function ignoredReason(
  rec: Pick<MeetingRecord, "title" | "attendeeEmails" | "transcript" | "summary">,
  keywords: string[] = ignoreKeywords(),
): string | null {
  if (!keywords.length) return null;
  const title = (rec.title ?? "").toLowerCase();
  const hitTitle = keywords.find((k) => title.includes(k));
  if (hitTitle) return `title mentions "${hitTitle}"`;
  const squash = (k: string) => k.replace(/\s+/g, "");
  const domainHit = (rec.attendeeEmails ?? []).find((e) => keywords.some((k) => (e.split("@")[1] ?? "").toLowerCase().includes(squash(k))));
  if (domainHit) return `attendee on ${domainHit.split("@")[1]}`;
  const body = `${rec.summary ?? ""}\n${rec.transcript ?? ""}`.toLowerCase();
  for (const k of keywords) {
    const n = body.split(k).length - 1;
    if (n >= 3) return `transcript mentions "${k}" ${n}×`;
  }
  return null;
}

export async function ingestRecord(
  rec: MeetingRecord,
  opts: { dryRun?: boolean; force?: boolean; mode?: IngestMode } = {},
): Promise<IngestOutcome> {
  const envMode = opts.mode ?? meetingIngestMode();
  const mode: IngestMode = envMode === "active" ? "active" : "shadow";
  const sk = sourceKey(rec);
  const base = { sourceKey: sk, title: rec.title, mode, dryRun: opts.dryRun || undefined };

  if (!opts.force && !opts.dryRun && isDuplicate(rec, (await loadSeen()).entries)) return { ...base, status: "duplicate" };
  if (!rec.transcript.trim()) return { ...base, status: "empty" };

  const ignored = ignoredReason(rec);
  if (ignored) {
    if (!opts.dryRun) {
      await markSeen({ sourceKey: sk, fuzzyKey: fuzzyKey(rec), startedAt: rec.startedAt, source: rec.source, notePath: "" });
      await ledgerAppend({ kind: "action", actor: "clara", what: `meeting ignored: "${rec.title.slice(0, 80)}" — ${ignored}`, ref: sk }).catch(() => {});
    }
    return { ...base, status: "ignored", error: ignored };
  }

  try {
    const roster = await loadRoster();
    const digest = await digestMeeting(rec, roster);
    if (!digest) return { ...base, status: "digest-failed", error: "model returned no usable digest" };

    if (opts.dryRun) {
      const items = resolveItems(rec, digest, roster);
      return { ...base, status: "digested", digest, notePreview: renderNote(rec, digest, items, { mode: "shadow", sourceKey: sk }) };
    }

    const result = await fileAndDispatch(rec, digest, mode, roster);
    await markSeen({ sourceKey: sk, fuzzyKey: fuzzyKey(rec), startedAt: rec.startedAt, source: rec.source, notePath: result.notePath });
    await ledgerAppend({
      kind: "action", actor: "clara",
      what: `meeting digested (${mode}): "${rec.title.slice(0, 80)}" — ${digest.items.length} items`,
      ref: sk,
      meta: { notePath: result.notePath, dispatches: result.dispatches.map((d) => `${d.agent}:${d.ok ? "ok" : d.indeterminate ? "indeterminate" : "failed"}`) },
    }).catch(() => {});
    return { ...base, status: "digested", digest, result };
  } catch (e) {
    return { ...base, status: "error", error: String((e as Error).message ?? e).slice(0, 300) };
  }
}

export interface IngestRunReport {
  mode: IngestMode;
  skipped?: string;
  wispr: { ran: boolean; listed: number; outcomes: IngestOutcome[]; error?: string; cursor?: string };
  meet: { ran: boolean; listed: number; outcomes: IngestOutcome[]; error?: string };
}

const g = globalThis as unknown as { __claraMeetingIngestRunning?: boolean };

export async function runMeetingIngest(now: Date = new Date()): Promise<IngestRunReport> {
  const mode = meetingIngestMode();
  const report: IngestRunReport = { mode, wispr: { ran: false, listed: 0, outcomes: [] }, meet: { ran: false, listed: 0, outcomes: [] } };
  if (mode === "off") return { ...report, skipped: "CLARA_MEETING_INGEST=off" };
  if (g.__claraMeetingIngestRunning) return { ...report, skipped: "previous run still in progress" };
  g.__claraMeetingIngestRunning = true;
  let budget = MAX_DIGESTS_PER_RUN;

  try {
    // ── Wispr ──
    if (wisprConfigured() && (await wisprConnected())) {
      report.wispr.ran = true;
      const cursor = (await readSession()).cursorModifiedAt;
      const since = new Date(cursor ? new Date(cursor).getTime() - WISPR_OVERLAP_MS : now.getTime() - FIRST_RUN_LOOKBACK_MS).toISOString();
      try {
        const metas = (await listRecentMeetings(since))
          .sort((a, b) => (a.modified_at ?? a.start).localeCompare(b.modified_at ?? b.start));
        report.wispr.listed = metas.length;
        let newCursor = cursor;
        let blocked = false; // once something is left unhandled, stop moving the cursor
        for (const m of metas) {
          const seen = (await loadSeen()).entries;
          const probe: MeetingRecord = { source: "wispr", sourceId: m.id, title: m.title ?? "", attendees: m.attendees ?? [], startedAt: m.start, transcript: "" };
          if (isDuplicate(probe, seen)) {
            if (!blocked) newCursor = maxIso(newCursor, m.modified_at);
            continue;
          }
          if (budget <= 0) { blocked = true; break; }
          budget--;
          let out: IngestOutcome;
          try {
            out = await ingestRecord(await getMeeting(m.id, m), { mode });
          } catch (e) {
            out = { sourceKey: `wispr:${m.id}`, title: m.title, mode, status: "error", error: String((e as Error).message ?? e).slice(0, 300) };
          }
          report.wispr.outcomes.push(out);
          if (out.status === "error" || out.status === "digest-failed") blocked = true;
          else if (!blocked) newCursor = maxIso(newCursor, m.modified_at);
        }
        report.wispr.cursor = newCursor;
        await recordPoll({ ok: true, cursorModifiedAt: newCursor });
      } catch (e) {
        report.wispr.error = String((e as Error).message ?? e).slice(0, 300);
        await recordPoll({ ok: false, error: report.wispr.error }).catch(() => {});
      }
    }

    // ── Google Meet / Gemini docs (fallback; dedupes against Wispr by fuzzy key) ──
    if (budget > 0) {
      try {
        const notes = await listRecentMeetNotes(new Date(now.getTime() - MEET_WINDOW_MS).toISOString(), { now });
        report.meet.ran = true;
        report.meet.listed = notes.length;
        for (const n of notes) {
          const probe: MeetingRecord = { source: "meet", sourceId: n.id, title: n.title, attendees: [], startedAt: n.createdTime, transcript: "" };
          if (isDuplicate(probe, (await loadSeen()).entries)) continue;
          if (budget-- <= 0) break;
          const rec = await getMeetNote(n.id, n).catch(() => null);
          if (!rec) {
            report.meet.outcomes.push({ sourceKey: `meet:${n.id}`, title: n.title, mode, status: "empty" });
            continue;
          }
          report.meet.outcomes.push(await ingestRecord(rec, { mode }));
        }
      } catch (e) {
        // Most commonly: Google work account not connected. Not an alert — Wispr is primary.
        report.meet.error = String((e as Error).message ?? e).slice(0, 300);
      }
    }
  } finally {
    g.__claraMeetingIngestRunning = false;
  }
  return report;
}

function maxIso(a: string | undefined, b: string | undefined): string | undefined {
  if (!b) return a;
  if (!a) return b;
  return new Date(b).getTime() > new Date(a).getTime() ? b : a;
}
