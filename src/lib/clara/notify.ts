// Clara — active notifications to the owner. Port of FRIDAY's src/lib/friday/notify.ts, narrowed to
// Clara's single-approver shape: approvals/escalations are always the owner's call (per tiers.ts), so there's no
// per-client routing table here — just the owner's own phone, one throttle point for every proactive
// push so Clara can reach them without spamming.
//
// The DECISION now belongs to the shared notify-policy module in agent-core (the chief-of-staff
// ladder): critical maps to `emergency` and pages now (SMS + optional voice call) ONLY when it
// carries a category ∈ {revenue, production, security, family} (explicit or inferred from `kind`)
// — otherwise it demotes to `timely` (immediate email, never SMS). normal/low always batch for
// the digest/brief. Dedupe + queue are durable (<dataDir>/notify-policy-state.json), replacing
// the 90-second in-memory window that died on every restart.
//
// Kill switch: CLARA_NOTIFY_MODE=legacy restores the previous path (kept verbatim below).

import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { loadConfig } from "./config";
import { sendSMS, placeCall, twilioConfig, esc } from "./channels";
import { sendMail } from "./ms-mail";
import { ownerDeliveryNumber } from "./ownerPhones";
import {
  parseQuietHours,
  createNotifyPolicy,
  type NotifyPolicy,
  type NotifyPolicyRequest,
  type Priority as PolicyPriority,
  type EmergencyCategory,
} from "@autom8ionlab/agent-core";

export type { EmergencyCategory };

function legacyMode(): boolean {
  return process.env.CLARA_NOTIFY_MODE === "legacy";
}

// Legacy in-memory de-dupe — only the legacy path uses it now; the policy path dedupes on disk.
const recent = globalThis as unknown as { __claraNotifyRecent?: Map<string, number> };
if (!recent.__claraNotifyRecent) recent.__claraNotifyRecent = new Map<string, number>();
const seen = recent.__claraNotifyRecent!;
const DEDUPE_MS = 90_000;

function dedupe(key: string): boolean {
  const now = Date.now();
  for (const [k, t] of seen) if (now - t > DEDUPE_MS) seen.delete(k);
  if (seen.has(key)) return false;
  seen.set(key, now);
  return true;
}

export async function inQuietHours(d = new Date()): Promise<boolean> {
  const cfg = await loadConfig();
  return parseQuietHours(cfg.quietHours, d);
}

// ── Shared policy engine ─────────────────────────────────────────────────
async function policy(): Promise<NotifyPolicy> {
  const g = globalThis as unknown as { __claraNotifyPolicy?: NotifyPolicy };
  if (!g.__claraNotifyPolicy) {
    const cfg = await loadConfig();
    g.__claraNotifyPolicy = createNotifyPolicy({
      app: "CLARA",
      dataDir: cfg.dataDir,
      quietHours: cfg.quietHours,
    });
  }
  return g.__claraNotifyPolicy;
}

// Kind → emergency category, for critical call sites that predate the category field. Explicit
// `emergencyCategory` on the call always wins. A critical whose kind matches nothing demotes to
// timely — TODO(notify-policy): known demotions today: "calendar.conflict" (imminent double-
// booking) — annotate per the owner's call.
const KIND_CATEGORY_RULES: Array<[RegExp, EmergencyCategory]> = [
  [/injection/i, "security"],
  // A live business call failing mid-flight, or the outbound breaker halting every send, are
  // operational incidents — Clara's own machinery down, not batchable news.
  [/outbound\.breaker|call\.business/i, "production"],
];

function inferCategory(kind: string): EmergencyCategory | undefined {
  for (const [re, cat] of KIND_CATEGORY_RULES) if (re.test(kind)) return cat;
  return undefined;
}

