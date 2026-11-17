// Clara — the owner's work line. 
//
// The owner's work number stays on their phone. Calls reach Clara through carrier forwarding
// (*71 no-answer/busy, *72 everything) to a Twilio number used ONLY for that — CLARA_WORKLINE_NUMBER —
// so the To number alone says "this is the owner's work phone", not her published business line. Texts reach
// her through BlueBubbles on a Mac (bluebubbles.ts).
//
// On this line she is the owner's assistant, not the company's front desk: "the owner's office, this is Clara".
// She takes a full message, answers the common questions, books time on their calendar, and puts an
// urgent caller through to their personal cell with a whisper they must accept with a key press. She
// never agrees to money, contracts, pricing or scope.
//
// Everything here is inert until CLARA_WORKLINE_NUMBER (calls) is set.

import type { CallerKind, TransferOutcome } from "./call-sessions";
import type { PutThroughTier } from "./putThrough";
import type { CalEvent } from "./ms-calendar";
import { esc } from "./channels";
import { samePhone } from "./ownerPhones";
import { OWNER_FIRST } from "./owner";

type Env = Record<string, string | undefined>;

export function workLineNumber(env: Env = process.env): string | undefined {
  return env.CLARA_WORKLINE_NUMBER?.trim() || undefined;
}

/**
 * True when an inbound call arrived on the work line: dialed straight to the forwarding target, or
 * forwarded from the work phone (Twilio passes ForwardedFrom when the carrier supplies it).
 */
export function isWorkLineCall(params: { To?: string; ForwardedFrom?: string }, env: Env = process.env): boolean {
  const target = workLineNumber(env);
  if (target && samePhone(params.To, target)) return true;
  const work = env.OWNER_WORK_PHONE?.trim();
  return Boolean(work && params.ForwardedFrom && samePhone(params.ForwardedFrom, work));
}

export const WORK_LINE_GREETING =
  `${OWNER_FIRST}'s office, this is Clara, their AI assistant. They can't pick up right now — how can I help?`;

// ── Urgency ─────────────────────────────────────────────────────────────────────────────────────

export type UrgencySignal = "deadline" | "broken" | "money" | "complaint" | "asked-for-owner" | "emergency";

