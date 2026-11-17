// Clara — outbound governor. Scaled-down port of FRIDAY's src/lib/friday/outbound.ts: every
// AUTONOMOUS proactive send (a follow-up nudge, a vendor quote-request blast, a gift reminder)
// passes through gateOutbound() BEFORE the raw transport. The gate:
//   - trips a GLOBAL breaker (too many sends/hour -> pause all outbound + page the owner) — protects
//     against a runaway loop (e.g. a bugged nudge cycle re-firing);
//   - enforces a per-contact/day cap (the "already texted this vendor 5 times today" guard);
//   - defers deferrable sends that fall in the owner's quiet hours to the next local 08:00.
//
// Clara only has one owner (unlike FRIDAY's per-client/per-timezone model), so this drops
// FRIDAY's STATE_TZ machinery entirely and reads the owner's single local hour directly.
//
// Approval alerts (notify.ts) and emergency screening interrupts are NEVER routed through this
// gate — they're critical/inbound-driven, not autonomous proactive sends, and must never be
// capped or deferred.

import { promises as fs } from "node:fs";
import path from "node:path";
import { loadConfig } from "./config";
import { notifyOwner } from "./notify";
import { isOnDnc, normalizePhone } from "./dnc";

const num = (v: string | undefined, d: number) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : d; };
const MAX_PER_CONTACT_DAY = () => num(process.env.CLARA_OUTBOUND_MAX_PER_CONTACT_DAY, 5);
const GLOBAL_HOUR_BREAKER = () => num(process.env.CLARA_OUTBOUND_GLOBAL_HOUR_BREAKER, 20);

const HOUR = 3_600_000, DAY = 86_400_000;

export interface OutboundMeta {
  channel: "email" | "sms";
  to: string;
  kind: string; // "followup.nudge" | "vendor.quote-req" | "gift.reminder" | ...
}

async function dataDir(): Promise<string> {
  const cfg = await loadConfig();
  await fs.mkdir(cfg.dataDir, { recursive: true });
  return cfg.dataDir;
}

// ── Global breaker pause (persisted, auto-expiring) ─────────────────────
async function pauseFile(): Promise<string> { return path.join(await dataDir(), "outbound-pause.json"); }
async function pausedUntil(): Promise<number> {
  try { return Number(JSON.parse(await fs.readFile(await pauseFile(), "utf8")).until) || 0; } catch { return 0; }
}
async function setPause(untilMs: number, reason: string): Promise<void> {
  try { await fs.writeFile(await pauseFile(), JSON.stringify({ until: untilMs, reason, at: new Date().toISOString() }, null, 2), "utf8"); } catch { /* best-effort */ }
}
export async function clearOutboundPause(): Promise<void> { await setPause(0, "cleared"); }
export async function outboundPaused(): Promise<boolean> { return (await pausedUntil()) > Date.now(); }

// ── Sent-record log (rolling, used only for rate-cap counting) ──────────
interface SentRecord { ts: number; channel: string; to: string; kind: string }
async function recordFile(): Promise<string> { return path.join(await dataDir(), "outbound-sent.json"); }
async function sentSince(sinceMs: number): Promise<SentRecord[]> {
  try {
    const rows: SentRecord[] = JSON.parse(await fs.readFile(await recordFile(), "utf8"));
    return rows.filter((r) => r.ts >= sinceMs);
  } catch { return []; }
}
async function appendSent(rec: SentRecord): Promise<void> {
  const f = await recordFile();
  let rows: SentRecord[] = [];
  try { rows = JSON.parse(await fs.readFile(f, "utf8")); } catch { /* fresh */ }
  rows.push(rec);
  const cutoff = Date.now() - DAY * 2;
  await fs.writeFile(f, JSON.stringify(rows.filter((r) => r.ts >= cutoff).slice(-500), null, 2), "utf8").catch(() => {});
}

// ── Quiet hours (the owner's single configured window) ────────────────────────
function quietWindow(raw: string): { start: number; end: number } {
  const m = raw.match(/^(\d{1,2}):?\d{0,2}\s*-\s*(\d{1,2}):?\d{0,2}$/);
  return { start: m ? Number(m[1]) : 22, end: m ? Number(m[2]) : 7 };
}

// ── The gate ──────────────────────────────────────────────────────────────
export type GateAction =
  | { action: "send" }
  | { action: "queue"; sendAfterMs: number; reason: string }
  | { action: "block"; reason: string };