async function queueFile(): Promise<string> {
  const cfg = await loadConfig();
  await fs.mkdir(cfg.dataDir, { recursive: true });
  return path.join(cfg.dataDir, "notify-queue.json");
}
interface Queued { id: string; kind: string; text: string; at: string }
async function enqueueLegacy(item: Omit<Queued, "id">): Promise<void> {
  const f = await queueFile();
  let q: Queued[] = [];
  try { q = JSON.parse(await fs.readFile(f, "utf8")); } catch { /* fresh */ }
  q.push({ id: randomUUID(), ...item });
  // Cap stays, but dropping is never silent — a full queue means something upstream is looping.
  const dropped = q.length - 100;
  if (dropped > 0) console.warn(`[clara/notify] queue over cap — dropping ${dropped} oldest queued notification(s)`);
  await fs.writeFile(f, JSON.stringify(q.slice(-100), null, 2), "utf8").catch(() => {});
}

async function readLegacyQueue(): Promise<Queued[]> {
  const f = await queueFile();
  try { return JSON.parse(await fs.readFile(f, "utf8")) as Queued[]; } catch { return []; }
}

// Everything currently queued for the digest/brief, policy queue first then any legacy leftovers —
// the /inbox notification lane reads this so "done" there and the digest agree on ids.
export async function listQueuedNotifications(): Promise<Queued[]> {
  const pol = await policy().catch(() => null);
  const policyItems: Queued[] = pol
    ? (await pol.peekQueue().catch(() => [])).map((i) => ({ id: i.id, kind: i.kind, text: i.text, at: i.at }))
    : [];
  return [...policyItems, ...(await readLegacyQueue())];
}

// Remove specific queued items by id — used by the digest flush (only clear what was actually
// delivered) and by /inbox "done" so dismissing an item there also drops it from the pending
// digest. Ids may live in the policy queue or the legacy notify-queue.json; clear both.
export async function removeQueued(ids: string[]): Promise<void> {
  if (!ids.length) return;
  const pol = await policy().catch(() => null);
  if (pol) await pol.removeQueued(ids).catch(() => {});
  const f = await queueFile();
  let q: Queued[] = [];
  try { q = JSON.parse(await fs.readFile(f, "utf8")); } catch { return; }
  const keep = q.filter((i) => !ids.includes(i.id));
  if (keep.length !== q.length) await fs.writeFile(f, JSON.stringify(keep, null, 2), "utf8").catch(() => {});
}

export type Priority = "critical" | "normal" | "low";

export interface NotifyOpts {
  kind: string;
  text: string;          // SMS body
  priority?: Priority;
  call?: boolean;        // also place a voice call reading `text` (or callText if given) — for critical pages
  callText?: string;
  dedupeKey?: string;
  // Names WHY a critical is an emergency (revenue/production/security/family). A critical without
  // one — explicit here or inferred from `kind` — demotes to timely (immediate email, no SMS/call).
  emergencyCategory?: EmergencyCategory;
}

