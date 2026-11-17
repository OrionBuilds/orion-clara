// Clara — thread reads for the read_thread intent tool.
//
// Two thread stores exist and the tool exposes both, because "pull up that conversation" means a
// different store depending on who was talking:
//
//   · the owner ↔ Clara — the append-only chat log, dataDir/messages.jsonl (messages.ts owns writes).
//     recall_sessions already SEARCHES it (FTS over recall.db); this is the missing READ — a whole
//     day's thread in order, which search snippets can't give. Read here directly from the jsonl
//     (same parse recentMessages uses) rather than importing messages.ts, so this file stays
//     additive while other work is in flight elsewhere in the lib.
//   · Client ↔ the business — OS CRM conversations (email/sms/phone channels Clara owns at the
//     front desk). Those reads go through osClient's conversations_get/conversations_list, already
//     on her allowlist; the formatting for both lives in intent.ts's read_thread run().
//
// NOT exposed: FRIDAY's message stores (recall must never leak across agents' memories —
// recall.ts says so) and the OS assistant_threads family (that's the OS web-widget's own chat
// surface, duplicate of what messages.jsonl already holds for the real Clara).

import { promises as fs } from "node:fs";
import path from "node:path";
import { loadConfig } from "./config";
import { OWNER_FIRST } from "./owner";
import type { StoredMessage } from "./messages";

/** One day of the owner↔Clara chat, in order. `date` is YYYY-MM-DD (local ISO date prefix match). */
export async function readOwnThread(date: string, limit = 200): Promise<StoredMessage[]> {
  const cfg = await loadConfig();
  let raw: string;
  try {
    raw = await fs.readFile(path.join(cfg.dataDir, "messages.jsonl"), "utf8");
  } catch {
    return [];
  }
  const rows: StoredMessage[] = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    try {
      const row = JSON.parse(line) as StoredMessage;
      if (row.ts?.startsWith(date)) rows.push(row);
    } catch {
      /* one bad line must not lose the day */
    }
  }
  return rows.slice(-limit);
}

/** Format a day's thread for a chat/SMS reply. */
export function formatOwnThread(date: string, rows: StoredMessage[]): string {
  if (!rows.length) return `No conversation logged on ${date}.`;
  const lines = rows.map((r) => {
    const hhmm = r.ts.slice(11, 16) || "??:??";
    const who = r.role === "user" ? OWNER_FIRST : "Clara";
    return `[${hhmm}] ${who}: ${r.text.replace(/\s+/g, " ").slice(0, 240)}`;
  });
  return `Thread with ${OWNER_FIRST}, ${date} (${rows.length} message${rows.length === 1 ? "" : "s"}):\n${lines.join("\n")}`;
}
