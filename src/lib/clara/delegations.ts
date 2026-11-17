// Delegations — the record of every piece of work CLARA handed to FRIDAY.
//
// Before this (2026-09-14) a hand-off was a ledger line and nothing else: CLARA could not say what
// was outstanding, and she never learned when a bench finished — so a client who emailed in got a
// draft acknowledgement and then silence. Each row here is one hand-off with the receipt the bench
// returned (task ids / run id), who the work is for, and where it came from, so delegationWatch.ts
// can poll the bench and close the loop with the client and with the owner.
//
// Store: dataDir/delegations.json, tmp+rename like the other dataDir stores. The transition logic is
// pure (applyTransition) and unit-tested; the file I/O is the thin part.

import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { loadConfig } from "./config";
import type { BenchState } from "./delegationStatus";

export type Bench = "friday";
export type DelegationStatus = "open" | "done" | "parked" | "failed" | "stale" | "closed";

export interface DelegationClient { contactId?: string; email?: string; name: string }
export interface DelegationSource {
  kind: "email" | "ticket" | "sms" | "chat" | "voice" | "meeting";
  /** The originating id — Gmail message id, ticket id, Twilio MessageSid, … */
  ref: string;
  threadId?: string;
  messageId?: string;
  subject?: string;
  ticketId?: string;
}

export interface Delegation {
  id: string;
  bench: Bench;
  /** What the bench actually queued — its receipt. Empty is legal (see routing.ts DispatchResult). */
  benchTaskIds: string[];
  runId?: string;
  client?: DelegationClient;
  source: DelegationSource;
  /** Sanitized one-liner in CLARA's words — never the raw client text. */
  summary: string;
  status: DelegationStatus;
  createdAt: string;
  lastPolledAt?: string;
  /** Transitions already announced (client update / the owner notify) so each fires once. */
  notified: string[];
  /** Where to deliver the result when the owner personally asked (receipts, 2026-09-24): the channel
   *  they used and, for sms/email, the address. Absent on client-originated hand-offs. */
  replyTo?: { channel: "sms" | "voice" | "chat" | "email"; from?: string };
  /** Who asked — the owner (result goes straight back to them) or Clara acting on a client's behalf. */
  askedBy?: "owner" | "clara";
}

/** What a caller supplies when it hands work over; the receipt fields are filled from the dispatch. */
export type DelegationRecord = Pick<Delegation, "client" | "source" | "summary"> & Partial<Pick<Delegation, "replyTo" | "askedBy">>;

/** A hand-off with no receipt that is still "open" after this long is stale — nobody is working it. */
export const STALE_AFTER_MS = 6 * 60 * 60_000;
export const PRUNE_AFTER_MS = 14 * 24 * 60 * 60_000;
/** Stale hand-offs (nobody ever picked them up) are noise in "did FRIDAY finish that?" answers and the
 *  brief, so they go after 48 hours; done/failed/closed rows keep the 14-day history. Owner rule 2026-09-25. */
export const STALE_PRUNE_AFTER_MS = 48 * 60 * 60_000;
const TERMINAL: ReadonlySet<DelegationStatus> = new Set(["done", "failed", "stale", "closed"]);

// ── Pure ──────────────────────────────────────────────────────────────────────────────────────

export function newDelegation(
  rec: DelegationRecord,
  bench: Bench,
  receipt: { taskIds?: string[]; runId?: string },
  now = new Date().toISOString(),
): Delegation {
  return {
    id: crypto.randomUUID(), bench, benchTaskIds: receipt.taskIds ?? [], runId: receipt.runId,
    client: rec.client, source: rec.source, summary: rec.summary.slice(0, 300),
    status: "open", createdAt: now, notified: [],
    ...(rec.replyTo ? { replyTo: rec.replyTo } : {}),
    ...(rec.askedBy ? { askedBy: rec.askedBy } : {}),
  };
}

/**
 * Fold a bench poll into the row. Returns the updated row and the ONE transition to announce (or
 * null). A transition is announced once, ever — `notified` is the memory of that.
 */
export function applyTransition(
  row: Delegation,
  state: BenchState,
  now = new Date().toISOString(),
): { row: Delegation; notify: "done" | "parked" | "failed" | "stale" | null } {
  const next: Delegation = { ...row, lastPolledAt: now };
  if (TERMINAL.has(row.status) && row.status !== "stale") return { row: next, notify: null };

  let target: DelegationStatus | null = null;
  if (state === "done" || state === "parked" || state === "failed") target = state;
  else if (state === "pending" && !row.benchTaskIds.length && !row.runId && Date.parse(now) - Date.parse(row.createdAt) > STALE_AFTER_MS) target = "stale";
  // A parked row that later runs to completion still goes "done"; a stale row that finally reports
  // a receipt is handled by the caller re-recording it.
  if (!target || target === row.status) return { row: next, notify: null };

  next.status = target;
  if (next.notified.includes(target)) return { row: next, notify: null };
  next.notified = [...next.notified, target];
  return { row: next, notify: target };
}

export function pruneRows(rows: Delegation[], now = Date.now()): Delegation[] {
  return rows.filter((r) => {
    if (!TERMINAL.has(r.status)) return true;
    const age = now - Date.parse(r.lastPolledAt ?? r.createdAt);
    return age <= (r.status === "stale" ? STALE_PRUNE_AFTER_MS : PRUNE_AFTER_MS);
  });
}

// ── Store ─────────────────────────────────────────────────────────────────────────────────────

async function file(): Promise<string> {
  const cfg = await loadConfig();
  await fs.mkdir(cfg.dataDir, { recursive: true });
  return path.join(cfg.dataDir, "delegations.json");
}

export async function readAll(): Promise<Delegation[]> {
  try {
    const rows = JSON.parse(await fs.readFile(await file(), "utf8")) as Delegation[];
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

async function writeAll(rows: Delegation[]): Promise<void> {
  const p = await file();
  const tmp = `${p}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(rows, null, 2), "utf8");
  await fs.rename(tmp, p);
}

export async function listOpen(): Promise<Delegation[]> {
  return (await readAll()).filter((r) => r.status === "open" || r.status === "parked");
}

export async function upsert(row: Delegation): Promise<void> {
  const rows = await readAll();
  const i = rows.findIndex((r) => r.id === row.id);
  if (i >= 0) rows[i] = row; else rows.push(row);
  await writeAll(rows);
}

/** Record a fresh hand-off. Returns the row so callers can quote its id. */
export async function record(rec: DelegationRecord, bench: Bench, receipt: { taskIds?: string[]; runId?: string }): Promise<Delegation> {
  const row = newDelegation(rec, bench, receipt);
  await upsert(row);
  // Vault memory: every hand-off is a thread Clara (and the owner) can read back later.
  const { recordOutcome } = await import("./vaultMemory");
  await recordOutcome({
    thread: `delegation-${row.id.slice(0, 8)}`, kind: "delegation", status: "open",
    title: `Handed to ${bench.toUpperCase()}: ${row.summary}`, subject: row.client?.name,
    done: `Handed to ${bench.toUpperCase()} (${row.source.kind}${row.askedBy === "owner" ? ", owner's ask" : ""})${row.benchTaskIds.length ? `; queued as ${row.benchTaskIds.join(", ")}` : "; no task id returned yet"}.`,
    next: `Wait for ${bench.toUpperCase()}'s result; delegation-watch polls every 5 minutes.`,
  }).catch(() => {});
  return row;
}

export async function prune(): Promise<number> {
  const rows = await readAll();
  const kept = pruneRows(rows);
  if (kept.length !== rows.length) await writeAll(kept);
  return rows.length - kept.length;
}