export async function gateOutbound(meta: OutboundMeta, opts: { deferrable?: boolean } = {}): Promise<GateAction> {
  const now = Date.now();
  if (await outboundPaused()) return { action: "block", reason: "global outbound pause (breaker) active" };

  // DNC is absolute and applies to EVERY outbound SMS — proactive or reactive. The inbound autoreply
  // path checks this too, but a proactive send (follow-up nudge, blast) reaches the transport only
  // through this gate, so without the check here an opted-out contact could still be texted. Re-checked
  // at queue-flush time as well, so a STOP received after enqueue is still honored. (Email opt-out is a
  // separate mechanism; DNC is the SMS registry.)
  if (meta.channel === "sms" && (await isOnDnc(meta.to))) {
    return { action: "block", reason: "recipient opted out (DNC)" };
  }

  const hourSent = await sentSince(now - HOUR);
  if (hourSent.length >= GLOBAL_HOUR_BREAKER()) {
    await setPause(now + HOUR, "global hourly breaker tripped");
    await notifyOwner({
      kind: "outbound.breaker",
      priority: "critical",
      call: true,
      text: `Outbound paused — ${hourSent.length} messages sent in the last hour (cap ${GLOBAL_HOUR_BREAKER()}). Something is looping. All proactive sends held; approvals still work normally.`,
      dedupeKey: `breaker:${Math.floor(now / HOUR)}`,
    }).catch(() => {});
    return { action: "block", reason: "global hourly breaker" };
  }

  // Same-contact match is phone-normalized for SMS so the cap can't be evaded by reformatting the
  // number (+1813…, 813…, (813)…); email falls back to a case-insensitive compare.
  const sameContact = (a: string, b: string) =>
    meta.channel === "sms" ? normalizePhone(a) === normalizePhone(b) : a.toLowerCase() === b.toLowerCase();
  const daySent = await sentSince(now - DAY);
  const perContactDay = daySent.filter((r) => sameContact(r.to, meta.to)).length;
  if (perContactDay >= MAX_PER_CONTACT_DAY()) return { action: "block", reason: `contact daily cap (${MAX_PER_CONTACT_DAY()})` };

  if (opts.deferrable) {
    const cfg = await loadConfig();
    const { start, end } = quietWindow(cfg.quietHours);
    const h = now ? new Date(now).getHours() : new Date().getHours();
    const inQuiet = start > end ? (h >= start || h < end) : (h >= start && h < end);
    if (inQuiet) {
      const d = new Date(now);
      if (d.getHours() >= end) d.setDate(d.getDate() + 1);
      d.setHours(end, 0, 0, 0);
      return { action: "queue", sendAfterMs: d.getTime(), reason: `quiet hours (local ${h}:00)` };
    }
  }
  return { action: "send" };
}

export async function recordSent(meta: OutboundMeta): Promise<void> {
  await appendSent({ ts: Date.now(), channel: meta.channel, to: meta.to, kind: meta.kind });
}
export async function recordBlocked(meta: OutboundMeta, reason: string): Promise<void> {
  // Blocked sends are visible via the ledger call site (each caller ledgers its own "blocked"
  // outcome) — this module only owns the counting/breaker state, not the audit trail.
  void meta; void reason;
}

// ── Queue + flush (deferred-to-quiet-hours sends) ────────────────────────
interface QueuedSend { id: string; meta: OutboundMeta; body: string; subject?: string; sendAfterMs: number }
async function queueFile(): Promise<string> { return path.join(await dataDir(), "outbound-queue.json"); }

export async function enqueue(meta: OutboundMeta, sendAfterMs: number, body: string, subject?: string): Promise<void> {
  const f = await queueFile();
  let rows: QueuedSend[] = [];
  try { rows = JSON.parse(await fs.readFile(f, "utf8")); } catch { /* fresh */ }
  rows.push({ id: crypto.randomUUID(), meta, body, subject, sendAfterMs });
  await fs.writeFile(f, JSON.stringify(rows, null, 2), "utf8");
}

export async function flushOutboundQueue(): Promise<string> {
  const now = Date.now();
  const f = await queueFile();
  let rows: QueuedSend[] = [];
  try { rows = JSON.parse(await fs.readFile(f, "utf8")); } catch { return "empty"; }
  const due = rows.filter((r) => r.sendAfterMs <= now);
  if (!due.length) return "none due";
  let sent = 0, held = 0;
  const remaining = rows.filter((r) => r.sendAfterMs > now);
  for (const r of due) {
    const gate = await gateOutbound(r.meta, { deferrable: false });
    if (gate.action !== "send") { remaining.push(r); held++; continue; }
    let ok = false;
    if (r.meta.channel === "email") {
      const { sendMail } = await import("./ms-mail");
      const res = await sendMail({ to: r.meta.to, subject: r.subject ?? "Following up", body: r.body }).catch(() => ({ ok: false }));
      ok = res.ok;
    } else {
      const { sendSMS } = await import("./channels");
      const res = await sendSMS(r.meta.to, r.body).catch(() => ({ ok: false }));
      ok = res.ok;
    }
    if (ok) { await recordSent(r.meta); sent++; } else { held++; remaining.push(r); }
  }
  await fs.writeFile(f, JSON.stringify(remaining, null, 2), "utf8").catch(() => {});
  return `${sent} flushed, ${held} still held`;
}
