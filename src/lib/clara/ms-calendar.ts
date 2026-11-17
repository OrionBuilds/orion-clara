// Clara Calendar — thin layer on top of Microsoft Graph (Outlook Calendar + Teams) with Clara's
// tier + principal guards. Graph replacement for calendar.ts (Google Calendar); same names, same
// call signatures, same external behavior — only the wire format and a few Graph-specific
// semantics (noted inline) differ.
//
// - the owner's work calendar: full authority (book/move/decline).

import { mfetch, type MAccount } from "./ms-auth";
import { can } from "./tiers";
import type { PrincipalId } from "./types";
import { append as ledgerAppend } from "./ledger";

const BASE = "https://graph.microsoft.com/v1.0/me";

// Graph requires an explicit IANA/Windows timeZone string on every start/end (unlike Google, which
// infers the zone from the dateTime's own offset). usage.ts already has a single source of truth
// for the owner's zone (the CLARA_TZ env var, defaulting to "America/New_York") — reuse that exact
// pattern here instead of hardcoding UTC blindly.
const OWNER_TZ = process.env.CLARA_TZ?.trim() || "America/New_York";

export interface CalEvent {
  id: string;
  summary: string;
  start: string;
  end: string;
  attendees?: string[];
  description?: string;
  hangoutLink?: string;
  calendarOwner: MAccount;
}

interface RawEvent {
  id: string;
  subject?: string;
  start?: { dateTime?: string; timeZone?: string };
  end?: { dateTime?: string; timeZone?: string };
  attendees?: { emailAddress: { address: string } }[];
  body?: { content?: string };
  bodyPreview?: string;
  onlineMeeting?: { joinUrl?: string };
  /** Graph's single free/busy signal — "free"/"tentative"/"busy"/"oof"/"workingElsewhere". There
   *  is no separate Google-style status/transparency pair; see pickBusyEvent below. */
  showAs?: string;
  /** Some Graph endpoints surface a cancelled single instance this way rather than omitting it
   *  outright — Google instead gives cancelled instances status: "cancelled". */
  isCancelled?: boolean;
}

export async function listUpcoming(opts: {
  account?: MAccount;
  timeMin?: string;
  timeMax?: string;
  max?: number;
} = {}): Promise<CalEvent[]> {
  const account = opts.account ?? "work";
  // calendarView is Graph's equivalent of Google's singleEvents=true — recurring events are
  // already expanded into instances. Unlike Google's optional timeMax, Graph requires BOTH bounds,
  // so default the far end to a year out when the caller didn't supply one.
  const timeMin = opts.timeMin ?? new Date().toISOString();
  const timeMax = opts.timeMax ?? new Date(Date.now() + 365 * 86_400_000).toISOString();
  const p = new URLSearchParams({
    startDateTime: timeMin,
    endDateTime: timeMax,
    $orderby: "start/dateTime",
    $top: String(opts.max ?? 20),
  });
  const r = await mfetch(`${BASE}/calendarView?${p.toString()}`, {}, account);
  if (!r.ok) return [];
  const j = await r.json() as { value?: RawEvent[] };
  return (j.value ?? []).map((e) => ({
    id: e.id,
    summary: e.subject ?? "(no title)",
    start: e.start?.dateTime ?? "",
    end:   e.end?.dateTime   ?? "",
    attendees: (e.attendees ?? []).map((a) => a.emailAddress.address),
    description: e.body?.content ?? e.bodyPreview,
    hangoutLink: e.onlineMeeting?.joinUrl,
    calendarOwner: account,
  }));
}

