// Clara — one plain-English text to the owner when something on their work line matters. 
//
// The owner's rule: texts are for important communication only — a client or lead who needs them today,
// money or contracts, an urgent call they missed, a VIP, anything flagged urgent. One text per matter,
// no codes, nothing overnight unless it's a true emergency. Everything else waits for the 08:00
// email and the 08:30 call, where the "Calls & texts" section lists it (workLineLog.ts).
//
// This goes to their PERSONAL cell (ownerPhones.ts), never the work phone Clara is answering. It is
// deliberately separate from notifyOwner(): that ladder demotes non-emergencies to email, which is
// right for system alerts and wrong for "Jackson needs you before noon".
//
// FRIDAY never reaches this — it stays email-only.

import { promises as fs } from "node:fs";
import path from "node:path";
import { loadConfig } from "./config";
import { phoneKey } from "./ownerPhones";
import { slugify } from "./vaultMemory";

const TZ = process.env.CLARA_TZ || "America/New_York";
/** A matter texted once is not texted again for this long, however many times they call or text. */
export const IMPORTANT_DEDUPE_MS = 12 * 3_600_000;
const QUIET_START = 21;
const QUIET_END = 7;

export function localHour(d: Date, tz = TZ): number {
  const h = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hourCycle: "h23" }).format(d);
  return Number(h) % 24;
}

export function inImportantQuietHours(d: Date, tz = TZ): boolean {
  const h = localHour(d, tz);
  return h >= QUIET_START || h < QUIET_END;
}

/** One key per contact per matter: "8135550100:site-down" — the same person on a new matter still gets through. */
export function importantKey(contact: string, matter: string): string {
  const who = phoneKey(contact) || contact.trim().toLowerCase();
  return `${who}:${slugify(matter || "general", 40)}`;
}

export type ImportantDecision = "send" | "duplicate" | "quiet-hours";

export function decideImportantText(opts: { key: string; now: Date; sent: Record<string, number>; emergency?: boolean }): ImportantDecision {
  const last = opts.sent[opts.key];
  if (last && opts.now.getTime() - last < IMPORTANT_DEDUPE_MS) return "duplicate";
  if (!opts.emergency && inImportantQuietHours(opts.now)) return "quiet-hours";
  return "send";
}

async function stateFile(): Promise<string> {
  const cfg = await loadConfig();
  await fs.mkdir(cfg.dataDir, { recursive: true });
  return path.join(cfg.dataDir, "important-texts.json");
}

async function readSent(): Promise<Record<string, number>> {
  try { return JSON.parse(await fs.readFile(await stateFile(), "utf8")) as Record<string, number>; } catch { return {}; }
}

async function writeSent(sent: Record<string, number>): Promise<void> {
  const cutoff = Date.now() - 7 * 86_400_000;
  const kept = Object.fromEntries(Object.entries(sent).filter(([, t]) => t >= cutoff));
  const f = await stateFile();
  await fs.writeFile(`${f}.tmp`, JSON.stringify(kept, null, 1), "utf8");
  await fs.rename(`${f}.tmp`, f);
}

export interface ImportantText {
  /** Phone number or email of the person it's about. */
  contact: string;
  /** Short name of the matter, e.g. "site down" — the dedupe key's second half. */
  matter: string;
  /** The whole text, plain English. */
  text: string;
  /** A true emergency goes out during quiet hours too. */
  emergency?: boolean;
}

/** Text the owner once about an important matter. Returns what happened; never throws. */
export async function textOwnerImportant(item: ImportantText, now = new Date()): Promise<ImportantDecision | "emailed" | "no-number" | "failed"> {
  try {
    const key = importantKey(item.contact, item.matter);
    const sent = await readSent();
    const decision = decideImportantText({ key, now, sent, emergency: item.emergency });
    if (decision !== "send") return decision;
    const { ownerDeliveryPhone } = await import("./ownerPhones");
    const to = await ownerDeliveryPhone();
    if (!to) {
      // No personal cell on file (the work phone is never texted — it forwards to Clara). The same
      // words go by email right away instead, so the matter still reaches the owner today.
      const cfg = await loadConfig();
      const email = cfg.principals.owner.emails[0];
      if (!email) return "no-number";
      const { sendMail } = await import("./ms-mail");
      const r = await sendMail({ to: email, subject: `Clara: ${item.matter.slice(0, 80)}`, body: item.text, headers: { "X-Clara-Notify": "1" } }).catch(() => ({ ok: false }));
      if (!r.ok) return "failed";
      sent[key] = now.getTime();
      await writeSent(sent).catch(() => {});
      return "emailed";
    }
    const { sendSMS } = await import("./channels");
    const r = await sendSMS(to, item.text.replace(/\s+\n/g, "\n").trim().slice(0, 600));
    if (!r.ok) return "failed";
    sent[key] = now.getTime();
    await writeSent(sent).catch(() => {});
    const [{ append }, { appendMessage }] = await Promise.all([import("./ledger"), import("./messages")]);
    await append({ kind: "sms.sent", actor: "clara", what: `important text to the owner: ${item.matter}`, meta: { key } }).catch(() => {});
    await appendMessage("clara", item.text, undefined, { channel: "sms", from: to, principal: true }).catch(() => {});
    return "send";
  } catch {
    return "failed";
  }
}
