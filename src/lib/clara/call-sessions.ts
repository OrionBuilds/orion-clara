// Clara — outbound business-call conversation state, keyed by Twilio CallSid.
//
// Nothing in the codebase persists conversation state across a phone call's webhook turns —
// each Twilio POST is a fresh, stateless request. A goal-directed outbound call needs to
// remember the objective, what's been said, and what's been learned across turns, so this is a
// small in-memory store (same pattern as notify.ts's dedupe map) scoped to a call's lifetime —
// minutes, not hours. Losing it on a process restart mid-call is an acceptable, narrow edge case
// (the webhook route rehydrates the objective, though not turn history, from the persisted
// Approval as a fallback — see business-calls.ts).

import type { PrincipalId } from "./types";
import type { PutThroughTier } from "./putThrough";
import type { DeclineReasonKind } from "./workLine";

export interface BusinessCallObjective {
  businessName: string;
  phoneE164: string;
  goal: string;
  mustConfirm: string[];
  context?: string;
  requestor: PrincipalId;
}

export interface CallTurn {
  // "business" — the far end of a call Clara PLACED. "caller" — the far end of one she ANSWERED.
  // Kept distinct rather than collapsed into "them" because the prompts read the transcript back
  // to the model, and "who called whom" changes what the next turn should do.
  role: "clara" | "business" | "caller";
  text: string;
  at: string;
}

export type BusinessCallStatus = "in-progress" | "goal-met" | "ended" | "voicemail" | "injection-blocked";

export interface BusinessCallState {
  callSid: string;
  objective: BusinessCallObjective;
  turns: CallTurn[];
  learned: Record<string, string>;
  status: BusinessCallStatus;
  startedAt: string;
  updatedAt: string;
}

// ── Inbound calls (someone rang Clara's published number) ──────────────────────────────────────
//
// Same lifetime and same loss-on-restart tradeoff as the outbound state above, but a separate shape
// and a separate map. An inbound call has no objective Clara chose — she's discovering who this is
// and what they need, so there is nothing to "confirm" and no requestor. Folding it into
// BusinessCallObjective would mean a pile of optional fields and a union every read site has to
// narrow, on the one code path where a type error shows up as a live caller hearing nonsense.

export interface InboundCallState {
  callSid: string;
  fromE164: string;
  turns: CallTurn[];
  /** What Clara has managed to learn: name, company, need, timeline, callback. */
  learned: Record<string, string>;
  status: BusinessCallStatus;
  startedAt: string;
  updatedAt: string;
  /** Set once the lead has been written out, so a late status callback can't double-file it. */
  finalized?: boolean;
  /** Which number they rang: Clara's published line, or the owner's forwarded work phone (workLine.ts). */
  line?: "business" | "work";
  /** Work line: who the caller is to the owner, resolved once on the first turn. */
  profile?: { kind: CallerKind; name?: string; company?: string; tier?: PutThroughTier };
  /** Open calendar slots offered to the caller (ISO starts). Only these can be booked. Work line:
   *  The owner's Google calendar (workLine.ts). Main line: the OS booking calendar (businessBooking.ts). */
  offeredSlots?: string[];
  /** Main line: each offered start → its exact end (booking-api requires the exact slot). */
  offeredSlotEnds?: Record<string, string>;
  /** Main line: the booking made (or attempted) for learned.bookSlot — set once, so it's never booked twice. */
  booking?: import("./businessBooking").BusinessBooking;
  /**
   * A transfer-tier VIP (putThrough.ts) was declined without ringing the owner because their calendar
   * showed a busy event (2026-10-01 owner decision) — which safe phrasing was used to explain it.
   */
  vipBusyReason?: DeclineReasonKind;
  /** A heads-up text already went to the owner's cell at the start of this call (workLine.decideVipGreeting) — the end-of-call text must not count as the first one sent. */
  vipImmediateTexted?: boolean;
  /**
   * Prebuilt "MEETINGS_YOU_WERE_IN" block for the work-line prompt — summary + decisions + the
   * caller's own tasks from recent vault meetings they attended, resolved once at call setup from
   * `profile.name` (callerMeetings.ts). Empty string = resolved and found nothing; absent = not
   * resolved yet. The brain's attendee-only rule leans on this: if it's missing or blank, Clara
   * declines to discuss specific meeting content and takes a message instead.
   */
  meetingContext?: string;
  /** A warm transfer was attempted on this call — never try twice. */
  transferTried?: boolean;
  /** The owner pressed 1 on the whisper — the transfer really connected (not their voicemail). */
  transferAccepted?: boolean;
  /**
   * How the transfer attempt ended (2026-09-29). The caller hears the same neutral line whether the owner
   * passed or was never reached; this is what the log, their memory and the text to them distinguish.
   * "no-reply" — Clara asked them by text and heard nothing in time (or their phone answered and nobody
   * took it). "caller-left" — they hung up while Clara was trying.
   */
  transferOutcome?: TransferOutcome;
}

