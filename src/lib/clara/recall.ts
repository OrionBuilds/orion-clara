// Clara — cross-session recall. The chat log (messages.jsonl) already remembers everything; this
// makes it FINDABLE. A per-agent SQLite store (agent-core/sessionstore, ported from Hermes
// Agent's FTS5 design) indexes every message as it lands, and the recall_sessions intent tool
// searches it — "what did we decide about the boat insurance" now has a real answer months later.
//
// Lives in dataDir next to messages.jsonl itself (operational state, not the vault). Clara's db
// is hers alone — FRIDAY keeps its own under its own data dir, because a
// shared-write db across agent processes is exactly the contention the per-agent split
// avoids (and recall must never leak across agents' memories anyway).

import path from "node:path";
import {
  openSessionStore, formatRecallMatches,
  type SessionStore, type RecallMatch,
} from "@autom8ionlab/agent-core";
import { loadConfig } from "./config";
import type { StoredMessage } from "./messages";

const AGENT = "clara";

let storePromise: Promise<SessionStore | null> | null = null;

// Open once per process; the first open also backfills messages.jsonl. Backfill is cheap to
// repeat — the store tracks a byte offset per file, so after the true first run it's a stat plus
// whatever tail appended since (and content-hash dedupe catches anything the offset misses).
async function open(): Promise<SessionStore | null> {
  if (!storePromise) {
    storePromise = (async () => {
      try {
        const cfg = await loadConfig();
        const store = await openSessionStore(path.join(cfg.dataDir, "recall.db"));
        await store.indexJsonl(path.join(cfg.dataDir, "messages.jsonl"), { agent: AGENT }).catch(() => {});
        return store;
      } catch {
        return null; // recall is an enhancement — a broken db must never take chat down
      }
    })();
  }
  return storePromise;
}

/** Mirror one just-persisted chat row into the recall index. Best-effort by contract: called
 *  from appendMessage's hot path, so it must never throw and never block a reply on recall.
 *
 *  Skips rows explicitly marked `principal: false` — a client or stranger's SMS/email turn must
 *  never land in the index the `recall_sessions` tool searches, since that tool is invoked
 *  principal-only and exists to answer "what did WE discuss", not to surface a client's
 *  conversation back to the owner. Absent `principal` means true (every pre-existing row and web
 *  /chat, which was principal-only before other channels could write here at all). */
export async function recordRecall(row: Pick<StoredMessage, "ts" | "role" | "text" | "principal">): Promise<void> {
  if (row.principal === false) return;
  try {
    const store = await open();
    // Same fields the JSONL row carries → same dedupe hash a later backfill would compute.
    store?.record({ agent: AGENT, role: row.role, content: row.text, at: row.ts });
  } catch {
    /* never surface */
  }
}

/** Search past sessions, formatted for the model: "[date · title] (role) snippet" per hit. */
export async function searchRecall(query: string, limit = 8): Promise<string> {
  const store = await open();
  if (!store) return "Recall store unavailable.";
  let hits: RecallMatch[];
  try {
    hits = store.search({ query, agent: AGENT, limit });
  } catch {
    return "Recall store unavailable.";
  }
  return formatRecallMatches(hits);
}
