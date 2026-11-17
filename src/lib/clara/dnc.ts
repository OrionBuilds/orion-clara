// SMS opt-out (DNC) registry — TCPA-style STOP/START keyword handling. A live business phone
// number MUST honor these regardless of whether Twilio's own Advanced Opt-Out is configured on
// the number/messaging service: if it IS configured, Twilio intercepts STOP before this webhook
// even fires, so this is a no-op fallback; if it ISN'T, this is the only protection there is.
//
// File-backed (matches outbound.ts's own state-file convention) rather than routed through the
// orion CRM — this must keep working even if the OS integration or network is down, since honoring
// STOP is a compliance requirement, not a nice-to-have.

import { promises as fs } from "node:fs";
import path from "node:path";
import { loadConfig } from "./config";

// Standard carrier/Twilio-recognized keywords (case-insensitive, exact-body match — "please stop
// the promo" must NOT trigger this; only the bare reserved word does, matching how carriers/Twilio
// itself interprets these).
const STOP_KEYWORDS = new Set(["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"]);
const START_KEYWORDS = new Set(["START", "UNSTOP", "YES"]);

export type OptKeyword = "stop" | "start" | null;

export function matchOptKeyword(body: string): OptKeyword {
  const t = body.trim().toUpperCase();
  if (STOP_KEYWORDS.has(t)) return "stop";
  if (START_KEYWORDS.has(t)) return "start";
  return null;
}

interface DncRecord { phone: string; at: string; reason: string }

async function dncFile(): Promise<string> {
  const cfg = await loadConfig();
  await fs.mkdir(cfg.dataDir, { recursive: true });
  return path.join(cfg.dataDir, "sms-dnc.json");
}

// Canonicalize to E.164 so an opt-out is honored regardless of how the number is formatted at the
// call site. Twilio delivers `From` in E.164 (+1…), but proactive sends may pull a number from the
// CRM as "8135551234" or "(813) 555-1234" — a prior STOP from that person must still match. Existing
// DNC entries (stored as Twilio E.164) are unaffected: "+18135551234" → digits "18135551234" (len 11,
// leading 1) → "+18135551234", identical.
function normalize(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;              // bare US/Canada 10-digit
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return digits ? `+${digits}` : phone.trim();                // other country codes / unparseable
}

// Exported so outbound rate-cap counting and any other caller can compare numbers on the same basis.
export function normalizePhone(phone: string): string {
  return normalize(phone);
}

async function readAll(): Promise<DncRecord[]> {
  try { return JSON.parse(await fs.readFile(await dncFile(), "utf8")); } catch { return []; }
}
async function writeAll(rows: DncRecord[]): Promise<void> {
  await fs.writeFile(await dncFile(), JSON.stringify(rows, null, 2), "utf8").catch(() => {});
}

export async function isOnDnc(phone: string): Promise<boolean> {
  const p = normalize(phone);
  return (await readAll()).some((r) => r.phone === p);
}

export async function addToDnc(phone: string, reason = "STOP keyword"): Promise<void> {
  const p = normalize(phone);
  const rows = await readAll();
  if (rows.some((r) => r.phone === p)) return;
  rows.push({ phone: p, at: new Date().toISOString(), reason });
  await writeAll(rows);
}

export async function removeFromDnc(phone: string): Promise<void> {
  const p = normalize(phone);
  const rows = await readAll();
  const next = rows.filter((r) => r.phone !== p);
  if (next.length !== rows.length) await writeAll(next);
}
