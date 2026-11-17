// Clara — the SMS half of the readiness-scorecard follow-up.
//
// The owner's emails run in the OS workflow engine. Clara's four texts run HERE, because her number
// (CLARA_TWILIO_NUMBER) is the one leads will reply to, her inbound SMS route already handles STOP/DNC
// and conversation, and the OS workflow SMS path is not usable (its consent gate reads columns
// that don't exist). The OS stays the source of truth: who is eligible comes from the org-scoped
// `scorecard_drip_candidates` RPC (consent + no reply/booking/opt-out), and every send is written
// back through `scorecard_drip_event` (messages row, contact_timeline scorecard_sms_sent).
//
// Schedule (measured from the scorecard completion, i.e. when the PDF went out):
//   S1  >= 28h   intro — Clara says who she is and asks which workflow prompted the scorecard
//   S2  >= 72h   one question (the {pain} vs {framework} NEPQ prompt)
//   S3  >= 144h  outline nudge — ONLY if E3's Sprint-outline link was not clicked
//   S4  >= 240h  closing the loop with the calendar short link
// Sends only 09:00–17:59 America/New_York; the ticker runs every 15 minutes inside that window.
//
// Gate: CLARA_SCORECARD_DRIP = off | shadow | active (default shadow). Shadow logs the would-send
// to the ledger and the contact timeline (scorecard_sms_shadow) and sends nothing.
//
// Owner note (2026-09-05): this is the explicit exception to "no agent messages clients directly" —
// scorecard LEADS who ticked the SMS opt-in, scripted copy the owner approved, and it stops the moment
// they reply. It does not touch clients.
import { osClient, osEnabled } from "./osClient";
import { sendSMS, twilioConfig } from "./channels";
import { gateOutbound, recordSent, recordBlocked } from "./outbound";
import { append as ledgerAppend } from "./ledger";
import { isOnDnc } from "./dnc";
import { OWNER_FIRST, BUSINESS_NAME } from "./owner";

export type DripMode = "off" | "shadow" | "active";

export function dripMode(): DripMode {
  const v = (process.env.CLARA_SCORECARD_DRIP ?? "shadow").trim().toLowerCase();
  return v === "active" || v === "off" ? v : "shadow";
}

const DRIP_TZ = "America/New_York";
const WINDOW_START_HOUR = 9;   // inclusive
const WINDOW_END_HOUR = 18;    // exclusive → last send 17:59
const MAX_SENDS_PER_TICK = 20; // matches the outbound governor's hourly breaker

/** Hour-of-day in the drip timezone, independent of the box's clock. */
export function hourInDripTz(now: Date = new Date()): number {
  const h = new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone: DRIP_TZ }).format(now);
  const n = Number(h);
  return n === 24 ? 0 : n;
}

export function inSendWindow(now: Date = new Date()): boolean {
  const h = hourInDripTz(now);
  return h >= WINDOW_START_HOUR && h < WINDOW_END_HOUR;
}

// ── Steps and copy ─────────────────────────────────────────────────────────────────────────────

export interface DripStep {
  step: 1 | 2 | 3 | 4;
  /** Hours after scorecard completion. */
  afterHours: number;
  /** S3 is skipped when the lead already clicked E3's outline link. */
  skipIfOutlineClicked?: boolean;
  render: (t: Tokens) => string;
}

export interface Tokens {
  first_name: string;
  vertical: string;
  framework_short: string;
  weakest: string;
  pain: string;
  role: string;
  book_short_url: string;
}

// Clara's voice: she is Clara, the business's AI assistant, working with the owner. Never pretends to be
// the owner. One question per text. No links in S1/S2 (docx rule). All under 320 chars.
export const DRIP_STEPS: readonly DripStep[] = [
  {
    step: 1,
    afterHours: 28,
    render: (t) =>
      `Hi ${t.first_name}, I'm Clara, ${BUSINESS_NAME}'s AI assistant. I work with ${OWNER_FIRST}. Your ${t.vertical} one-pager and control map landed in your inbox yesterday; lowest area was ${t.weakest}. Which workflow made you take the scorecard? Reply STOP to opt out.`,
  },
  {
    step: 2,
    afterHours: 72,
    render: (t) =>
      `${t.first_name}, Clara again from ${BUSINESS_NAME}. Quick one: is ${t.pain} still mostly manual on your side, or have you found something that holds up under ${t.framework_short}?`,
  },
  {
    step: 3,
    afterHours: 144,
    skipIfOutlineClicked: true,
    render: (t) =>
      `Clara here (${BUSINESS_NAME}). The 30-day outline ${OWNER_FIRST} emailed is the one-pager most ${t.role}s forward to their security lead. Want me to text you the link instead? Reply Y.`,
  },
  {
    step: 4,
    afterHours: 240,
    render: (t) =>
      `${t.first_name}, last text from me. If ${t.pain} is worth 30 minutes with ${OWNER_FIRST}, here's the calendar: ${t.book_short_url}. If not, reply N and I'll go quiet. Either answer is fine. - Clara, ${BUSINESS_NAME}`,
  },
];

