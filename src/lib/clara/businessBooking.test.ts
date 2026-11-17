import { test } from "node:test";
import assert from "node:assert/strict";
import { pickSpread, businessSlots, bookBusinessSlot, pendingBooking, bookFromCall, cleanEmail, trackBooking, settleInflightBooking, bookingFallbackLine, speakBookingSlot, BOOKING_TURN_DEADLINE_MS, type BookingDeps, type BusinessBooking } from "./businessBooking";
import { businessCalendarBlock, summarize } from "./inbound-call-brain";
import type { InboundCallState } from "./call-sessions";

process.env.ORION_SUPABASE_URL = "https://os.example.supabase.co";
process.env.CLARA_BOOKING_CALENDAR_ID = "11111111-2222-4333-8444-555555555555";
process.env.CLARA_BOOKING_TYPE_ID = "66666666-7777-4888-8999-000000000000";
const NOW = new Date("2026-10-09T20:00:00Z"); // Fri 4pm ET

const slot = (start: string, mins = 30) => ({ start, end: new Date(Date.parse(start) + mins * 60_000).toISOString() });

function deps(handler: (url: string, init?: RequestInit) => Response): BookingDeps & { calls: Array<{ url: string; init?: RequestInit }> } {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  return { calls, now: () => NOW, fetch: (async (url: string, init?: RequestInit) => { calls.push({ url, init }); return handler(url, init); }) as typeof fetch };
}

function call(over: Partial<InboundCallState> = {}): InboundCallState {
  const s = slot("2026-10-12T13:00:00.000Z");
  return {
    callSid: "CA1", fromE164: "+18135550100", turns: [], learned: {}, status: "in-progress",
    startedAt: NOW.toISOString(), updatedAt: NOW.toISOString(), line: "business",
    offeredSlots: [s.start], offeredSlotEnds: { [s.start]: s.end }, ...over,
  };
}

test("pickSpread: one slot per day first, within 7 days, future only, sorted", () => {
  const slots = [
    slot("2026-10-09T19:00:00.000Z"), // past
    slot("2026-10-12T13:00:00.000Z"), slot("2026-10-12T14:00:00.000Z"),
    slot("2026-10-13T15:00:00.000Z"), slot("2026-10-14T13:00:00.000Z"),
    slot("2026-10-20T13:00:00.000Z"), // > 7 days out
  ];
  assert.deepEqual(pickSpread(slots, 3, NOW).map((s) => s.start), ["2026-10-12T13:00:00.000Z", "2026-10-13T15:00:00.000Z", "2026-10-14T13:00:00.000Z"]);
  assert.deepEqual(pickSpread(slots.slice(0, 3), 3, NOW).map((s) => s.start), ["2026-10-12T13:00:00.000Z", "2026-10-12T14:00:00.000Z"]);
});

test("businessSlots asks booking-api for the website's calendar and type, and fails soft", async () => {
  const d = deps(() => new Response(JSON.stringify({ slots: [slot("2026-10-12T13:00:00.000Z")] })));
  const got = await businessSlots(3, d);
  assert.equal(got.length, 1);
  const u = new URL(d.calls[0].url);
  assert.equal(u.pathname, "/functions/v1/booking-api/availability");
  assert.equal(u.searchParams.get("calendar_id"), "11111111-2222-4333-8444-555555555555");
  assert.equal(u.searchParams.get("type_id"), "66666666-7777-4888-8999-000000000000");
  assert.equal(u.searchParams.get("start_date"), "2026-10-09");
  assert.deepEqual(await businessSlots(3, deps(() => new Response("nope", { status: 500 }))), []);
  assert.deepEqual(await businessSlots(3, { now: () => NOW, fetch: (async () => { throw new Error("down"); }) as typeof fetch }), []);
});

test("bookBusinessSlot posts the exact slot; 409 is 'taken'; no email means none is sent", async () => {
  const s = slot("2026-10-12T13:00:00.000Z");
  const ok = deps(() => new Response(JSON.stringify({ success: true, appointment: { id: "a1", google_meet_link: "https://meet/x" } })));
  assert.deepEqual(await bookBusinessSlot({ slot: s, name: "Jane", phone: "+1813", email: "jane@acme.com" }, ok), { ok: true, appointmentId: "a1", meetLink: "https://meet/x" });
  const body = JSON.parse(String(ok.calls[0].init?.body));
  assert.equal(body.start_utc, s.start);
  assert.equal(body.end_utc, s.end);
  assert.deepEqual(body.answers, { name: "Jane", phone: "+1813", email: "jane@acme.com" });
  assert.equal(body._gotcha, undefined, "never trips the honeypot");

  const taken = await bookBusinessSlot({ slot: s, phone: "+1813" }, deps(() => new Response(JSON.stringify({ error: "Slot no longer available" }), { status: 409 })));
  assert.deepEqual(taken, { ok: false, taken: true, error: "Slot no longer available" });
  const phoneOnly = deps(() => new Response(JSON.stringify({ success: true, appointment: {} })));
  await bookBusinessSlot({ slot: s, phone: "+1813" }, phoneOnly);
  assert.equal(JSON.parse(String(phoneOnly.calls[0].init?.body)).answers.email, undefined);
});

