// Clara — blocked senders.
//
// WHY THIS EXISTS RATHER THAN JUST A GMAIL FILTER. A real server-side Gmail filter is the right
// answer: it applies the moment mail arrives, whether or not Clara is running. Creating one needs
// the `gmail.settings.basic` scope, and the work account's refresh token was minted with
// readonly + send + modify only. Adding a scope to the consent list does NOT grant it — the owner
// has to re-authorize — so a filter-only implementation would 403 on its first real use.
//
// So blocking is two layers, and `blockSender` reports honestly which ones took effect:
//   1. This list, enforced on every inbox-zero pass with the modify scope Clara already has.
//      Works today. Only applies when a sweep runs.
//   2. A real Gmail filter, attempted alongside it. Works the instant it exists, and survives
//      Clara being down — but only once the scope is granted.
//
// Layer 1 alone is the difference between "she can block that phishing sender" and "she can't do
// anything until you re-authorize Google", which is why it is not merely a fallback.
//
// NOTHING HERE DELETES MAIL. Blocked mail is archived and marked read — it leaves the inbox and
// stays in All Mail. A false positive costs a search, never a message.

import fs from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "./config";

export interface BlockedSender {
  /** Lowercased. Either a full address (`a@b.com`) or a bare domain (`b.com`) for a whole domain. */
  sender: string;
  addedAt: string;
  /** Why, in the owner's or Clara's words. Shown when listing so an old entry is explicable. */
  reason?: string;
  /** Set when a real Gmail filter was also created, so it can be removed alongside this entry. */
  gmailFilterId?: string;
}

async function blocklistPath(): Promise<string> {
  const cfg = await loadConfig();
  return path.join(cfg.vaultRoot, "preferences", "blocked-senders.json");
}

export async function readBlocklist(): Promise<BlockedSender[]> {
  try {
    const raw = await fs.readFile(await blocklistPath(), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((r): r is BlockedSender =>
      !!r && typeof r === "object" && typeof (r as BlockedSender).sender === "string");
  } catch {
    return [];
  }
}

async function writeBlocklist(rows: BlockedSender[]): Promise<void> {
  const p = await blocklistPath();
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(rows, null, 2), "utf8");
}

/**
 * Normalize what the model or the owner said into something matchable.
 *
 * Accepts `Name <a@b.com>`, `a@b.com`, `@b.com` and `b.com`. The last two mean the whole domain —
 * deliberate, because the fake-Amazon phishing that motivated this rotates the localpart on every
 * message and blocking one address at a time never converges.
 */
export function normalizeSender(raw: string): string {
  const inAngle = raw.match(/<([^>]+)>/);
  let v = (inAngle ? inAngle[1] : raw).trim().toLowerCase();
  if (v.startsWith("@")) v = v.slice(1);
  return v;
}

/** True when `fromHeader` is covered by any entry. Domain entries match any address at that domain. */
export function isBlocked(fromHeader: string, list: BlockedSender[]): BlockedSender | null {
  const addr = normalizeSender(fromHeader);
  if (!addr) return null;
  const domain = addr.includes("@") ? addr.slice(addr.indexOf("@") + 1) : addr;
  for (const row of list) {
    const s = row.sender;
    if (!s) continue;
    if (s === addr) return row;
    // A domain entry (no @) matches the address's domain and any subdomain of it.
    if (!s.includes("@") && (domain === s || domain.endsWith(`.${s}`))) return row;
  }
  return null;
}

export async function addBlocked(sender: string, reason?: string, gmailFilterId?: string): Promise<{ added: boolean; sender: string }> {
  const s = normalizeSender(sender);
  if (!s) return { added: false, sender: s };
  const rows = await readBlocklist();
  const existing = rows.find((r) => r.sender === s);
  if (existing) {
    // Idempotent, but still record a filter id learned on a later attempt (e.g. the first try
    // predated the scope being granted).
    if (gmailFilterId && !existing.gmailFilterId) {
      existing.gmailFilterId = gmailFilterId;
      await writeBlocklist(rows);
    }
    return { added: false, sender: s };
  }
  rows.push({ sender: s, addedAt: new Date().toISOString(), reason, gmailFilterId });
  await writeBlocklist(rows);
  return { added: true, sender: s };
}

export async function removeBlocked(sender: string): Promise<{ removed: boolean; row?: BlockedSender }> {
  const s = normalizeSender(sender);
  const rows = await readBlocklist();
  const i = rows.findIndex((r) => r.sender === s);
  if (i < 0) return { removed: false };
  const [row] = rows.splice(i, 1);
  await writeBlocklist(rows);
  return { removed: true, row };
}