const MAX_SMS = 320;

// ── Candidates (OS RPC) ────────────────────────────────────────────────────────────────────────

interface Candidate {
  contact_id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string;
  scorecard_completed_at: string;
  tokens: Record<string, unknown>;
  steps_sent: number[];
  e3_clicked: boolean;
  last_step_at: string | null;
}

function unwrap(content: unknown): unknown {
  if (Array.isArray(content)) {
    const first = content.find((c) => c && typeof c === "object" && "text" in (c as object));
    if (first && typeof (first as { text?: unknown }).text === "string") {
      try { return JSON.parse((first as { text: string }).text); } catch { return (first as { text: string }).text; }
    }
  }
  return content;
}

async function candidates(): Promise<Candidate[]> {
  const raw = unwrap(await osClient.callTool("scorecard_drip_candidates", { limit: 200 }));
  return Array.isArray(raw) ? (raw as Candidate[]) : [];
}

function tokensFor(c: Candidate): Tokens {
  const t = c.tokens ?? {};
  const s = (k: string, fallback = "") => (typeof t[k] === "string" && (t[k] as string).trim() ? (t[k] as string) : fallback);
  return {
    first_name: s("first_name", c.first_name ?? "there"),
    vertical: s("vertical", s("industry_name", "your industry")),
    framework_short: s("framework_short", s("framework", "your framework").split(/[·/]/)[0].trim()),
    weakest: s("weakest", "your lowest area"),
    pain: s("pain", "that manual workflow"),
    role: s("role", "manager"),
    book_short_url: s("book_short_url", "example.com/scorecard-call"),
  };
}

/** Which step (if any) is due for this candidate right now. One step per tick, in order. */
export function dueStep(c: Candidate, now: Date = new Date()): DripStep | null {
  const completed = new Date(c.scorecard_completed_at).getTime();
  if (!Number.isFinite(completed)) return null;
  const hours = (now.getTime() - completed) / 3_600_000;
  const sent = new Set((c.steps_sent ?? []).map(Number));
  for (const st of DRIP_STEPS) {
    if (sent.has(st.step)) continue;
    if (hours < st.afterHours) return null; // steps are ordered; nothing later can be due either
    if (st.skipIfOutlineClicked && c.e3_clicked) { sent.add(st.step); continue; } // treat as done, fall through to next
    // Don't fire two steps in one tick (e.g. after downtime): the earliest unsent, due step wins.
    return st;
  }
  return null;
}

// ── Ticker ──────────────────────────────────────────────────────────────────────────────────────

export interface TickResult { mode: DripMode; candidates: number; sent: number; shadowed: number; skipped: number; blocked: number; failed: number; notes: string[] }

export interface TickOpts {
  ignoreWindow?: boolean;
  /** Operator override for a supervised test send: run in this mode for THIS tick only … */
  modeOverride?: DripMode;
  /** … and only for this contact. Required whenever modeOverride is "active". */
  onlyContactId?: string;
}

