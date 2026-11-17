// Clara — inbound call screening (business only).
//
// VIP-whitelist match → straight through to the owner. Otherwise focus-mode gates whether the call
// interrupts the owner or is handled by Clara. Wired into the Twilio voice webhook (W3).

import { effectiveWhitelist } from "./whitelist";
import type { CallContext, Urgency } from "./types";

// Ring buffer of recent inbound calls per E.164 — retained for the self-test drills.
// Process-local; fine for single-machine deployment.
const RECENT: Map<string, number[]> = new Map();
const RECENT_WINDOW_MS = 300_000;

export async function noteInbound(fromE164: string): Promise<void> {
  const now = Date.now();
  const arr = (RECENT.get(fromE164) ?? []).filter((t) => now - t < RECENT_WINDOW_MS);
  arr.push(now);
  RECENT.set(fromE164, arr);
}

export async function contextFor(fromE164: string, toE164: string, ownerFocusMode: boolean): Promise<CallContext> {
  const whitelist = await effectiveWhitelist();
  return {
    fromE164,
    toE164,
    ownerFocusMode,
    isWhitelisted: whitelist.includes(fromE164),
  };
}

export function decide(ctx: CallContext): { route: "owner" | "clara"; urgency: Urgency; reason: string } {
  if (ctx.isWhitelisted)        return { route: "owner",  urgency: "urgent",    reason: "whitelisted caller" };
  if (!ctx.ownerFocusMode)      return { route: "owner",  urgency: "normal",    reason: "not in focus mode" };
  return { route: "clara", urgency: "normal", reason: "focus mode active, non-whitelist caller" };
}

// LLM-scored urgency check on the ACTUAL call content — used once Clara has answered and
// heard the reason for the call. Escalates to the owner mid-call if the reason turns out urgent.
export async function scoreUrgencyFromContent(reasonSpoken: string): Promise<Urgency> {
  // Stubbed in W1. Wired to lmstudio + short prompt in W3.
  const emergency = /\b(emergency|hospital|accident|fire|police|911|ambulance)\b/i;
  const urgent    = /\b(urgent|deadline|today|asap|now|immediately)\b/i;
  if (emergency.test(reasonSpoken)) return "emergency";
  if (urgent.test(reasonSpoken))    return "urgent";
  return "normal";
}
