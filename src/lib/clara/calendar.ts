// Clara Calendar — thin layer on top of Google Calendar with Clara's tier + principal guards.
//
// - the owner's work calendar: full authority (book/move/decline), gated by tiers.

import { gfetch, type GAccount } from "./google-auth";
import { can } from "./tiers";
import type { PrincipalId } from "./types";
import { append as ledgerAppend } from "./ledger";
import { OWNER_FIRST } from "./owner";

const BASE = "https://www.googleapis.com/calendar/v3";

export interface CalEvent {
  id: string;
  summary: string;
  start: string;
  end: string;
  attendees?: string[];
  description?: string;
  hangoutLink?: string;
  calendarOwner: GAccount;
}

interface RawEvent {
  id: string;
  summary?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  attendees?: { email: string }[];
  description?: string;
  hangoutLink?: string;
  /** Google default is "confirmed"; a tentative/cancelled event never blocks a transfer. */
  status?: string;
  /** Google default is "opaque" (busy). "transparent" ("Free" in the UI) never blocks a transfer. */
  transparency?: string;
}

export async function listUpcoming(opts: {
  account?: GAccount;
  timeMin?: string;
  timeMax?: string;
  max?: number;
} = {}): Promise<CalEvent[]> {
  const account = opts.account ?? "work";
  const p = new URLSearchParams({
    timeMin: opts.timeMin ?? new Date().toISOString(),
    ...(opts.timeMax ? { timeMax: opts.timeMax } : {}),
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: String(opts.max ?? 20),
  });
  const r = await gfetch(`${BASE}/calendars/primary/events?${p.toString()}`, {}, account);
  if (!r.ok) return [];
  const j = await r.json() as { items?: RawEvent[] };
  return (j.items ?? []).map((e) => ({
    id: e.id,
    summary: e.summary ?? "(no title)",
    start: e.start?.dateTime ?? e.start?.date ?? "",
    end:   e.end?.dateTime   ?? e.end?.date   ?? "",
    attendees: (e.attendees ?? []).map((a) => a.email),
    description: e.description,
    hangoutLink: e.hangoutLink,
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
  onCalendar: GAccount;
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
    summary: input.summary,
    description: ensureAgenda(input.description, { title: input.summary, attendees: input.attendees }),
    start: { dateTime: input.startISO },
    end:   { dateTime: input.endISO },
    attendees: (input.attendees ?? []).map((email) => ({ email })),
  };
  if (input.withMeet) {
    body.conferenceData = {
      createRequest: { requestId: `clara-${Date.now()}`, conferenceSolutionKey: { type: "hangoutsMeet" } },
    };
  }

  const r = await gfetch(
    `${BASE}/calendars/primary/events?conferenceDataVersion=1&sendUpdates=all`,
    { method: "POST", body: JSON.stringify(body) },
    input.onCalendar,
  );
  if (!r.ok) {
    return { ok: false, error: `calendar book ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}` };
  }
  const j = await r.json() as { id: string; htmlLink?: string; hangoutLink?: string };
  await ledgerAppend({
    kind: "booking",
    actor: "clara",
    what: `booked "${input.summary}" on ${input.onCalendar} calendar (${input.startISO} → ${input.endISO})`,
    ref: j.id,
  });
  return { ok: true, id: j.id, link: j.htmlLink, meet: j.hangoutLink };
}

export async function moveEvent(id: string, patch: {
  requestor: PrincipalId;
  onCalendar: GAccount;
  startISO?: string;
  endISO?: string;
  summary?: string;
}): Promise<{ ok: boolean; error?: string }> {
  const body: Record<string, unknown> = {};
  if (patch.startISO) body.start = { dateTime: patch.startISO };
  if (patch.endISO) body.end = { dateTime: patch.endISO };
  if (patch.summary) body.summary = patch.summary;
  const r = await gfetch(
    `${BASE}/calendars/primary/events/${id}?sendUpdates=all`,
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

export async function cancelEvent(id: string, opts: { requestor: PrincipalId; onCalendar: GAccount }): Promise<{ ok: boolean; error?: string }> {
  const r = await gfetch(
    `${BASE}/calendars/primary/events/${id}?sendUpdates=all`,
    { method: "DELETE" },
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

export async function freeBusy(timeMinISO: string, timeMaxISO: string, account: GAccount = "work"): Promise<{ start: string; end: string }[]> {
  const r = await gfetch(`${BASE}/freeBusy`, {
    method: "POST",
    body: JSON.stringify({ timeMin: timeMinISO, timeMax: timeMaxISO, items: [{ id: "primary" }] }),
  }, account);
  if (!r.ok) return [];
  const j = await r.json() as { calendars?: { primary?: { busy?: { start: string; end: string }[] } } };
  return j.calendars?.primary?.busy ?? [];
}

// ── VIP transfer gating (2026-10-01) ────────────────────────────────────────────────────────────
//
// A transfer-tier VIP calling the work line is declined-with-a-reason, not rung, while the owner is in a
// "busy" event on their primary calendar: status "confirmed" AND transparency not "transparent"
// (Google's own default is busy, so most events qualify; an explicitly "Free" event never blocks).
// Looks back 14 days so a multi-day OOO/PTO event that started earlier still matches today.

const BUSY_LOOKBACK_MS = 14 * 86_400_000;
const BUSY_LOOKAHEAD_MS = 60_000;
export const BUSY_EVENT_TIMEOUT_MS = 2_000;

/** Pure: of the (already singleEvents-expanded) raw items, the one truly blocking `nowIso`, if any. */
export function pickBusyEvent(items: RawEvent[], nowIso: string): CalEvent | null {
  const nowMs = new Date(nowIso).getTime();
  for (const e of items) {
    const startISO = e.start?.dateTime ?? e.start?.date;
    const endISO = e.end?.dateTime ?? e.end?.date;
    if (!startISO || !endISO) continue;
    const startMs = new Date(startISO).getTime();
    const endMs = new Date(endISO).getTime();
    if (!(startMs <= nowMs && nowMs < endMs)) continue;
    if ((e.status ?? "confirmed") !== "confirmed") continue;
    if (e.transparency === "transparent") continue;
    return {
      id: e.id,
      summary: e.summary ?? "(no title)",
      start: startISO,
      end: endISO,
      attendees: (e.attendees ?? []).map((a) => a.email),
      description: e.description,
      hangoutLink: e.hangoutLink,
      calendarOwner: "work",
    };
  }
  return null;
}

async function fetchEventsAround(nowIso: string): Promise<RawEvent[]> {
  const now = new Date(nowIso).getTime();
  const p = new URLSearchParams({
    timeMin: new Date(now - BUSY_LOOKBACK_MS).toISOString(),
    timeMax: new Date(now + BUSY_LOOKAHEAD_MS).toISOString(),
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: "100",
  });
  const r = await gfetch(`${BASE}/calendars/primary/events?${p.toString()}`, {}, "work");
  if (!r.ok) throw new Error(`calendar busy-check ${r.status}`);
  const j = await r.json() as { items?: RawEvent[] };
  return j.items ?? [];
}

/**
 * The busy event blocking `nowIso` on the owner's primary calendar, or null when they're free. Fails open
 * (returns null, never throws) on any error OR after a 2s timeout — a slow or down Google Calendar
 * must never cost a VIP their warm transfer.
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
    return null; // fail open — never block a VIP's transfer because Google was slow or erroring
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