const SIGNALS: Array<[UrgencySignal, RegExp]> = [
  ["emergency", /\b(emergency|urgent(ly)?|life or death|asap)\b/i],
  ["deadline", /\b(today|tonight|this (morning|afternoon|evening)|right (now|away)|by (noon|end of (the )?day|eod|close of business|cob|\d{1,2}(:\d{2})?\s*(am|pm)?)|within the hour|in an hour|before (noon|\d))\b/i],
  ["broken", /\b(down|outage|offline|broken|not working|isn'?t working|won'?t (load|work|open)|crash(ed|ing)?|can'?t (log ?in|access|get in)|locked out|error|hacked|breach)\b/i],
  ["money", /\b(payment|pay(ing)?|invoice|wire|refund|charge(d|back)?|billing|overdue|contract|sign(ed|ing)? (the )?(agreement|contract)|purchase order|\$\s?\d)/i],
  ["complaint", /\b(complain(t|ing)?|unhappy|upset|angry|furious|cancel(l?ing)?|disappointed|unacceptable|lawyer|legal action)\b/i],
  ["asked-for-owner", new RegExp(`\\b(speak|talk) (to|with) (${OWNER_FIRST}|him|her|them|the owner)|\\bneed (${OWNER_FIRST}|him|her|them)\\b|\\bget (${OWNER_FIRST}|him|her|them) on\\b|\\bis ${OWNER_FIRST} (there|available|around)\\b`, "i")],
];

export function urgencySignals(text: string): UrgencySignal[] {
  const t = String(text ?? "");
  return SIGNALS.filter(([, re]) => re.test(t)).map(([s]) => s);
}

export interface UrgencyInput {
  kind: CallerKind;
  /** Everything known about what they need: the learned need plus what they just said. */
  text: string;
  /** The model judged that they want a person now. */
  wantsOwner?: boolean;
}

/**
 * Who they are plus what they need. Strangers only get through for a stated emergency — everyone
 * else leaves a message; the forwarded line is not a way to reach the owner for anyone who rings.
 */
export function triageUrgency(input: UrgencyInput): { urgent: boolean; signals: UrgencySignal[] } {
  const signals = urgencySignals(input.text);
  if (input.wantsOwner && !signals.includes("asked-for-owner")) signals.push("asked-for-owner");
  const has = (...s: UrgencySignal[]) => s.some((x) => signals.includes(x));
  let urgent = false;
  switch (input.kind) {
    case "vip":
    case "personal":
      urgent = signals.length > 0;
      break;
    case "client":
      urgent = has("emergency", "deadline", "broken", "money", "complaint");
      break;
    case "lead":
      urgent = has("emergency") || (has("deadline") && has("money", "broken"));
      break;
    case "vendor":
      urgent = has("emergency", "broken") || (has("money") && has("deadline"));
      break;
    case "unknown":
      urgent = has("emergency") && has("broken", "deadline", "money");
      break;
  }
  return { urgent, signals };
}

// ── Who is calling ──────────────────────────────────────────────────────────────────────────────

export interface ProfileInput {
  whitelisted: boolean;
  local?: { name: string; relation: string; vip: boolean } | null;
  os?: { name: string; company?: string | null; tags: string[]; stage?: string | null } | null;
}

/** Pure: the caller's relationship to the owner from what the whitelist, the owner's contacts and the OS say. */
export function classifyCaller(p: ProfileInput): { kind: CallerKind; name?: string; company?: string } {
  const name = p.local?.name || p.os?.name || undefined;
  const company = p.os?.company || undefined;
  if (p.local?.relation === "friend") return { kind: "personal", name, company };
  if (p.whitelisted || p.local?.vip || p.local?.relation === "vip-work") return { kind: "vip", name, company };
  if (p.local?.relation === "vendor" || p.os?.tags.some((t) => /vendor|supplier/i.test(t))) return { kind: "vendor", name, company };
  if (p.os) {
    const client = p.os.tags.some((t) => /client|customer|active/i.test(t)) || /won|active|onboard|delivery|retainer/i.test(p.os.stage ?? "");
    return { kind: client ? "client" : "lead", name, company };
  }
  if (p.local) return { kind: "vip", name, company };
  return { kind: "unknown", name, company };
}

export async function callerProfile(fromE164: string): Promise<{ kind: CallerKind; name?: string; company?: string }> {
  const [{ effectiveWhitelist }, { listContacts }, { lookupLead }, { putThroughFor }] = await Promise.all([
    import("./whitelist"), import("./contacts"), import("./leadContext"), import("./putThrough"),
  ]);
  const pt = await putThroughFor(fromE164).catch(() => null);
  if (pt) return { kind: "vip", name: pt.name };
  const whitelisted = (await effectiveWhitelist().catch(() => [] as string[])).some((n) => samePhone(n, fromE164));
  const local = (await listContacts().catch(() => [])).find((c) => c.phone && samePhone(c.phone, fromE164)) ?? null;
  const lead = await lookupLead({ phone: fromE164 }).catch(() => null);
  return classifyCaller({
    whitelisted,
    local: local ? { name: local.name, relation: local.relation, vip: local.vip } : null,
    os: lead ? {
      name: `${lead.firstName} ${lead.lastName}`.trim(),
      company: lead.company,
      tags: lead.tags,
      stage: lead.opportunity?.stage ?? null,
    } : null,
  });
}

// ── Calendar ────────────────────────────────────────────────────────────────────────────────────

/** Next open 30-minute slots in business hours over the coming five days. Empty on any failure. */
export async function openSlots(count = 3, now = new Date()): Promise<string[]> {
  try {
    const { freeBusy, firstFreeSlot } = await import("./ms-calendar");
    const from = new Date(now.getTime() + 2 * 3_600_000);
    const to = new Date(now.getTime() + 5 * 86_400_000);
    const busy = await Promise.race([
      freeBusy(from.toISOString(), to.toISOString(), "work"),
      new Promise<null>((r) => setTimeout(() => r(null), 3_000)),
    ]);
    if (!busy) return [];
    const taken = [...busy];
    const out: string[] = [];
    for (let i = 0; i < count; i++) {
      const slot = firstFreeSlot(taken, from, to, 30);
      if (!slot) break;
      out.push(slot.toISOString());
      // Space offers out: block the rest of that day's hour so three offers aren't back-to-back.
      taken.push({ start: slot.toISOString(), end: new Date(slot.getTime() + 3 * 3_600_000).toISOString() });
    }
    return out;
  } catch {
    return [];
  }
}

export function speakSlot(iso: string, tz = process.env.CLARA_TZ || "America/New_York"): string {
  return new Date(iso).toLocaleString("en-US", { timeZone: tz, weekday: "long", hour: "numeric", minute: "2-digit" });
}

// ── VIP tiers + calendar-aware transfer gating (2026-10-01 owner decision) ─────────────────────────
//
// putThrough.ts now carries a tier per entry. "message_only" never rings the owner — Clara greets them
// by name and takes a message every time. "transfer" (the default) gets today's warm transfer, but
// only while the owner is free: busyEvent() (calendar.ts) says whether a confirmed, non-"free" event on
// their primary calendar covers right now, and if so Clara declines with one of four safe, keyword-
// based phrasings below rather than ringing the owner. She never reads out attendee names, external
// emails, locations, or a specific client's name from the event title — just which of these four
// buckets it falls in.

export type DeclineReasonKind = "appointment" | "ooo" | "travel" | "meeting";

/** Pure: which safe bucket a busy event's title falls into. Defaults to "meeting" — the vaguest, safest guess. */
export function classifyEventReason(title: string | undefined): DeclineReasonKind {
  const t = String(title ?? "").toLowerCase();
  if (t.includes("doctor") || t.includes("dentist") || t.includes("appointment")) return "appointment";
  if (t.includes("ooo") || t.includes("out of office") || t.includes("pto")) return "ooo";
  if (t.includes("travel") || t.includes("flight") || t.includes("driving")) return "travel";
  return "meeting";
}

function declineReasonForKind(kind: DeclineReasonKind): string {
  switch (kind) {
    case "appointment": return `${OWNER_FIRST}'s at an appointment right now`;
    case "ooo": return `${OWNER_FIRST}'s out of the office today`;
    case "travel": return `${OWNER_FIRST}'s traveling right now`;
    default: return `${OWNER_FIRST}'s in a meeting right now`;
  }
}

/** Pure: what Clara tells a VIP caller about why the owner's unavailable — privacy-safe, from the busy event's title alone. */
export function declineReason(event: Pick<CalEvent, "summary"> | null | undefined): string {
  return declineReasonForKind(classifyEventReason(event?.summary));
}

/** The "in a meeting"/"at an appointment"/etc fragment used for the owner's OWN notifications — their own calendar, so no privacy guard needed, but still no title leaked. */
export function vipBlockedWhyPhrase(kind: DeclineReasonKind): string {
  switch (kind) {
    case "appointment": return "at an appointment";
    case "ooo": return "out of the office";
    case "travel": return "traveling";
    default: return "in a meeting";
  }
}

export const VIP_BUSY_MESSAGE_PROMPT = `Can I take a message, and I'll make sure ${OWNER_FIRST} gets it as soon as they're free?`;

/** What Clara says to a transfer-tier VIP instead of ringing the owner while they're busy. */
export function vipCalendarDeclineLine(event: Pick<CalEvent, "summary"> | null | undefined): string {
  return `${declineReason(event)}. ${VIP_BUSY_MESSAGE_PROMPT}`;
}

/** What Clara opens with for a message-only VIP — never rung, every call. */
export function messageOnlyGreeting(name: string): string {
  return `Hi ${name}, it's Clara, ${OWNER_FIRST}'s AI assistant. ${OWNER_FIRST} is unavailable to come to the phone — can I take a message?`;
}

/**
 * The "take a message" fallback for these two VIP paths specifically (2026-10-01) — a variant of
 * holdTransfer.ts's returnLine() for a caller Clara never tried to park in the first place.
 */
export function vipTakeMessageFallback(): string {
  return `Sorry — I didn't quite catch that. Would you like to leave ${OWNER_FIRST} a message, and I'll make sure they get it as soon as they're free?`;
}

/** The plain-English text the owner gets at the moment Clara decides not to ring them — sent right away, not at end of call. */
export function vipHeadsUpText(who: string, outcome: "message_only" | "vip_blocked_calendar", reasonKind?: DeclineReasonKind): string {
  if (outcome === "message_only") return `${who} called — he's on your message-only list, so I didn't ring you. Taking a message now. — Clara`;
  return `${who} called and you're ${vipBlockedWhyPhrase(reasonKind ?? "meeting")} — I didn't ring you, I'm taking a message now. — Clara`;
}

export type VipGreetingDecision =
  | { outcome: "message_only"; greeting: string; headsUp: string }
  | { outcome: "vip_blocked_calendar"; reasonKind: DeclineReasonKind; greeting: string; headsUp: string }
  | { outcome: "hold" };

/**
 * Pure: what the greeting-hit put-through branch (voice/route.ts) does for a matched VIP — the
 * whole decision in one testable place. `busy` is the result of calendar.busyEvent() (null when
 * The owner's free, the gate failed open, or the tier is message_only and the check wasn't even made).
 */
export function decideVipGreeting(name: string, tier: PutThroughTier, busy: Pick<CalEvent, "summary"> | null): VipGreetingDecision {
  if (tier === "message_only") {
    return { outcome: "message_only", greeting: messageOnlyGreeting(name), headsUp: vipHeadsUpText(name, "message_only") };
  }
  if (busy) {
    const reasonKind = classifyEventReason(busy.summary);
    return {
      outcome: "vip_blocked_calendar",
      reasonKind,
      greeting: `Hi ${name}, it's Clara, ${OWNER_FIRST}'s AI assistant. ${vipCalendarDeclineLine(busy)}`,
      headsUp: vipHeadsUpText(name, "vip_blocked_calendar", reasonKind),
    };
  }
  return { outcome: "hold" };
}

/** True once a VIP's tier/calendar gate has already decided this call will never ring the owner — the mid-call urgent-transfer attempt must not override that decision. */
export function vipBlocksLiveTransfer(profile: { tier?: PutThroughTier } | undefined, vipBusyReason: DeclineReasonKind | undefined): boolean {
  return profile?.tier === "message_only" || Boolean(vipBusyReason);
}

// ── Warm transfer ───────────────────────────────────────────────────────────────────────────────

/**
 * The TwiML the owner hears when their cell answers a transfer. They must press 1: a voicemail greeting can't,
 * so a transfer never gets bridged into their voicemail with the caller left talking to a recording.
 * No key within the timeout → the leg hangs up and the dial-status route takes the caller back.
 */
export function whisperTwiml(opts: { text: string; acceptUrl: string; speakXml: string }): string {
  return `<Response>` +
    `<Gather input="dtmf" numDigits="1" timeout="8" action="${esc(opts.acceptUrl)}" method="POST">${opts.speakXml}</Gather>` +
    `<Hangup/></Response>`;
}

export function whisperText(state: { learned: Record<string, string>; fromE164: string; line?: string; profile?: { name?: string; company?: string } } | null): string {
  const l = state?.learned ?? {};
  const name = l.callerName || state?.profile?.name;
  const company = l.company || state?.profile?.company;
  const who = name ? `${name}${company ? ` from ${company}` : ""}` : company || (state ? `an unrecognized number, ${state.fromE164}` : "an inbound caller");
  const label = state?.line === "work" ? "Work call" : "Incoming call";
  return `${label} from ${who}${l.need ? `. They need: ${l.need}` : ""}. Press 1 to take it.`;
}

/** Pure: the owner accepted the transfer only when they pressed exactly 1. */
export function acceptedDigits(digits: string | undefined): boolean {
  return String(digits ?? "").trim() === "1";
}

/** Pure: did the transfer really reach the owner? A "completed" dial whose whisper they never accepted did not. */
export function transferConnected(dialCallStatus: string, accepted: boolean | undefined): boolean {
  return (dialCallStatus === "completed" || dialCallStatus === "answered") && accepted === true;
}

/**
 * Pure: how an unaccepted dial ended, from Twilio's DialCallStatus. "completed"/"answered" without
 * a 1 means their phone picked up and nobody took it — an ignored whisper or a voicemail greeting,
 * which this flow can't tell apart ("no-reply"). Everything else never reached the owner.
 */
export function transferOutcomeFromDial(dialCallStatus: string): TransferOutcome {
  return dialCallStatus === "completed" || dialCallStatus === "answered" ? "no-reply" : "no-answer";
}

// ── Plain-English summaries ─────────────────────────────────────────────────────────────────────

export function whoLabel(learned: Record<string, string>, profile: { name?: string; company?: string } | undefined, from: string): string {
  const name = learned.callerName || profile?.name;
  const company = learned.company || profile?.company;
  if (name) return `${name}${company ? ` (${company})` : ""}`;
  return company ? `someone from ${company}` : from;
}
