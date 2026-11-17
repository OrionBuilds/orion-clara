// Main business line booking (2026-10-09, the owner: callers on the main line should be able to book the
// way website visitors can).
//
// Same backend as the website chat and voice widget (orion clara-web-responder): the OS booking-api
// on the calendar named by CLARA_BOOKING_CALENDAR_ID / CLARA_BOOKING_TYPE_ID. One calendar, one set of availability rules, the same Google
// event + Meet link + confirmation email — so a phone booking and a web booking can never collide.
//
// The call UX mirrors the work line (workLine.ts openSlots / workLineCalls.ts): a few real open times
// are fetched once at call setup, Clara may only offer those, and the one the caller picks comes back
// as learned.bookSlot. booking-api re-checks the slot server-side, so a slot taken mid-call is a 409,
// never a double booking.

import type { InboundCallState } from "./call-sessions";

export interface BookableSlot { start: string; end: string }

export interface BusinessBooking {
  start: string;
  /** "uncertain": booking-api answered 2xx without confirming — it may exist; the owner verifies. */
  status: "pending" | "booked" | "taken" | "failed" | "uncertain";
  /** Whether an email went with the booking (so the calendar invite + confirmation reach them). */
  emailed?: boolean;
  meetLink?: string;
  error?: string;
}

export interface BookingDeps {
  fetch: typeof fetch;
  now: () => Date;
}

const defaultDeps: BookingDeps = { fetch: (...a) => fetch(...a), now: () => new Date() };

const calendarId = () => process.env.CLARA_BOOKING_CALENDAR_ID?.trim() ?? "";
const typeId = () => process.env.CLARA_BOOKING_TYPE_ID?.trim() ?? "";

/** The OS booking-api base, or null unless ORION_SUPABASE_URL and the booking calendar/type ids are all set. */
function bookingApi(): string | null {
  const url = process.env.ORION_SUPABASE_URL?.trim();
  return url && calendarId() && typeId() ? `${url.replace(/\/+$/, "")}/functions/v1/booking-api` : null;
}

export const bookingTz = () => process.env.CLARA_BOOKING_TZ?.trim() || "America/New_York";

/**
 * A booking slot as spoken/texted: in the BOOKING calendar's timezone (the one booking-api books in),
 * not CLARA_TZ, with the zone named so a caller elsewhere can't agree to the wrong hour.
 */
export function speakBookingSlot(iso: string, tz = bookingTz()): string {
  const when = new Date(iso).toLocaleString("en-US", { timeZone: tz, weekday: "long", hour: "numeric", minute: "2-digit" });
  let zone = "";
  try {
    zone = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longGeneric" }).formatToParts(new Date(iso)).find((p) => p.type === "timeZoneName")?.value ?? "";
  } catch { /* older ICU: fall back to the bare time */ }
  return zone ? `${when} ${zone}` : when;
}

/** Twilio drops a call webhook after 15 s; a turn that books must answer well inside that. */
export const BOOKING_TURN_DEADLINE_MS = 11_000;
/** The booking POST itself. Past this it's "uncertain" (it may still have landed), never "failed". */
export const BOOKING_POST_TIMEOUT_MS = 12_000;

/** On unless CLARA_BUSINESS_BOOKING=off, and only when the OS is configured. */
export function businessBookingEnabled(): boolean {
  return (process.env.CLARA_BUSINESS_BOOKING ?? "on").trim().toLowerCase() !== "off" && bookingApi() !== null;
}