export async function notifyOwner(opts: NotifyOpts): Promise<{ sms: boolean; call: boolean; queued: boolean; email?: boolean }> {
  if (legacyMode()) return legacyNotifyOwner(opts);
  const priority = opts.priority ?? "normal";
  const mapped: PolicyPriority = priority === "critical" ? "emergency" : priority;
  const category = priority === "critical" ? (opts.emergencyCategory ?? inferCategory(opts.kind)) : undefined;
  const req: NotifyPolicyRequest = {
    kind: opts.kind,
    text: opts.text,
    priority: mapped,
    category,
    dedupeKey: opts.dedupeKey ?? `${opts.kind}:${opts.text}`,
  };
  const pol = await policy();
  const decision = await pol.decide(req);
  if (decision.action === "drop") return { sms: false, call: false, queued: false };
  if (decision.action === "queue") {
    await pol.enqueue(req);
    return { sms: false, call: false, queued: true };
  }

  const cfg = await loadConfig();
  const ownerNumber = ownerDeliveryNumber(process.env, cfg.principals.owner.phones);
  const out: { sms: boolean; call: boolean; queued: boolean; email?: boolean } = { sms: false, call: false, queued: false };
  if (decision.channels.includes("sms")) {
    // Emergency — SMS + the optional voice page, exactly the old critical path.
    if (ownerNumber) {
      try { const r = await sendSMS(ownerNumber, opts.text); out.sms = r.ok; } catch { /* best-effort */ }
      if (opts.call && twilioConfig()) {
        try {
          const say = (t: string) => `<Say voice="Polly.Joanna">${esc(t)}</Say>`;
          const twiml = `<?xml version="1.0" encoding="UTF-8"?><Response>${say(opts.callText ?? opts.text)}<Pause length="1"/>${say("Goodbye.")}</Response>`;
          const r = await placeCall(ownerNumber, { twiml });
          out.call = r.ok;
        } catch { /* best-effort */ }
      }
    }
  } else {
    // Timely — email-only by design (never SMS/call): the immediate-but-not-interrupting rung.
    // If email can't go out, queue instead of losing it.
    const email = cfg.principals.owner.emails[0];
    const r = email
      ? await sendMail({ to: email, subject: `Clara: ${opts.kind}`, body: opts.text, headers: { "X-Clara-Notify": "1" } }).catch(() => ({ ok: false }))
      : { ok: false };
    out.email = r.ok;
    if (!r.ok) {
      await pol.enqueue(req);
      return { sms: false, call: false, queued: true };
    }
  }
  await pol.commit(req);
  return out;
}

// Send all queued (batched) pings as one digest — called by the scheduler's notify-digest job.
export async function flushNotifyDigest(): Promise<string> {
  if (legacyMode()) return legacyFlushNotifyDigest();
  if (await inQuietHours()) return "quiet hours";
  const pol = await policy();
  const policyItems = await pol.peekQueue();
  // Items batched before the policy cutover still live in notify-queue.json — drain them too.
  const f = await queueFile();
  let legacyQ: Queued[] = [];
  try { legacyQ = JSON.parse(await fs.readFile(f, "utf8")); } catch { /* none */ }
  // Backfill ids for any pre-UUID queue entries so removal-by-id can target them too.
  if (legacyQ.some((i) => !i.id)) {
    legacyQ = legacyQ.map((i) => (i.id ? i : { ...i, id: randomUUID() }));
    await fs.writeFile(f, JSON.stringify(legacyQ, null, 2), "utf8").catch(() => {});
  }
  const total = policyItems.length + legacyQ.length;
  if (!total) return "empty";
  const cfg = await loadConfig();
  const ownerNumber = ownerDeliveryNumber(process.env, cfg.principals.owner.phones);
  if (!ownerNumber) return "no owner number";

  const lines = [...policyItems.map((i) => i.text), ...legacyQ.map((i) => i.text)];
  const body = `Clara digest (${total})\n` + lines.map((t) => `- ${t}`).join("\n");
  let delivered = false;
  if (body.length > 1400) {
    // Too big for one SMS: full list goes by email, the text is just a count + pointer.
    // Truncate-then-clear would silently eat whatever fell past the cut.
    const email = cfg.principals.owner.emails[0];
    if (!email) return "digest too long and no owner email on file";
    const r = await sendMail({ to: email, subject: `Clara digest (${total})`, body, headers: { "X-Clara-Notify": "1" } }).catch((e) => ({ ok: false, error: String(e) }));
    if (!r.ok) return `digest email failed: ${("error" in r && r.error) || "unknown"} — queue kept`;
    await sendSMS(ownerNumber, `Clara digest: ${total} queued items — full list in your email.`).catch(() => {});
    delivered = true;
  } else {
    try { const r = await sendSMS(ownerNumber, body); delivered = r.ok; } catch { /* best-effort */ }
  }
  if (!delivered) return "send failed — queue kept";
  // Only the items we just delivered come off — anything enqueued mid-flight stays for next time.
  await pol.ackQueue(policyItems.map((i) => i.id));
  await removeQueued(legacyQ.map((i) => i.id));
  return `sent ${total}`;
}

