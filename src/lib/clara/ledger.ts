// Clara — append-only ledger.
//
// Every calendar booking, sent email, call, and action is appended here. Mirrors to
// vault/ledger/YYYY-MM.md.

import { promises as fs } from "node:fs";
import path from "node:path";
import { loadConfig } from "./config";

export type LedgerKind = "booking" | "email.sent" | "sms.sent" | "call" | "action" | "document";

export interface LedgerEntry {
  id: string;
  ts: string;
  kind: LedgerKind;
  actor: "clara" | "owner";
  what: string;
  ref?: string;              // external ref (Twilio sid, gmail msg id, etc.)
  meta?: Record<string, unknown>;
}

async function file(): Promise<string> {
  const cfg = await loadConfig();
  const dir = path.join(cfg.vaultRoot, "ledger");
  await fs.mkdir(dir, { recursive: true });
  return path.join(dir, "ledger.jsonl");
}

export async function append(entry: Omit<LedgerEntry, "id" | "ts">): Promise<LedgerEntry> {
  const row: LedgerEntry = { ...entry, id: crypto.randomUUID(), ts: new Date().toISOString() };
  await fs.appendFile(await file(), JSON.stringify(row) + "\n", "utf8");
  return row;
}

export async function readAll(): Promise<LedgerEntry[]> {
  try {
    const raw = await fs.readFile(await file(), "utf8");
    return raw.split("\n").filter(Boolean).map((line) => JSON.parse(line) as LedgerEntry);
  } catch {
    return [];
  }
}
