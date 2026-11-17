// Clara — the owner's morning-call session, persisted per call.
//
// The business-call store (call-sessions.ts) is in-memory because a vendor call lasting minutes can
// tolerate losing its turn history on a restart. The morning call is different: it is the one call
// a day the owner actually takes, it carries decisions they made by voice, and its recap email is
// built from the transcript. So every session lives on disk (dataDir/owner-calls/<id>.json, tmp+rename)
// with a Map in front of it, and a webhook that lands after a restart rehydrates from the file.
//
// One session per calendar day (plus dry runs, which never count as "today's call").

import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { loadConfig } from "./config";

export type OwnerCallPurpose = "morning-brief" | "dry-run";
export type OwnerCallStatus = "placing" | "ringing" | "in-progress" | "voicemail" | "no-answer" | "ended" | "failed";

export interface OwnerCallTurn { role: "user" | "clara"; text: string; at: string }

export interface OwnerCallSession {
  sessionId: string;
  date: string;                 // YYYY-MM-DD local
  purpose: OwnerCallPurpose;
  to: string;                   // E.164, derived from config — never from a request
  callSid?: string;
  attempt: 1 | 2;
  status: OwnerCallStatus;
  script: string[];             // spoken chunks, ≤700 chars each
  briefSummary: string;         // one line: "2 meetings, 1 decision"
  counts: { meetings: number; decisions: number; emails: number };
  turns: OwnerCallTurn[];
  pendingResults: string[];     // deferred tool results that finished after the turn was spoken
  tasksCreated: string[];
  approvalsDecided: string[];
  silenceCount: number;
  turnCount: number;
  retryAt?: string;
  startedAt: string;
  updatedAt: string;
  finalized?: boolean;
  endReason?: string;
}

const GLOBAL_KEY = "__clara_owner_call_sessions__";
function cache(): Map<string, OwnerCallSession> {
  const g = globalThis as unknown as Record<string, Map<string, OwnerCallSession> | undefined>;
  if (!g[GLOBAL_KEY]) g[GLOBAL_KEY] = new Map();
  return g[GLOBAL_KEY]!;
}

/** Test seam: CLARA_OWNER_CALLS_DIR overrides dataDir/owner-calls. */
export async function ownerCallsDir(): Promise<string> {
  const override = process.env.CLARA_OWNER_CALLS_DIR?.trim();
  const dir = override || path.join((await loadConfig()).dataDir, "owner-calls");
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

const SAFE_ID = /^[a-f0-9-]{8,64}$/i;

async function fileFor(sessionId: string): Promise<string> {
  if (!SAFE_ID.test(sessionId)) throw new Error("bad session id");
  return path.join(await ownerCallsDir(), `${sessionId}.json`);
}

export async function saveOwnerSession(s: OwnerCallSession): Promise<void> {
  s.updatedAt = new Date().toISOString();
  cache().set(s.sessionId, s);
  const p = await fileFor(s.sessionId);
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(s, null, 2), "utf8");
  await fs.rename(tmp, p);
}

export async function createOwnerSession(init: {
  date: string; purpose: OwnerCallPurpose; to: string; script: string[]; briefSummary: string;
  counts: OwnerCallSession["counts"]; attempt?: 1 | 2;
}): Promise<OwnerCallSession> {
  const now = new Date().toISOString();
  const s: OwnerCallSession = {
    sessionId: crypto.randomUUID(),
    date: init.date, purpose: init.purpose, to: init.to,
    attempt: init.attempt ?? 1, status: "placing",
    script: init.script, briefSummary: init.briefSummary, counts: init.counts,
    turns: [], pendingResults: [], tasksCreated: [], approvalsDecided: [],
    silenceCount: 0, turnCount: 0, startedAt: now, updatedAt: now,
  };
  await saveOwnerSession(s);
  return s;
}

export async function getOwnerSession(sessionId: string): Promise<OwnerCallSession | null> {
  const hit = cache().get(sessionId);
  if (hit) return hit;
  try {
    const s = JSON.parse(await fs.readFile(await fileFor(sessionId), "utf8")) as OwnerCallSession;
    cache().set(sessionId, s);
    return s;
  } catch { return null; }
}

export async function appendOwnerTurn(sessionId: string, turn: Omit<OwnerCallTurn, "at">): Promise<OwnerCallSession | null> {
  const s = await getOwnerSession(sessionId);
  if (!s) return null;
  s.turns.push({ ...turn, at: new Date().toISOString() });
  if (turn.role === "user") s.turnCount += 1;
  await saveOwnerSession(s);
  return s;
}

/**
 * Claim the right to finalize exactly once. The hangup branch of the webhook and Twilio's
 * end-of-call status callback both want to, and they race (same shape as claimInboundFinalize).
 */
export async function claimOwnerFinalize(sessionId: string, reason: string): Promise<OwnerCallSession | null> {
  const s = await getOwnerSession(sessionId);
  if (!s || s.finalized) return null;
  s.finalized = true;
  s.endReason = reason;
  await saveOwnerSession(s);
  return s;
}

/** The real (non-dry-run) session for a date, newest first, if any. */
export async function todaysSession(date: string): Promise<OwnerCallSession | null> {
  const dir = await ownerCallsDir();
  let names: string[] = [];
  try { names = (await fs.readdir(dir)).filter((n) => n.endsWith(".json")); } catch { return null; }
  let best: OwnerCallSession | null = null;
  for (const n of names) {
    try {
      const s = JSON.parse(await fs.readFile(path.join(dir, n), "utf8")) as OwnerCallSession;
      if (s.date !== date || s.purpose !== "morning-brief") continue;
      if (!best || s.startedAt > best.startedAt) best = s;
    } catch { /* skip unreadable */ }
  }
  if (best) cache().set(best.sessionId, best);
  return best;
}

/** Sessions older than `days` are deleted; the recap email and ledger are the durable record. */
export async function pruneOwnerSessions(days = 14): Promise<number> {
  const dir = await ownerCallsDir();
  const cutoff = Date.now() - days * 24 * 60 * 60_000;
  let removed = 0;
  let names: string[] = [];
  try { names = await fs.readdir(dir); } catch { return 0; }
  for (const n of names) {
    const p = path.join(dir, n);
    try {
      const st = await fs.stat(p);
      if (st.mtimeMs < cutoff) { await fs.unlink(p); removed++; }
    } catch { /* ignore */ }
  }
  return removed;
}
