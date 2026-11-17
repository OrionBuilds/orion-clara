// Clara — event coordination.
//
// Coordination only — the owner decides the concept, Clara creates the calendar event, invites
// attendees, and sends the prep note. Clara has no purchase power, so a venue/caterer that needs
// paying is out of scope here — that's coordinated the same way any local business is: an
// approved business call (see business-calls.ts), separately from calendar logistics.

import { bookEvent } from "./ms-calendar";
import type { PrincipalId } from "./types";
import type { MAccount } from "./ms-auth";

export interface EventPlan {
  requestor: PrincipalId;
  onCalendar: MAccount;         // "work"
  title: string;
  startISO: string;
  endISO: string;
  location?: string;
  attendees?: string[];
  prepNote?: string;            // sent to attendees as invite body
}

export async function coordinate(plan: EventPlan): Promise<{ ok: boolean; eventId?: string; error?: string }> {
  const res = await bookEvent({
    requestor: plan.requestor,
    onCalendar: plan.onCalendar,
    summary: plan.title,
    startISO: plan.startISO,
    endISO: plan.endISO,
    attendees: plan.attendees,
    description: [plan.location ? `Location: ${plan.location}` : "", plan.prepNote ?? ""].filter(Boolean).join("\n\n"),
    external: (plan.attendees?.length ?? 0) > 0,
  });
  return { ok: res.ok, eventId: res.id, error: res.error };
}
