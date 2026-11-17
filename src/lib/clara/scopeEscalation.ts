// Clara — out-of-scope-work escalation (Autonomy Spec v0.1, item #8).
//
// A client asks for work outside their contract. Clara texts three options — [book a call] /
// [do it anyway] / [decline] — and unlike every other approval kind, the decision comes back
// from the CLIENT's own reply, not the owner tapping approve/reject. Silence past the SLA
// (slaTimer.ts, business-hours 2h / client-waiting 30min) defaults to "call": never silently
// commit the owner to new billable work, but never leave a real client hanging on a maybe either.
//
// "do it anyway" is deliberately NOT auto-executed — new work outside the contract is a money/
// scope decision, squarely on persona.md's always-surface list, so it becomes a fresh approval
// for the owner instead of running on the client's say-so alone. "call" is the one branch safe enough
// to fully automate: booking the owner's own time is low-risk and reversible, so it goes straight onto
// their real Google Calendar (bookEvent — see the owner's "use the Google API over the OS" note) rather
// than through another approval round-trip.

import { draft, approve, setScopeDecision, listPending, type Approval, type ScopeOutOfBoundsPayload } from "./approvals";
import { sendSMS } from "./channels";
import { notifyOwner } from "./notify";
import { bookEvent, ensureAgenda } from "./ms-calendar";
import { OWNER_FIRST } from "./owner";

const CLIENT_DECLINE_RX = /\b(no thanks|no,?|decline|not (now|needed|interested)|skip|never ?mind|forget it)\b/i;
const CLIENT_ANYWAY_RX = /\b(anyway|go ahead|do it|yes please|proceed|please do)\b/i;
const CLIENT_CALL_RX = /\b(call|talk|discuss|phone|chat)\b/i;

export async function draftScopeEscalation(input: {
  clientContact: string; requestText: string; contractId?: string; clientLabel?: string;
}): Promise<Approval> {
  const payload: ScopeOutOfBoundsPayload = {
    clientContact: input.clientContact,
    requestText: input.requestText,
    contractId: input.contractId,
  };
  const row = await draft({
    kind: "scope.out-of-bounds",
    title: `Out-of-scope request${input.clientLabel ? ` — ${input.clientLabel}` : ""}`,
    summary: input.requestText.slice(0, 300),
    requestor: "clara",
    origin: "external",
    intent: payload,
    // A real client is on the other end of this — the generic approval-nudge scan (item #5)
    // should use its 30min "client waiting" threshold if it ever sees this row, not the 2h
    // business-hours default. In the common case scope-escalation-timeout resolves it first.
    clientWaiting: true,
  });

  await sendSMS(
    input.clientContact,
    `Thanks for the ask — that's outside our current agreement. Want to (1) book a quick call to scope it, (2) have me go ahead anyway, or (3) skip it for now? Reply with what works.`,
  ).catch(() => {});
  await notifyOwner({
    kind: "scope.escalation",
    priority: "normal",
    text: `A client asked for out-of-scope work: "${input.requestText.slice(0, 200)}". Texted them the 3 options — no reply in the SLA window defaults to booking a call.`,
    dedupeKey: `scope-escalation:${row.id}`,
  }).catch(() => {});

  return row;
}

/** Parses a client's free-text reply into a decision, or null if it matches none of the three. */
export function parseClientScopeReply(text: string): "call" | "anyway" | "decline" | null {
  const t = text.trim();
  if (!t) return null;
  const digit = t.match(/^[\(\[]?([123])[\)\].]?\s*$/);
  if (digit) return digit[1] === "1" ? "call" : digit[1] === "2" ? "anyway" : "decline";
  // Decline checked first — "no, don't go ahead" must not fall into the anyway pattern.
  if (CLIENT_DECLINE_RX.test(t)) return "decline";
  if (CLIENT_ANYWAY_RX.test(t)) return "anyway";
  if (CLIENT_CALL_RX.test(t)) return "call";
  return null;
}

/** The pending scope-escalation row waiting on a reply from this specific number/address, if any. */
export async function findPendingScopeEscalationFor(clientContact: string): Promise<Approval | null> {
  const pending = await listPending();
  return pending.find((a) => a.kind === "scope.out-of-bounds" && (a.intent as ScopeOutOfBoundsPayload).clientContact === clientContact) ?? null;
}

/** Resolves a pending row from a client reply or the SLA-timeout default, then runs the decision. */
export async function resolveScopeEscalation(id: string, decision: "call" | "anyway" | "decline"): Promise<Approval | null> {
  const stamped = await setScopeDecision(id, decision);
  if (!stamped) return null;
  return approve(id); // approve() re-loads the row (now carrying the decision) and calls execute()
}

/** execute() case for kind "scope.out-of-bounds" — called by approvals.ts, never directly. */
export async function executeScopeDecision(row: Approval): Promise<{ ok: boolean; error?: string; ref?: string }> {
  const p = row.intent as ScopeOutOfBoundsPayload;
  switch (p.decision) {
    case "call": {
      const start = new Date(Date.now() + 24 * 3_600_000); // next-business-day placeholder slot
      start.setHours(10, 0, 0, 0);
      const end = new Date(start.getTime() + 30 * 60_000);
      const r = await bookEvent({
        requestor: "owner",
        onCalendar: "work",
        summary: `Call: out-of-scope request${row.title.includes("—") ? row.title.slice(row.title.indexOf("—")) : ""}`,
        startISO: start.toISOString(),
        endISO: end.toISOString(),
        description: ensureAgenda(p.requestText, { title: "Out-of-scope work discussion" }),
        external: true,
      });
      if (!r.ok) return { ok: false, error: r.error };
      await sendSMS(p.clientContact, `Booked a call to go over this — ${OWNER_FIRST} will follow up with a confirmed time.`).catch(() => {});
      await notifyOwner({
        kind: "scope.escalation",
        priority: "normal",
        text: `Placeholder call booked for the out-of-scope request: "${p.requestText.slice(0, 150)}" — move it to a real slot when you confirm with the client.`,
        dedupeKey: `scope-escalation-booked:${row.id}`,
      }).catch(() => {});
      return { ok: true, ref: r.id };
    }
    case "anyway": {
      // New scope/money decision — surfaces to the owner rather than auto-running. persona.md's
      // always-surface list: money, contracts, and anything a client asked for outside what was
      // already agreed.
      await notifyOwner({
        kind: "scope.escalation",
        priority: "normal",
        text: `Client said "go ahead anyway" on out-of-scope work: "${p.requestText.slice(0, 200)}". This needs your OK before it's dispatched — nothing has started.`,
        dedupeKey: `scope-escalation-anyway:${row.id}`,
      }).catch(() => {});
      await sendSMS(p.clientContact, `Got it — checking with the team and I'll confirm shortly.`).catch(() => {});
      return { ok: true };
    }
    case "decline": {
      await sendSMS(p.clientContact, `Understood — we'll leave it for now. Let us know if that changes.`).catch(() => {});
      return { ok: true };
    }
    default:
      return { ok: false, error: "scope.out-of-bounds executed with no decision set" };
  }
}