export async function scorecardDripTick(now: Date = new Date(), opts: TickOpts = {}): Promise<TickResult> {
  // A live override without a single target is refused: the env gate is the only thing allowed to
  // turn the drip on for everyone.
  if (opts.modeOverride === "active" && !opts.onlyContactId) {
    return { mode: dripMode(), candidates: 0, sent: 0, shadowed: 0, skipped: 0, blocked: 0, failed: 0, notes: ["active override requires onlyContactId"] };
  }
  const mode = opts.modeOverride ?? dripMode();
  const res: TickResult = { mode, candidates: 0, sent: 0, shadowed: 0, skipped: 0, blocked: 0, failed: 0, notes: [] };
  if (mode === "off") return res;
  if (!osEnabled()) { res.notes.push("OS not configured"); return res; }
  if (!opts.ignoreWindow && !inSendWindow(now)) { res.notes.push(`outside ${WINDOW_START_HOUR}-${WINDOW_END_HOUR} ${DRIP_TZ}`); return res; }
  const cfg = twilioConfig();
  if (!cfg && mode === "active") { res.notes.push("Twilio not configured"); return res; }

  let rows: Candidate[];
  try {
    rows = await candidates();
  } catch (e) {
    res.notes.push(`candidates failed: ${e instanceof Error ? e.message : String(e)}`);
    return res;
  }
  res.candidates = rows.length;

  if (opts.onlyContactId) rows = rows.filter((c) => c.contact_id === opts.onlyContactId);

  let budget = MAX_SENDS_PER_TICK;
  for (const c of rows) {
    if (budget <= 0) { res.notes.push("per-tick cap reached"); break; }
    const step = dueStep(c, now);
    if (!step) { res.skipped++; continue; }
    if (!c.phone) { res.skipped++; continue; }
    // Belt and braces: the RPC excludes DNC via the OS table; Clara's own DNC file is checked too.
    if (await isOnDnc(c.phone).catch(() => false)) { res.blocked++; continue; }

    const body = step.render(tokensFor(c)).slice(0, MAX_SMS);
    const meta = { channel: "sms" as const, to: c.phone, kind: `scorecard.drip.s${step.step}` };

    if (mode === "shadow") {
      await osClient.callTool("scorecard_drip_event", { contact_id: c.contact_id, kind: "shadow", body, meta: { step: String(step.step) } }).catch(() => {});
      await ledgerAppend({ kind: "sms.sent", actor: "clara", what: `[shadow] scorecard drip S${step.step} → ${c.first_name ?? c.phone}: "${body.slice(0, 100)}"`, meta: { shadow: true, step: step.step, contact_id: c.contact_id } }).catch(() => {});
      res.shadowed++;
      budget--;
      continue;
    }

    // Outbound governor: DNC (again), global breaker, per-contact/day cap, quiet hours. We run
    // inside the send window so "queue" shouldn't happen; if it does, the next tick retries.
    const gate = await gateOutbound(meta, { deferrable: false });
    if (gate.action !== "send") {
      await recordBlocked(meta, gate.action === "block" ? gate.reason : "gated: queue").catch(() => {});
      res.blocked++;
      continue;
    }

    const r = await sendSMS(c.phone, body);
    if (!r.ok) {
      res.failed++;
      await ledgerAppend({ kind: "sms.sent", actor: "clara", what: `scorecard drip S${step.step} to ${c.phone} FAILED: ${r.error ?? "unknown"}`, meta: { step: step.step, contact_id: c.contact_id, failed: true } }).catch(() => {});
      continue;
    }
    await recordSent(meta).catch(() => {});
    res.sent++;
    budget--;
    // OS bookkeeping — this is what makes steps_sent advance next tick. If it fails we still sent,
    // so log loudly rather than swallow: a retry would double-text.
    try {
      await osClient.callTool("scorecard_drip_event", {
        contact_id: c.contact_id,
        kind: "sms_out",
        body,
        meta: { step: String(step.step), sid: r.sid ?? null, from_number: cfg?.from ?? null, delivery_status: "queued" },
      });
    } catch (e) {
      res.notes.push(`OS log failed for ${c.contact_id} S${step.step}: ${e instanceof Error ? e.message : String(e)}`);
      console.error("[scorecard-drip] scorecard_drip_event failed after a real send", c.contact_id, step.step, e);
    }
    await ledgerAppend({ kind: "sms.sent", actor: "clara", what: `scorecard drip S${step.step} → ${c.first_name ?? c.phone}: "${body.slice(0, 100)}"`, ref: r.sid, meta: { step: step.step, contact_id: c.contact_id } }).catch(() => {});
  }

  if (res.sent || res.shadowed || res.failed || res.notes.length) {
    console.log(`[scorecard-drip] mode=${mode} candidates=${res.candidates} sent=${res.sent} shadowed=${res.shadowed} skipped=${res.skipped} blocked=${res.blocked} failed=${res.failed}${res.notes.length ? " · " + res.notes.join(" | ") : ""}`);
  }
  return res;
}

// ── Reply lanes (used by the inbound SMS route) ────────────────────────────────────────────────

export type ReplyLane = "yes_outline" | "no" | "later" | null;

/** Deterministic keyword lanes from the docx. Anything else is conversation for the LLM. */
export function classifyDripReply(body: string, stepsSent: number[]): ReplyLane {
  const b = body.trim().toLowerCase().replace(/[.!]+$/, "");
  if ((b === "y" || b === "yes" || b === "yes please" || b === "sure") && stepsSent.includes(3)) return "yes_outline";
  if (b === "n" || b === "no" || b === "no thanks" || b === "no thank you" || b === "not interested") return "no";
  if (b === "later" || b.startsWith("later ") || b === "not now" || b === "not right now") return "later";
  return null;
}
