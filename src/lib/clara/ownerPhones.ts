// Clara — which numbers are the owner's, and which one to reach them on.
//
// Until 2026-09-25 there was one number (OWNER_PHONE) and it did both jobs: it identified the owner on an
// inbound call or text, and it was where every owner-bound call and text went. That number is their
// WORK iPhone. Once the work line forwards to Clara (carrier call forwarding) and its texts reach her through
// the Mac relay, reaching them on it would mean ringing and texting the very line she is answering.
//
//   OWNER_PHONE           — unchanged: identifies the owner (kept so nothing that already works moves).
//   OWNER_WORK_PHONE      — the work iPhone's number. Identifies the owner; the forwarding source.
//   OWNER_PERSONAL_PHONE  — their personal cell. Identifies the owner; where owner-bound delivery goes.
//
// Every variable is optional. With only OWNER_PHONE set this resolves exactly as before.
//
// The on-disk config (clara.config.json) persists principals.owner.phones and array fields replace
// rather than merge, so the new numbers are read from env here instead of being threaded through
// config — otherwise an existing install would never see them.

import { loadConfig } from "./config";

type Env = Record<string, string | undefined>;

/** Last ten digits — kept for display keys and dedupe keys only, never for identity. */
export function phoneKey(raw: string | undefined | null): string {
  return String(raw ?? "").replace(/\D/g, "").slice(-10);
}

/**
 * Full E.164 form, or null when the value isn't a dialable number. A bare ten-digit number is taken
 * as US (+1); anything else must carry its country code. "(813) 555-0100" → "+18135550100".
 */
export function normalizeE164(raw: string | undefined | null): string | null {
  const t = String(raw ?? "").trim();
  if (!t || /[a-z]/i.test(t)) return null;
  const d = t.replace(/\D/g, "");
  // Explicit country code: NANP (+1) numbers are exactly 11 digits; elsewhere E.164 allows 8–15
  // (Iceland's +354 mobiles have ten, for example).
  if (t.startsWith("+")) {
    if (d.startsWith("1")) return d.length === 11 ? `+${d}` : null;
    return d.length >= 8 && d.length <= 15 ? `+${d}` : null;
  }
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith("1")) return `+${d}`;
  return null;
}

/**
 * Identity comparison on the COMPLETE number. Suffix matching would let +44 689 555 0100 pass as
 * +1 689 555 0100 — acceptable for a dedupe key, not for deciding who is the owner.
 */
export function samePhone(a: string | undefined | null, b: string | undefined | null): boolean {
  const na = normalizeE164(a);
  return na !== null && na === normalizeE164(b);
}

function clean(v: string | undefined): string {
  return (v ?? "").trim();
}

/** Every number that identifies the owner: config phones plus the three env numbers, de-duplicated. */
export function ownerPhoneSet(env: Env, cfgPhones: string[]): string[] {
  const out: string[] = [];
  for (const p of [...cfgPhones, clean(env.OWNER_PHONE), clean(env.OWNER_PERSONAL_PHONE), clean(env.OWNER_WORK_PHONE)]) {
    if (!normalizeE164(p)) continue;
    if (!out.some((q) => samePhone(q, p))) out.push(p);
  }
  return out;
}

/**
 * Numbers Clara must never ring or text to reach the owner. The work phone forwards every call (*72) to
 * the work line and its texts come back through the Mac relay — ringing it rings Clara, texting it
 * texts Clara. Her own Twilio numbers are the same loop by another route.
 */
export function loopNumbers(env: Env): string[] {
  return [env.OWNER_WORK_PHONE, env.CLARA_WORKLINE_NUMBER, env.CLARA_TWILIO_NUMBER]
    .map((p) => normalizeE164(p)).filter((p): p is string => p !== null);
}

export function isLoopNumber(env: Env, phone: string | undefined | null): boolean {
  return loopNumbers(env).some((l) => samePhone(l, phone));
}

/**
 * Where to reach the owner: their personal cell when set, otherwise the number they have always been reached
 * on — but never the work phone or one of Clara's own lines. An unusable value falls through to the
 * next valid one rather than swallowing delivery.
 */
export function ownerDeliveryNumber(env: Env, cfgPhones: string[]): string | undefined {
  return [env.OWNER_PERSONAL_PHONE, ...cfgPhones, env.OWNER_PHONE]
    .map((p) => normalizeE164(p))
    .find((p): p is string => p !== null && !isLoopNumber(env, p));
}

/**
 * Where a warm transfer may ring: the owner's personal cell and nothing else. Transfers used to fall back to
 * OWNER_PHONE, which is the work phone — with unconditional forwarding that dials the caller straight
 * back into Clara. No personal cell, no transfer: she takes the message instead.
 */
export function transferTarget(env: Env = process.env): string | undefined {
  const p = normalizeE164(env.OWNER_PERSONAL_PHONE);
  return p && !isLoopNumber(env, p) ? p : undefined;
}

export async function ownerPhones(): Promise<string[]> {
  const cfg = await loadConfig();
  return ownerPhoneSet(process.env, cfg.principals.owner.phones);
}

export async function ownerDeliveryPhone(): Promise<string | undefined> {
  const cfg = await loadConfig();
  return ownerDeliveryNumber(process.env, cfg.principals.owner.phones);
}

/** Synchronous form for TwiML builders that can't await config: env only. */
export function ownerDeliveryPhoneFromEnv(env: Env = process.env): string | undefined {
  return ownerDeliveryNumber(env, []);
}