// Next-N days on the work calendar. Named/shaped as before (every caller — briefs, alerts,
// weeklyPlanning's conflict scan, the list_calendar tool — goes through this one function, so
// changing its body here is the single, low-risk place to change what Clara considers). Clara is
// an executive assistant for business tasks only, so this reads the owner's work calendar and
// nothing else.
export async function combinedUpcoming(days = 7): Promise<CalEvent[]> {
  const now = new Date();
  const later = new Date(now.getTime() + days * 86_400_000);
  return (await listUpcoming({ account: "work", timeMin: now.toISOString(), timeMax: later.toISOString(), max: 100 }).catch(() => []))
    .sort((a, b) => a.start.localeCompare(b.start));
}

// Autonomy Spec v0.1, item #2: every event Clara books gets an agenda in the description, so
// the owner always knows what they're walking into. `book_event`/`book_appointment`/`coordinate_event`
// all require the field at the schema level now, so this is a safety net for whatever the model
// omits anyway — never a silent blank.
export function ensureAgenda(description: string | undefined, ctx: { title: string; attendees?: string[] }): string {
  const trimmed = (description ?? "").trim();
  if (trimmed) return trimmed;
  const who = ctx.attendees?.length ? ` with ${ctx.attendees.join(", ")}` : "";
  return `Discussing: ${ctx.title}${who}`;
}

// Book an event on the owner's work calendar. Enforces principal + tier rules.
export async function bookEvent(input: {
  requestor: PrincipalId;
  onCalendar: MAccount;
  summary: string;
  startISO: string;
  endISO: string;
  attendees?: string[];
  description?: string;
  withMeet?: boolean;
  external: boolean;  // meeting with external (non-owner) attendees?
}): Promise<{ ok: boolean; id?: string; link?: string; meet?: string; error?: string }> {
  const category = input.external ? "calendar.external" : "calendar.internal";
  const decision = await can(input.requestor, category);
  if (!decision.allow) {
    return { ok: false, error: `blocked by tier: ${decision.reason}` };
  }

  const body: Record<string, unknown> = {
    subject: input.summary,
    body: { contentType: "text", content: ensureAgenda(input.description, { title: input.summary, attendees: input.attendees }) },
    start: { dateTime: input.startISO, timeZone: OWNER_TZ },
    end:   { dateTime: input.endISO,   timeZone: OWNER_TZ },
    attendees: (input.attendees ?? []).map((email) => ({ emailAddress: { address: email }, type: "required" })),
  };
  if (input.withMeet) {
    // Graph's equivalent of Google's conferenceData.createRequest: ask Graph to auto-provision the
    // Teams meeting on the SAME create-event call — it comes back on `onlineMeeting.joinUrl`, no
    // separate conference-creation round trip needed.
    body.isOnlineMeeting = true;
    body.onlineMeetingProvider = "teamsForBusiness";
  }

  // Graph always notifies attendees on event creation — there's no sendUpdates param to set here;
  // this call IS the sendUpdates=all behavior, just implicit rather than a query param.
  const r = await mfetch(
    `${BASE}/events`,
    { method: "POST", body: JSON.stringify(body) },
    input.onCalendar,
  );
  if (!r.ok) {
    return { ok: false, error: `calendar book ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}` };
  }
  const j = await r.json() as { id: string; webLink?: string; onlineMeeting?: { joinUrl?: string } };
  await ledgerAppend({
    kind: "booking",
    actor: "clara",
    what: `booked "${input.summary}" on ${input.onCalendar} calendar (${input.startISO} → ${input.endISO})`,
    ref: j.id,
  });
  return { ok: true, id: j.id, link: j.webLink, meet: j.onlineMeeting?.joinUrl };
}

export async function moveEvent(id: string, patch: {
  requestor: PrincipalId;
  onCalendar: MAccount;
  startISO?: string;
  endISO?: string;
  summary?: string;
}): Promise<{ ok: boolean; error?: string }> {
  const body: Record<string, unknown> = {};
  if (patch.startISO) body.start = { dateTime: patch.startISO, timeZone: OWNER_TZ };
  if (patch.endISO) body.end = { dateTime: patch.endISO, timeZone: OWNER_TZ };
  if (patch.summary) body.subject = patch.summary;
  const r = await mfetch(
    `${BASE}/events/${id}`,
    { method: "PATCH", body: JSON.stringify(body) },
    patch.onCalendar,
  );
  if (!r.ok) return { ok: false, error: `calendar move ${r.status}` };
  await ledgerAppend({
    kind: "booking",
    actor: "clara",
    what: `moved event ${id} on ${patch.onCalendar}`,
    ref: id,
    meta: patch,
  });
  return { ok: true };
}

