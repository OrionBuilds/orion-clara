// Clara — the record of every call and text on the owner's work line. 
//
// Two homes, two jobs:
//   * <dataDir>/workline-log.jsonl — the machine list the morning brief reads for "Calls & texts":
//     who called or texted, what they needed, what Clara did, and whether the owner owes a callback.
//   * Clara's vault memory (vaultMemory.ts) — one thread per contact per day, cross-linked under the
//     contact's people note, so the next time they call she already knows the history.
//
// Nothing here throws: a failed log line must never cost the caller their reply.

import { promises as fs } from "node:fs";
import path from "node:path";
import { loadConfig } from "./config";

export interface WorkLineEntry {
  at: string;                    // ISO
  channel: "call" | "text";
  from: string;                  // their number (or iMessage handle)
  who: string;                   // plain label: "Jackson (Acme Co)" or the number
  need?: string;                 // what they needed, in their words
  did: string;                   // what Clara did: "took a message", "put him through", "booked Tue 2:00"
  callback: boolean;             // the owner owes them a call or reply
  important?: boolean;           // texted to the owner as it happened
  resolved?: boolean;            // closes an earlier callback for this person (e.g. the owner's answer was relayed)
  key?: string;                  // idempotency key: a second record with the same key is skipped
}

async function file(): Promise<string> {
  const cfg = await loadConfig();
  await fs.mkdir(cfg.dataDir, { recursive: true });
  return path.join(cfg.dataDir, "workline-log.jsonl");
}

export async function readWorkLine(sinceMs: number): Promise<WorkLineEntry[]> {
  try {
    const raw = await fs.readFile(await file(), "utf8");
    return raw.split("\n").filter(Boolean).flatMap((l) => {
      try { return [JSON.parse(l) as WorkLineEntry]; } catch { return []; }
    }).filter((e) => Date.parse(e.at) >= sinceMs);
  } catch {
    return [];
  }
}

/**
 * Log the event and write it to vault memory under the contact. Returns whether the log line is on
 * disk (true also when a keyed entry was already recorded). Never throws.
 */
// Keyed writes are check-then-append; queue them per key so two concurrent callers can't both append.
const keyQueues = new Map<string, Promise<unknown>>();
function underKey<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const run = (keyQueues.get(key) ?? Promise.resolve()).then(fn, fn);
  const settled = run.catch(() => {});
  keyQueues.set(key, settled);
  void settled.then(() => { if (keyQueues.get(key) === settled) keyQueues.delete(key); });
  return run;
}

async function appendEntry(entry: WorkLineEntry): Promise<"written" | "exists"> {
  if (entry.key) {
    const raw = await fs.readFile(await file(), "utf8").catch(() => "");
    if (raw.split("\n").some((l) => l.includes(`"key":${JSON.stringify(entry.key)}`))) return "exists";
  }
  await fs.appendFile(await file(), JSON.stringify(entry) + "\n", "utf8");
  return "written";
}

export async function recordWorkLine(entry: WorkLineEntry, memory?: { threadKey: string; subject?: string; detail?: string }): Promise<boolean> {
  try {
    const r = await (entry.key ? underKey(entry.key, () => appendEntry(entry)) : appendEntry(entry));
    if (r === "exists") return true;
  } catch (e) {
    console.warn("[clara/workline] log write failed:", String(e).slice(0, 160));
    return false;
  }
  try {
    const { recordOutcome } = await import("./vaultMemory");
    const day = entry.at.slice(0, 10);
    await recordOutcome({
      thread: `workline-${memory?.threadKey ?? entry.from}-${day}`,
      kind: entry.channel === "call" ? "call" : "text",
      title: `${entry.channel === "call" ? "Call" : "Text"} from ${entry.who}${entry.need ? `: ${entry.need.slice(0, 80)}` : ""}`,
      subject: memory?.subject,
      status: entry.callback ? "waiting" : "done",
      outcome: entry.did,
      done: memory?.detail,
      next: entry.callback ? `${entry.who} is waiting on a reply from the owner.` : undefined,
      people: memory?.subject ? [memory.subject] : undefined,
      at: new Date(entry.at),
    });
  } catch { /* recordOutcome never throws, but its import could */ }
  return true;
}

/**
 * Pure: the brief's lines. Collapses repeat contact from one person into one line (the latest need
 * and action win), puts callbacks first, and never repeats a number as both who and detail.
 */
export function callsAndTextsLines(entries: WorkLineEntry[]): { lines: string[]; callbacks: string[] } {
  const byWho = new Map<string, WorkLineEntry & { count: number; channels: Set<string> }>();
  for (const e of [...entries].sort((a, b) => a.at.localeCompare(b.at))) {
    const cur = byWho.get(e.from);
    if (!cur) { byWho.set(e.from, { ...e, count: 1, channels: new Set([e.channel]) }); continue; }
    cur.count += 1;
    cur.channels.add(e.channel);
    cur.at = e.at;
    cur.who = e.who !== e.from ? e.who : cur.who;
    cur.need = e.need || cur.need;
    cur.did = e.did;
    cur.callback = e.resolved ? false : cur.callback || e.callback;
    cur.important = cur.important || e.important;
  }
  const rows = [...byWho.values()].sort((a, b) => Number(b.callback) - Number(a.callback) || b.at.localeCompare(a.at));
  const lines = rows.map((r) => {
    const how = [...r.channels].map((c) => (c === "call" ? "called" : "texted")).join(" and ");
    const times = r.count > 1 ? ` (${r.count} times)` : "";
    return `${r.who} ${how}${times}${r.need ? ` — ${r.need}` : ""}. ${r.did}${r.important ? " (I told you about this as it happened.)" : ""}`.replace(/\.\./g, ".");
  });
  const callbacks = rows.filter((r) => r.callback).map((r) => `${r.who}${r.from !== r.who ? ` — ${r.from}` : ""}${r.need ? `: ${r.need}` : ""}`);
  return { lines, callbacks };
}
