// Clara — chat message log. Mirrors FRIDAY's store.messages (append-only messages.jsonl) so the
// /chat page can actually reload past conversation instead of starting empty every time — FRIDAY
// persists this too, but its own /friday page never reads it back; Clara's does.
//
// Lives in dataDir (operational state, like outbound-queue.json/notify-queue.json), not the vault —
// this is a rolling conversational log, not a document the owner would browse in Obsidian.

import { promises as fs } from "node:fs";
import path from "node:path";
import { loadConfig } from "./config";

export interface StoredMessage {
  id: string;
  ts: string;
  role: "user" | "clara";
  text: string;
  /** Vault memory hits (memory-RAG) that informed this reply, when any cleared the gate. */
  citations?: { relPath: string; score: number }[];
  /** Which surface this turn happened on. Absent = web /chat (the original, only writer). */
  channel?: "web" | "sms" | "voice" | "email";
  /** Sender's phone number or email address, non-web channels only — lets a specific thread be
   *  reconstructed without bleeding another principal's (or a stranger's) conversation into
   *  someone else's context. */
  from?: string;
  /** Whether this turn belongs to a resolved principal (the owner), as opposed to a client or
   *  stranger. Absent means principal — true for every pre-existing row and for web /chat, which
   *  was principal-only before any other channel could write here. Explicit `false` is what keeps
   *  client/stranger content out of the cross-session recall index (recall.ts) that the owner's own
   *  "what did we discuss" search draws from. */
  principal?: boolean;
  /** Tool names that ran on this turn (router path); a trailing "!" marks a failed call. Lets the
   *  cross-channel history summarise what actually happened instead of replaying prose. */
  tools?: string[];
  /** "asked" = Clara put a decision question to the owner; "decided" = they answered one. Absent =
   *  an ordinary conversational turn. Keeps the ask/answer trail inside the one owner thread. */
  kind?: "turn" | "asked" | "decided";
}

async function file(): Promise<string> {
  const cfg = await loadConfig();
  await fs.mkdir(cfg.dataDir, { recursive: true });
  return path.join(cfg.dataDir, "messages.jsonl");
}

export async function appendMessage(
  role: StoredMessage["role"],
  text: string,
  citations?: StoredMessage["citations"],
  channelInfo?: { channel: StoredMessage["channel"]; from?: string; principal?: boolean },
  extra?: { tools?: string[]; kind?: StoredMessage["kind"] },
): Promise<StoredMessage> {
  const row: StoredMessage = {
    id: crypto.randomUUID(), ts: new Date().toISOString(), role, text,
    ...(citations?.length ? { citations } : {}),
    ...(channelInfo?.channel ? { channel: channelInfo.channel } : {}),
    ...(channelInfo?.from ? { from: channelInfo.from } : {}),
    ...(channelInfo?.principal === false ? { principal: false } : {}),
    ...(extra?.tools?.length ? { tools: extra.tools } : {}),
    ...(extra?.kind && extra.kind !== "turn" ? { kind: extra.kind } : {}),
  };
  await fs.appendFile(await file(), JSON.stringify(row) + "\n", "utf8");
  // Mirror into the cross-session recall index (recall.ts) — fire-and-forget, never blocks the
  // reply, and the recall side dedupes so a later JSONL backfill can't double this row.
  void import("./recall").then((r) => r.recordRecall(row)).catch(() => {});
  return row;
}

export async function recentMessages(limit = 40): Promise<StoredMessage[]> {
  try {
    const raw = await fs.readFile(await file(), "utf8");
    const rows = raw.split("\n").filter(Boolean).map((line) => JSON.parse(line) as StoredMessage);
    return rows.slice(-limit);
  } catch {
    return [];
  }
}

/** Recent turns on ONE phone-number thread (SMS/voice) — the short-term memory a stateless
 *  webhook needs to reconstruct itself every call, scoped so one sender's history never leaks
 *  into another's reply. Reads the tail of the whole log rather than filtering the full file,
 *  same "good enough for single-owner scale" tradeoff recentMessages already makes. */
export async function recentMessagesFor(
  channel: "sms" | "voice" | "email",
  from: string,
  limit = 10,
  scanWindow = 200,
): Promise<StoredMessage[]> {
  const all = await recentMessages(scanWindow);
  return all.filter((m) => m.channel === channel && m.from === from).slice(-limit);
}

/** Pure filter behind recentOwnerMessages — exported for tests. Rows without `channel` are web. */
export function filterOwnerRows(
  rows: StoredMessage[],
  opts: { hours?: number; limit?: number } = {},
  now: number = Date.now(),
): StoredMessage[] {
  const hours = opts.hours ?? 24;
  const cutoff = now - hours * 60 * 60 * 1000;
  const kept = rows.filter((m) => m.principal !== false && new Date(m.ts).getTime() >= cutoff);
  return kept.slice(-(opts.limit ?? 40));
}

/** The owner's recent turns across EVERY channel (web, SMS, voice, email) — the shared memory that
 *  lets "what did I text you an hour ago" be answered from the desk, and a decision Clara asked on
 *  the phone be answered by SMS. Strangers and clients (`principal: false`) never appear here; they
 *  keep their per-number threads (recentMessagesFor). `file` is a test seam. */
export async function recentOwnerMessages(
  opts: { hours?: number; limit?: number; scanWindow?: number; file?: string } = {},
): Promise<StoredMessage[]> {
  let all: StoredMessage[] = [];
  try {
    const raw = await fs.readFile(opts.file ?? (await file()), "utf8");
    all = raw.split("\n").filter(Boolean).flatMap((line) => { try { return [JSON.parse(line) as StoredMessage]; } catch { return []; } })
      .slice(-(opts.scanWindow ?? 400));
  } catch {
    return [];
  }
  return filterOwnerRows(all, opts);
}