export async function cancelEvent(id: string, opts: { requestor: PrincipalId; onCalendar: MAccount }): Promise<{ ok: boolean; error?: string }> {
  // Graph's /cancel action sends attendees a cancellation message and removes the event in one
  // call — the real analogue of Google's sendUpdates=all DELETE. A raw DELETE would silently drop
  // the event off the calendar with no notification to anyone, which is NOT what cancelEvent's
  // callers expect. /cancel does require the signed-in account to be the organizer, which holds
  // for everything Clara books on her own work calendar.
  const r = await mfetch(
    `${BASE}/events/${id}/cancel`,
    { method: "POST" },
    opts.onCalendar,
  );
  if (!r.ok) return { ok: false, error: `calendar cancel ${r.status}` };
  await ledgerAppend({
    kind: "booking",
    actor: "clara",
    what: `cancelled event ${id} on ${opts.onCalendar}`,
    ref: id,
  });
  return { ok: true };
}

export async function freeBusy(timeMinISO: string, timeMaxISO: string, account: MAccount = "work"): Promise<{ start: string; end: string }[]> {
  // Graph's getSchedule has no "primary"/"me" alias the way Google's freeBusy does — the
  // `schedules` array wants a real SMTP address, so resolve the mailbox's own address first.
  const meR = await mfetch(`${BASE}?$select=mail,userPrincipalName`, {}, account);
  if (!meR.ok) return [];
  const me = await meR.json() as { mail?: string; userPrincipalName?: string };
  const address = me.mail ?? me.userPrincipalName;
  if (!address) return [];

  const r = await mfetch(`${BASE}/calendar/getSchedule`, {
    method: "POST",
    body: JSON.stringify({
      schedules: [address],
      startTime: { dateTime: timeMinISO, timeZone: OWNER_TZ },
      endTime: { dateTime: timeMaxISO, timeZone: OWNER_TZ },
    }),
  }, account);
  if (!r.ok) return [];
  const j = await r.json() as { value?: { scheduleItems?: { start?: { dateTime?: string }; end?: { dateTime?: string } }[] }[] };
  const items = j.value?.[0]?.scheduleItems ?? [];
  return items
    .filter((it) => it.start?.dateTime && it.end?.dateTime)
    .map((it) => ({ start: it.start!.dateTime!, end: it.end!.dateTime! }));
}

// ── VIP transfer gating (2026-10-01) ────────────────────────────────────────────────────────────
//
// A transfer-tier VIP calling the work line is declined-with-a-reason, not rung, while the owner is in a
// "busy" event on their primary calendar. Looks back 14 days so a multi-day OOO/PTO event that
// started earlier still matches today.

const BUSY_LOOKBACK_MS = 14 * 86_400_000;
const BUSY_LOOKAHEAD_MS = 60_000;
export const BUSY_EVENT_TIMEOUT_MS = 2_000;