function ymd(d: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

/**
 * Up to n slots a caller can choose between: the earliest slot on each of the next distinct days
 * first (so "tomorrow morning or Thursday" is a real choice), then the next-earliest to fill. Only
 * slots within 7 days — speakSlot says "Monday, 9:00 AM", which is ambiguous further out.
 */
export function pickSpread(slots: BookableSlot[], n: number, now: Date, tz = bookingTz()): BookableSlot[] {
  const horizon = now.getTime() + 7 * 86_400_000;
  const usable = slots
    .filter((s) => { const t = Date.parse(s.start); return Number.isFinite(t) && t > now.getTime() && t <= horizon && Date.parse(s.end) > t; })
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  const picked: BookableSlot[] = [];
  const days = new Set<string>();
  for (const s of usable) {
    if (picked.length >= n) break;
    const day = ymd(new Date(s.start), tz);
    if (days.has(day)) continue;
    days.add(day);
    picked.push(s);
  }
  for (const s of usable) {
    if (picked.length >= n) break;
    if (!picked.includes(s)) picked.push(s);
  }
  return picked.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
}

/** Open times for the main line, from the same availability engine the website uses. [] on any failure. */
export async function businessSlots(n = 3, deps: BookingDeps = defaultDeps): Promise<BookableSlot[]> {
  const api = bookingApi();
  if (!api) return [];
  const now = deps.now();
  const tz = bookingTz();
  const qs = new URLSearchParams({
    calendar_id: calendarId(), type_id: typeId(),
    start_date: ymd(now, tz), end_date: ymd(new Date(now.getTime() + 8 * 86_400_000), tz), timezone: tz,
  });
  try {
    const r = await deps.fetch(`${api}/availability?${qs}`, { signal: AbortSignal.timeout(4_000) });
    if (!r.ok) return [];
    const j = (await r.json().catch(() => ({}))) as { slots?: Array<{ start?: unknown; end?: unknown }> };
    const slots = (j.slots ?? []).flatMap((s) => (typeof s.start === "string" && typeof s.end === "string" ? [{ start: s.start, end: s.end }] : []));
    return pickSpread(slots, n, now, tz);
  } catch {
    return [];
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Normalizes a spoken/typed email ("jane at acme dot com" survives as-is and is rejected). */
export function cleanEmail(raw: string | undefined): string | undefined {
  const e = (raw ?? "").trim().replace(/\s+/g, "").replace(/\.$/, "").toLowerCase();
  return EMAIL_RE.test(e) ? e : undefined;
}

export type BookResult =
  | { ok: true; meetLink?: string; appointmentId?: string }
  | { ok: false; taken: boolean; error: string; uncertain?: true };

export async function bookBusinessSlot(
  input: { slot: BookableSlot; name?: string; email?: string; phone: string; notes?: string },
  deps: BookingDeps = defaultDeps,
  timeoutMs = BOOKING_POST_TIMEOUT_MS,
): Promise<BookResult> {
  const api = bookingApi();
  if (!api) return { ok: false, taken: false, error: "booking not configured (ORION_SUPABASE_URL, CLARA_BOOKING_CALENDAR_ID, CLARA_BOOKING_TYPE_ID)" };
  const answers: Record<string, string> = { name: input.name?.trim() || "Phone caller", phone: input.phone };
  if (input.email) answers.email = input.email;
  if (input.notes?.trim()) answers.notes = input.notes.trim().slice(0, 1_000);
  try {
    const r = await deps.fetch(`${api}/book`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        calendar_id: calendarId(), appointment_type_id: typeId(),
        start_utc: input.slot.start, end_utc: input.slot.end, visitor_timezone: bookingTz(), answers,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const j = (await r.json().catch(() => ({}))) as { success?: boolean; error?: string; appointment?: { id?: string; google_meet_link?: string | null } };
    if (r.ok && j.success) return { ok: true, appointmentId: j.appointment?.id, meetLink: j.appointment?.google_meet_link ?? undefined };
    // A 2xx that doesn't confirm (unparseable body, no success flag) may still have created the
    // appointment — never report that as a failure to the caller or to the owner.
    if (r.ok && j.success !== false && !j.error) return { ok: false, taken: false, uncertain: true, error: `booking-api ${r.status} without confirmation` };
    return { ok: false, taken: r.status === 409, error: (j.error || `booking-api ${r.status}`).slice(0, 200) };
  } catch (e) {
    // Timed out or the connection dropped after the request went out: booking-api may well have
    // committed it. No definitive answer is not proof of failure — "uncertain", the owner checks.
    return { ok: false, taken: false, uncertain: true, error: `no response from booking-api: ${String(e).slice(0, 160)}` };
  }
}

/**
 * What the call has agreed to, if anything is ready to book. Only a slot Clara actually offered
 * (with its exact end, which booking-api requires) can be booked; `requireEmail` holds the booking
 * mid-call until the caller has given an email, so the invite and confirmation reach them.
 */
export function pendingBooking(state: InboundCallState, opts: { requireEmail: boolean }): { slot: BookableSlot; email?: string } | null {
  if (state.line === "work" || state.booking) return null;
  const start = state.learned.bookSlot?.trim();
  if (!start || !state.offeredSlots?.includes(start)) return null;
  const end = state.offeredSlotEnds?.[start];
  if (!end) return null;
  const email = cleanEmail(state.learned.email);
  if (opts.requireEmail && !email) return null;
  return { slot: { start, end }, email };
}

export async function bookFromCall(state: InboundCallState, opts: { requireEmail: boolean }, deps: BookingDeps = defaultDeps): Promise<BusinessBooking | null> {
  const p = pendingBooking(state, opts);
  return p ? bookReady(state, p, deps) : null;
}

/** Books what pendingBooking() returned. Callers claim the call first (booking: pending). */
export async function bookReady(state: InboundCallState, p: { slot: BookableSlot; email?: string }, deps: BookingDeps = defaultDeps): Promise<BusinessBooking> {
  const l = state.learned;
  const notes = [
    "Booked by Clara on the main phone line.",
    l.company ? `Company: ${l.company}` : "",
    l.need ? `Need: ${l.need}` : "",
    l.timeline ? `Timeline: ${l.timeline}` : "",
  ].filter(Boolean).join("\n");
  const r = await bookBusinessSlot({ slot: p.slot, name: l.callerName, email: p.email, phone: state.fromE164, notes }, deps);
  return r.ok
    ? { start: p.slot.start, status: "booked", emailed: Boolean(p.email), meetLink: r.meetLink }
    : { start: p.slot.start, status: r.uncertain ? "uncertain" : r.taken ? "taken" : "failed", error: r.error };
}

// In-flight mid-call bookings, so call finalization (often a hangup's status callback racing the
// turn that's still waiting on booking-api) settles on the real outcome instead of "pending".
const inflight = new Map<string, Promise<BusinessBooking>>();

export function trackBooking(callSid: string, p: Promise<BusinessBooking>): Promise<BusinessBooking> {
  inflight.set(callSid, p);
  p.finally(() => { if (inflight.get(callSid) === p) inflight.delete(callSid); }).catch(() => {});
  return p;
}

/** The in-flight booking's outcome, or null if none is running or it doesn't settle in time. */
export async function settleInflightBooking(callSid: string, timeoutMs = 20_000): Promise<BusinessBooking | null> {
  const p = inflight.get(callSid);
  if (!p) return null;
  return Promise.race([p.catch(() => null), new Promise<null>((r) => setTimeout(() => r(null), timeoutMs))]);
}

/** What the caller hears when a mid-call booking didn't simply succeed. */
export function bookingFallbackLine(status: BusinessBooking["status"], hangup: boolean): string {
  const end = hangup ? "Thanks for calling." : "Is there anything else I can help with?";
  if (status === "pending") return `I'm locking that time in now, and the team will confirm it with you shortly. ${end}`;
  if (status === "taken") return `I'm sorry — that time was just taken. I'll have the team reach out to find another time that works. ${end}`;
  if (status === "uncertain") return `I've sent that time through, and the team will confirm it with you shortly. ${end}`;
  return `I couldn't lock that time in just now — I'll have the team confirm a time with you. ${end}`;
}