export type TransferOutcome = "connected" | "declined" | "no-reply" | "voicemail" | "no-answer" | "caller-left";

/** Who a work-line caller is to the owner. "personal" is a friend or family contact — never auto-replied to. */
export type CallerKind = "vip" | "client" | "lead" | "vendor" | "personal" | "unknown";

const GLOBAL_KEY = "__clara_call_sessions__";
const INBOUND_KEY = "__clara_inbound_call_sessions__";

function mapFor<T>(key: string): Map<string, T> {
  const g = globalThis as unknown as Record<string, Map<string, T> | undefined>;
  if (!g[key]) g[key] = new Map();
  return g[key]!;
}

function store(): Map<string, BusinessCallState> {
  return mapFor<BusinessCallState>(GLOBAL_KEY);
}

function inboundStore(): Map<string, InboundCallState> {
  return mapFor<InboundCallState>(INBOUND_KEY);
}

export function createInboundSession(callSid: string, fromE164: string): InboundCallState {
  const now = new Date().toISOString();
  const state: InboundCallState = {
    callSid, fromE164, turns: [], learned: {}, status: "in-progress", startedAt: now, updatedAt: now,
  };
  inboundStore().set(callSid, state);
  return state;
}

export function getInboundSession(callSid: string): InboundCallState | null {
  return inboundStore().get(callSid) ?? null;
}

/** Get-or-create: Twilio can retry a webhook, and a process restart mid-call loses the map. */
export function ensureInboundSession(callSid: string, fromE164: string): InboundCallState {
  return getInboundSession(callSid) ?? createInboundSession(callSid, fromE164);
}

export function appendInboundTurn(callSid: string, turn: CallTurn): void {
  const s = inboundStore().get(callSid);
  if (!s) return;
  s.turns.push(turn);
  s.updatedAt = new Date().toISOString();
}

export function updateInboundLearned(callSid: string, patch: Record<string, string>): void {
  const s = inboundStore().get(callSid);
  if (!s) return;
  // A later turn's empty string must never overwrite an earlier good value (2026-09-29): the LLM
  // sometimes returns `{need:""}` on a wrap-up turn, and Object.assign would wipe what we had.
  for (const [k, v] of Object.entries(patch)) {
    if (typeof v === "string" && v.trim()) s.learned[k] = v;
  }
  s.updatedAt = new Date().toISOString();
}

export function patchInboundSession(callSid: string, patch: Partial<Pick<InboundCallState, "line" | "profile" | "offeredSlots" | "offeredSlotEnds" | "booking" | "transferTried" | "transferAccepted" | "transferOutcome" | "vipBusyReason" | "vipImmediateTexted" | "meetingContext">>): void {
  const s = inboundStore().get(callSid);
  if (!s) return;
  Object.assign(s, patch);
  s.updatedAt = new Date().toISOString();
}

export function setInboundStatus(callSid: string, status: BusinessCallStatus): void {
  const s = inboundStore().get(callSid);
  if (!s) return;
  s.status = status;
  s.updatedAt = new Date().toISOString();
}

/**
 * Claim the right to file this call's lead exactly once, then hand back the state.
 *
 * Both the "done" branch of the voice webhook and Twilio's end-of-call status callback want to
 * finalize, and they can race. Returns null if someone already claimed it.
 */
export function claimInboundFinalize(callSid: string): InboundCallState | null {
  const s = inboundStore().get(callSid);
  if (!s || s.finalized) return null;
  s.finalized = true;
  s.updatedAt = new Date().toISOString();
  return s;
}

export function endInboundSession(callSid: string): InboundCallState | undefined {
  const s = inboundStore().get(callSid);
  inboundStore().delete(callSid);
  return s;
}

export function createSession(callSid: string, objective: BusinessCallObjective): BusinessCallState {
  const now = new Date().toISOString();
  const state: BusinessCallState = { callSid, objective, turns: [], learned: {}, status: "in-progress", startedAt: now, updatedAt: now };
  store().set(callSid, state);
  return state;
}

export function getSession(callSid: string): BusinessCallState | null {
  return store().get(callSid) ?? null;
}

export function appendTurn(callSid: string, turn: CallTurn): void {
  const s = store().get(callSid);
  if (!s) return;
  s.turns.push(turn);
  s.updatedAt = new Date().toISOString();
}

export function updateLearned(callSid: string, patch: Record<string, string>): void {
  const s = store().get(callSid);
  if (!s) return;
  // Same guard as updateInboundLearned: a later blank turn must not clobber a learned value.
  for (const [k, v] of Object.entries(patch)) {
    if (typeof v === "string" && v.trim()) s.learned[k] = v;
  }
  s.updatedAt = new Date().toISOString();
}

export function setStatus(callSid: string, status: BusinessCallStatus): void {
  const s = store().get(callSid);
  if (!s) return;
  s.status = status;
  s.updatedAt = new Date().toISOString();
}

export function endSession(callSid: string): BusinessCallState | undefined {
  const s = store().get(callSid);
  store().delete(callSid);
  return s;
}