test("pendingBooking: only an offered slot, never on the work line, never twice; email gates the mid-call booking", () => {
  const start = "2026-10-12T13:00:00.000Z";
  assert.equal(pendingBooking(call({ learned: { bookSlot: "2026-10-12T15:00:00.000Z", email: "j@a.co" } }), { requireEmail: false }), null, "not offered");
  assert.equal(pendingBooking(call({ line: "work", learned: { bookSlot: start } }), { requireEmail: false }), null);
  assert.equal(pendingBooking(call({ learned: { bookSlot: start }, booking: { start, status: "pending" } }), { requireEmail: false }), null);
  assert.equal(pendingBooking(call({ learned: { bookSlot: start } }), { requireEmail: true }), null, "mid-call waits for an email");
  assert.equal(pendingBooking(call({ learned: { bookSlot: start, email: "jane at acme dot com" } }), { requireEmail: true }), null, "a spoken-form email isn't an email");
  assert.deepEqual(pendingBooking(call({ learned: { bookSlot: start, email: " Jane@Acme.com " } }), { requireEmail: true }), { slot: { start, end: "2026-10-12T13:30:00.000Z" }, email: "jane@acme.com" });
  assert.equal(pendingBooking(call({ learned: { bookSlot: start } }), { requireEmail: false })?.email, undefined, "call end books phone-only");
});

test("bookFromCall carries who/why into the booking notes", async () => {
  const d = deps(() => new Response(JSON.stringify({ success: true, appointment: { id: "a1" } })));
  const b = await bookFromCall(call({ learned: { bookSlot: "2026-10-12T13:00:00.000Z", email: "jane@acme.com", callerName: "Jane", company: "Acme HVAC", need: "missed calls" } }), { requireEmail: true }, d);
  assert.deepEqual(b, { start: "2026-10-12T13:00:00.000Z", status: "booked", emailed: true, meetLink: undefined });
  const answers = JSON.parse(String(d.calls[0].init?.body)).answers;
  assert.equal(answers.name, "Jane");
  assert.match(answers.notes, /Company: Acme HVAC/);
  assert.match(answers.notes, /Need: missed calls/);
});

test("cleanEmail", () => {
  assert.equal(cleanEmail("Jane@Acme.com."), "jane@acme.com");
  assert.equal(cleanEmail("jane at acme dot com"), undefined);
  assert.equal(cleanEmail(undefined), undefined);
});