// ── Legacy path (CLARA_NOTIFY_MODE=legacy) ───────────────────────────────
// The pre-policy implementation, verbatim: 90s in-memory dedupe + quiet holds + notify-queue.json
// digest with uuid ids and the email-overflow fallback. Kept as the kill switch until the policy
// path has soaked.

async function legacyNotifyOwner(opts: NotifyOpts): Promise<{ sms: boolean; call: boolean; queued: boolean }> {
  const key = opts.dedupeKey ?? `${opts.kind}:${opts.text}`;
  if (!dedupe(key)) return { sms: false, call: false, queued: false };
  const priority = opts.priority ?? "normal";

  if (priority === "low" || (priority !== "critical" && (await inQuietHours()))) {
    await enqueueLegacy({ kind: opts.kind, text: opts.text, at: new Date().toISOString() });
    return { sms: false, call: false, queued: true };
  }

  const cfg = await loadConfig();
  const ownerNumber = ownerDeliveryNumber(process.env, cfg.principals.owner.phones);
  const out = { sms: false, call: false, queued: false };
  if (ownerNumber) {
    try { const r = await sendSMS(ownerNumber, opts.text); out.sms = r.ok; } catch { /* best-effort */ }
    if (opts.call && priority === "critical" && twilioConfig()) {
      try {
        const say = (t: string) => `<Say voice="Polly.Joanna">${esc(t)}</Say>`;
        const twiml = `<?xml version="1.0" encoding="UTF-8"?><Response>${say(opts.callText ?? opts.text)}<Pause length="1"/>${say("Goodbye.")}</Response>`;
        const r = await placeCall(ownerNumber, { twiml });
        out.call = r.ok;
      } catch { /* best-effort */ }
    }
  }
  return out;
}

async function legacyFlushNotifyDigest(): Promise<string> {
  if (await inQuietHours()) return "quiet hours";
  const f = await queueFile();
  let q: Queued[] = [];
  try { q = JSON.parse(await fs.readFile(f, "utf8")); } catch { return "empty"; }
  if (!q.length) return "empty";
  const cfg = await loadConfig();
  const ownerNumber = ownerDeliveryNumber(process.env, cfg.principals.owner.phones);
  if (!ownerNumber) return "no owner number";
  // Backfill ids for any pre-UUID queue entries so removal-by-id can target them too.
  if (q.some((i) => !i.id)) {
    q = q.map((i) => (i.id ? i : { ...i, id: randomUUID() }));
    await fs.writeFile(f, JSON.stringify(q, null, 2), "utf8").catch(() => {});
  }

  const body = `Clara digest (${q.length})\n` + q.map((i) => `- ${i.text}`).join("\n");
  let delivered = false;
  if (body.length > 1400) {
    // Too big for one SMS: full list goes by email, the text is just a count + pointer.
    // Truncate-then-clear would silently eat whatever fell past the cut.
    const email = cfg.principals.owner.emails[0];
    if (!email) return "digest too long and no owner email on file";
    const r = await sendMail({ to: email, subject: `Clara digest (${q.length})`, body, headers: { "X-Clara-Notify": "1" } }).catch((e) => ({ ok: false, error: String(e) }));
    if (!r.ok) return `digest email failed: ${("error" in r && r.error) || "unknown"} — queue kept`;
    await sendSMS(ownerNumber, `Clara digest: ${q.length} queued items — full list in your email.`).catch(() => {});
    delivered = true;
  } else {
    try { const r = await sendSMS(ownerNumber, body); delivered = r.ok; } catch { /* best-effort */ }
  }
  if (!delivered) return "send failed — queue kept";
  // Only the items we just delivered come off — anything enqueued mid-flight stays for next time.
  await removeQueued(q.map((i) => i.id));
  return `sent ${q.length}`;
}