/** Pure: of the (already calendarView-expanded) raw items, the one truly blocking `nowIso`, if any. */
export function pickBusyEvent(items: RawEvent[], nowIso: string): CalEvent | null {
  const nowMs = new Date(nowIso).getTime();
  for (const e of items) {
    const startISO = e.start?.dateTime;
    const endISO = e.end?.dateTime;
    if (!startISO || !endISO) continue;
    const startMs = new Date(startISO).getTime();
    const endMs = new Date(endISO).getTime();
    if (!(startMs <= nowMs && nowMs < endMs)) continue;
    if (e.isCancelled) continue;
    // Graph has no separate status/transparency pair the way Google does — showAs is the single
    // free/busy signal. Preserve the ORIGINAL policy exactly: Google only blocked on
    // status:"confirmed" + transparency:"opaque", explicitly exempting a tentative event from
    // ever blocking a VIP transfer. Graph's showAs has a genuine "tentative" value, so map it the
    // same way — "free" and "tentative" both let a VIP through; "busy"/"oof"/"workingElsewhere"
    // (or the field being absent, Google's own default-blocks case) block, same as before.
    if (e.showAs === "free" || e.showAs === "tentative") continue;
    return {
      id: e.id,
      summary: e.subject ?? "(no title)",
      start: startISO,
      end: endISO,
      attendees: (e.attendees ?? []).map((a) => a.emailAddress.address),
      description: e.body?.content ?? e.bodyPreview,
      hangoutLink: e.onlineMeeting?.joinUrl,
      calendarOwner: "work",
    };
  }
  return null;
}

async function fetchEventsAround(nowIso: string): Promise<RawEvent[]> {
  const now = new Date(nowIso).getTime();
  const p = new URLSearchParams({
    startDateTime: new Date(now - BUSY_LOOKBACK_MS).toISOString(),
    endDateTime: new Date(now + BUSY_LOOKAHEAD_MS).toISOString(),
    $orderby: "start/dateTime",
    $top: "100",
  });
  const r = await mfetch(`${BASE}/calendarView?${p.toString()}`, {}, "work");
  if (!r.ok) throw new Error(`calendar busy-check ${r.status}`);
  const j = await r.json() as { value?: RawEvent[] };
  return j.value ?? [];
}

/**
 * The busy event blocking `nowIso` on the owner's primary calendar, or null when they're free. Fails open
 * (returns null, never throws) on any error OR after a 2s timeout — a slow or down Graph must
 * never cost a VIP their warm transfer.
 */
export async function busyEvent(
  nowIso: string = new Date().toISOString(),
  deps: { fetchEvents?: () => Promise<RawEvent[]>; timeoutMs?: number } = {},
): Promise<CalEvent | null> {
  const fetchEvents = deps.fetchEvents ?? (() => fetchEventsAround(nowIso));
  const timeoutMs = deps.timeoutMs ?? BUSY_EVENT_TIMEOUT_MS;
  try {
    const items = await Promise.race([
      fetchEvents(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ]);
    if (!items) return null; // timed out
    return pickBusyEvent(items, nowIso);
  } catch {
    return null; // fail open — never block a VIP's transfer because Graph was slow or erroring
  }
}

// Find first open `durationMin` slot in [from, to] within business hours, skipping busy periods.
export function firstFreeSlot(
  busy: { start: string; end: string }[],
  from: Date, to: Date, durationMin: number,
  dayStartHour = 9, dayEndHour = 17,
): Date | null {
  const slotMs = durationMin * 60_000;
  const busyRanges = busy
    .map((b) => [new Date(b.start).getTime(), new Date(b.end).getTime()] as [number, number])
    .sort((a, b) => a[0] - b[0]);
  const cur = new Date(from);
  cur.setSeconds(0, 0);
  const end = to.getTime();
  let guard = 0;
  while (cur.getTime() + slotMs <= end && guard++ < 5000) {
    const h = cur.getHours();
    if (h < dayStartHour) { cur.setHours(dayStartHour, 0, 0, 0); continue; }
    if (h >= dayEndHour)   { cur.setDate(cur.getDate() + 1); cur.setHours(dayStartHour, 0, 0, 0); continue; }
    const s = cur.getTime(), e = s + slotMs;
    const clash = busyRanges.find(([bs, be]) => s < be && e > bs);
    if (clash) { cur.setTime(clash[1]); continue; }
    return new Date(s);
  }
  return null;
}