test("main-line prompt: offers only listed times, then states the real booking outcome", () => {
  const offering = businessCalendarBlock(call());
  assert.match(offering, /2026-10-12T13:00:00.000Z/);
  assert.match(offering, /Never offer or agree to any other time/);
  assert.match(offering, /learned\.bookSlot/);
  assert.match(businessCalendarBlock(call({ offeredSlots: [] })), /can't see the calendar/);
  assert.match(businessCalendarBlock(call({ booking: { start: "2026-10-12T13:00:00.000Z", status: "booked", emailed: true } })), /^BOOKED/);
  assert.match(businessCalendarBlock(call({ booking: { start: "2026-10-12T13:00:00.000Z", status: "taken" } })), /couldn't be booked — someone just took it/);
});

test("the owner's text says what was booked, or that it wasn't", () => {
  assert.match(summarize(call({ learned: { callerName: "Jane", email: "jane@acme.com" }, booking: { start: "2026-10-12T13:00:00.000Z", status: "booked", emailed: true } })), /📅 Booked a 30-min discovery call for Monday,? 9:00 AM Eastern Time \(invite \+ Meet link sent/);
  assert.match(summarize(call({ booking: { start: "2026-10-12T13:00:00.000Z", status: "taken" } })), /⚠ They picked Monday,? 9:00 AM Eastern Time but it couldn't be booked \(slot was taken\)/);
});

test("an unconfirmed 2xx is 'uncertain', never a failure", async () => {
  const s = slot("2026-10-12T13:00:00.000Z");
  const r = await bookBusinessSlot({ slot: s, phone: "+1813" }, deps(() => new Response("not json", { status: 200 })));
  assert.deepEqual(r, { ok: false, taken: false, uncertain: true, error: "booking-api 200 without confirmation" });
  const explicitFail = await bookBusinessSlot({ slot: s, phone: "+1813" }, deps(() => new Response(JSON.stringify({ success: false, error: "nope" }), { status: 200 })));
  assert.equal((explicitFail as { uncertain?: boolean }).uncertain, undefined);
  const b = await bookFromCall(call({ learned: { bookSlot: "2026-10-12T13:00:00.000Z", email: "j@a.co" } }), { requireEmail: true }, deps(() => new Response("{}", { status: 201 })));
  assert.equal(b?.status, "uncertain");
});

test("what the caller hears depends on why the booking didn't go through", () => {
  assert.match(bookingFallbackLine("taken", false), /just taken/);
  assert.doesNotMatch(bookingFallbackLine("failed", false), /taken/);
  assert.match(bookingFallbackLine("failed", true), /couldn't lock that time in.*Thanks for calling/);
  assert.match(bookingFallbackLine("uncertain", false), /team will confirm it/);
  assert.doesNotMatch(bookingFallbackLine("uncertain", false), /couldn't|taken/);
});

test("call finalization can settle an in-flight booking; none or too slow → null", async () => {
  let resolve!: (b: BusinessBooking) => void;
  const p = trackBooking("CA-inflight", new Promise<BusinessBooking>((r) => { resolve = r; }));
  const waiting = settleInflightBooking("CA-inflight", 1_000);
  resolve({ start: "2026-10-12T13:00:00.000Z", status: "booked", emailed: true });
  assert.equal((await waiting)?.status, "booked");
  await p;
  assert.equal(await settleInflightBooking("CA-inflight", 10), null, "cleared once settled");
  trackBooking("CA-slow", new Promise<BusinessBooking>(() => {}));
  assert.equal(await settleInflightBooking("CA-slow", 10), null);
});

test("prompt never claims an email-less pick is booked; pending/uncertain states are honest", () => {
  const offering = businessCalendarBlock(call());
  assert.match(offering, /Don't say it's booked/);
  assert.doesNotMatch(offering, /it's still booked/);
  assert.match(businessCalendarBlock(call({ booking: { start: "2026-10-12T13:00:00.000Z", status: "pending" } })), /Don't say it's confirmed yet/);
  assert.match(businessCalendarBlock(call({ booking: { start: "2026-10-12T13:00:00.000Z", status: "uncertain" } })), /don't say it's booked or that it failed/);
  assert.match(summarize(call({ booking: { start: "2026-10-12T13:00:00.000Z", status: "uncertain" } })), /sent but not confirmed/);
  assert.match(summarize(call({ booking: { start: "2026-10-12T13:00:00.000Z", status: "pending" } })), /still in progress when the call ended/);
});

test("an interrupted booking POST (timeout / dropped connection) is 'uncertain', not 'failed'", async () => {
  const s = slot("2026-10-12T13:00:00.000Z");
  const r = await bookBusinessSlot({ slot: s, phone: "+1813" }, { now: () => NOW, fetch: (async () => { throw new DOMException("The operation was aborted due to timeout", "TimeoutError"); }) as typeof fetch });
  assert.equal(r.ok, false);
  assert.equal((r as { uncertain?: boolean }).uncertain, true);
  const b = await bookFromCall(call({ learned: { bookSlot: s.start } }), { requireEmail: false }, { now: () => NOW, fetch: (async () => { throw new TypeError("fetch failed"); }) as typeof fetch });
  assert.equal(b?.status, "uncertain");
});

test("booking times are spoken in the booking calendar's timezone, with the zone named", () => {
  assert.match(speakBookingSlot("2026-10-12T13:00:00.000Z", "America/New_York"), /^Monday,? 9:00 AM Eastern Time$/);
  assert.match(speakBookingSlot("2026-10-12T13:00:00.000Z", "America/Los_Angeles"), /^Monday,? 6:00 AM Pacific Time$/);
  const prev = process.env.CLARA_BOOKING_TZ;
  process.env.CLARA_BOOKING_TZ = "America/Chicago";
  try {
    assert.match(businessCalendarBlock(call()), /Monday,? 8:00 AM Central Time/);
  } finally {
    if (prev === undefined) delete process.env.CLARA_BOOKING_TZ; else process.env.CLARA_BOOKING_TZ = prev;
  }
});

test("a booking still running at the turn deadline: Clara says she's locking it in, never confirms or fails it", () => {
  assert.ok(BOOKING_TURN_DEADLINE_MS < 15_000, "inside Twilio's 15 s webhook limit");
  assert.match(bookingFallbackLine("pending", false), /locking that time in now/);
  assert.doesNotMatch(bookingFallbackLine("pending", false), /booked|couldn't|taken/);
});
