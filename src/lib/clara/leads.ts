// Clara — writing an inbound lead into the OS.
//
// A qualification call that ends without a CRM row is a call that didn't happen. The text the owner gets
// is the durable record (notify.ts), this is the useful one.
//
// Two deliberate limits, stated rather than hidden:
//
// 1. NO CONTACT IS CREATED FOR AN EMPTY CALL. If Clara learned nothing — wrong number, hangup on
//    the greeting, a bot — nothing is written. webchat-api's handleCreateSession does the opposite
//    (it inserts a "Web Visitor" contact on every anonymous session) and the result is unbounded
//    junk in the CRM. A lead record should mean someone told us something.
//
// 2. DEDUPE IS BY EMAIL OR NAME+COMPANY, NOT PHONE. form-submit dedupes properly via the
//    find_contact_id_by_phone RPC, but that RPC has no MCP tool and contacts_list only searches
//    first_name/last_name/email/company — so a repeat caller who never gives an email can still
//    produce a second contact. Real, small, and worth a follow-up tool rather than a fake fix here.
//
// Why not just POST to form-submit and inherit its dedupe? Its TCPA gate strips `phone` unless a
// form field explicitly carries SMS consent. For a web form that is exactly right. For an inbound
// CALL the phone number is the primary identifier and the whole point of the record, so routing
// voice through that path would throw away the one field that matters.

import { osClient, osEnabled } from "./osClient";
import { append as ledgerAppend } from "./ledger";
import { notifyOwner } from "./notify";
import { claimInboundFinalize, type InboundCallState } from "./call-sessions";
import { summarize } from "./inbound-call-brain";

function unwrap(content: unknown): unknown {
  if (Array.isArray(content)) {
    const first = content.find((c) => c && typeof c === "object" && "text" in (c as object));
    if (first && typeof (first as { text?: unknown }).text === "string") {
      try { return JSON.parse((first as { text: string }).text); } catch { return (first as { text: string }).text; }
    }
  }
  return content;
}

let identity: { user_id: string; organization_id: string } | null = null;
async function whoami(): Promise<{ user_id: string; organization_id: string } | null> {
  if (identity) return identity;
  const parsed = unwrap(await osClient.callTool("agent_whoami", {})) as {
    user_id?: string; organization_id?: string;
  };
  if (parsed?.user_id && parsed?.organization_id) {
    identity = { user_id: parsed.user_id, organization_id: parsed.organization_id };
  }
  return identity;
}

function splitName(full: string): { first_name: string; last_name?: string } {
  const parts = full.trim().split(/\s+/);
  if (parts.length === 1) return { first_name: parts[0] };
  return { first_name: parts.slice(0, -1).join(" "), last_name: parts[parts.length - 1] };
}

/** Best available existing contact, or null. Search is name/email/company only — see header. */
async function findExisting(learned: Record<string, string>): Promise<string | null> {
  const needle = learned.email || learned.callerName || learned.company;
  if (!needle) return null;
  const rows = (unwrap(await osClient.callTool("contacts_list", { search: needle, limit: 5 })) ?? []) as Array<{
    id?: string; email?: string | null; first_name?: string | null; last_name?: string | null; company?: string | null;
  }>;
  if (!Array.isArray(rows) || rows.length === 0) return null;

  // An email match is an identity match. A name match is a guess, so only accept it when the
  // company agrees too — "John Smith" alone is not evidence.
  if (learned.email) {
    const byEmail = rows.find((r) => (r.email ?? "").toLowerCase() === learned.email.toLowerCase());
    if (byEmail?.id) return byEmail.id;
    return null;
  }
  if (learned.callerName && learned.company) {
    const both = rows.find((r) =>
      `${r.first_name ?? ""} ${r.last_name ?? ""}`.trim().toLowerCase() === learned.callerName.toLowerCase() &&
      (r.company ?? "").toLowerCase() === learned.company.toLowerCase());
    if (both?.id) return both.id;
  }
  return null;
}

// "transferred" (Autonomy Spec v0.1, item #10): the warm-transfer succeeded and the owner took the
// call live — distinct from "wants-human" (they weren't reached and need to follow up), because
// paging them critically about a call they were just personally on would be noise, not signal.
export type LeadReason = "qualified" | "wants-human" | "capped" | "blocked" | "transferred";

/**
 * File a finished inbound call as a CRM contact + timeline event.
 *
 * Throws on failure — the caller (the voice route) catches, logs a `degraded: crm-write` ledger
 * line, and keeps the notification. A failed CRM write must never look like a successful one.
 */
export async function fileInboundCallLead(state: InboundCallState, reason: LeadReason): Promise<void> {
  if (!osEnabled()) throw new Error("OS sign-in not completed — lead not filed");

  const learned = state.learned;
  if (Object.keys(learned).length === 0) {
    await ledgerAppend({
      kind: "action", actor: "clara",
      what: `inbound call ${state.callSid} filed no lead — nothing was learned`,
      ref: state.callSid, meta: { skipped: "empty-call" },
    }).catch(() => {});
    return;
  }

  const who = await whoami();
  if (!who) throw new Error("agent_whoami returned no identity");

  let contactId = await findExisting(learned);
  const isNew = !contactId;

  if (!contactId) {
    const name = learned.callerName ? splitName(learned.callerName) : { first_name: "Inbound", last_name: "Caller" };
    const created = unwrap(await osClient.callTool("contacts_create", {
      ...name,
      email: learned.email || undefined,
      // The number they actually called from beats anything they recited mid-call.
      phone: state.fromE164 || learned.callback || undefined,
      company: learned.company || undefined,
      type: "person",
      status: "active",
      source: "inbound_call",
      organization_id: who.organization_id,
    })) as Array<{ id?: string }> | { id?: string };
    contactId = Array.isArray(created) ? created[0]?.id ?? null : created?.id ?? null;
    if (!contactId) throw new Error("contacts_create returned no id");
  }

  await osClient.callTool("contact_timeline_add", {
    contact_id: contactId,
    event_type: "note_added",
    user_id: who.user_id,
    event_data: {
      by: "clara.inbound_call",
      call_sid: state.callSid,
      from: state.fromE164,
      reason,
      turns: state.turns.length,
      learned,
      summary: summarize(state),
    },
  });

  await ledgerAppend({
    kind: "action", actor: "clara",
    what: `inbound lead filed for ${learned.callerName ?? state.fromE164} — ${isNew ? "new" : "existing"} contact ${contactId}`,
    ref: state.callSid,
    meta: { contactId, isNew: String(isNew), reason },
  }).catch(() => {});

  // No opportunity yet: opportunities_create requires a pipeline_id and stage_id, and no default
  // pair is provisioned for inbound calls. Deliberately not guessed — an opportunity in the wrong
  // pipeline is worse than none, because it shows up in a forecast. Provisioned alongside the
  // "Web chat lead" form row.
}

/**
 * End-of-call: claim the finalize slot, text the owner, file the lead.
 *
 * Lives here rather than in the voice route because TWO things end a call and both want to
 * finalize: the brain setting done, and Twilio's end-of-call status callback when the caller simply
 * hangs up. Hangups are the common case — a caller who has said what they came to say does not wait
 * to be dismissed — so the status-callback path is the one that files most real leads.
 * claimInboundFinalize() makes the race safe; whichever arrives first wins and the other no-ops.
 */
export async function finalizeInboundCall(callSid: string, reason: LeadReason): Promise<void> {
  const state = claimInboundFinalize(callSid);
  if (!state) return;

  const learnedAnything = Object.keys(state.learned).length > 0;
  await ledgerAppend({
    kind: "call",
    actor: "clara",
    what: `inbound call from ${state.fromE164} ended (${reason}) — ${learnedAnything ? "lead captured" : "nothing learned"}`,
    ref: callSid,
    meta: { direction: "inbound", context: state.line === "work" ? "inbound-workline" : "inbound-business", reason, ...state.learned },
  }).catch(() => {});

  // The owner's forwarded work phone has its own ending: book, text the owner only if it matters, log it for
  // the brief and their memory (workLineCalls.ts). The business-line paging below doesn't apply.
  if (state.line === "work") {
    const { finalizeWorkLineCall } = await import("./workLineCalls");
    await finalizeWorkLineCall(state, reason).catch((e) => ledgerAppend({
      kind: "action", actor: "clara",
      what: `work-line call ${callSid} finalize failed: ${String(e).slice(0, 160)}`,
      ref: callSid,
    }).catch(() => {}));
    return;
  }

  // Everything below can take a while (waiting on an in-flight booking, booking at call end, the
  // CRM write), and every caller is a Twilio webhook that must answer within 15 s. So it runs off
  // the response path; failures land in the ledger.
  void finishBusinessCall(callSid, state, reason, learnedAnything).catch((e) => ledgerAppend({
    kind: "action", actor: "clara",
    what: `inbound call ${callSid} finalize failed: ${String(e).slice(0, 160)}`,
    ref: callSid,
  }).catch(() => {}));
}

async function finishBusinessCall(callSid: string, state: InboundCallState, reason: LeadReason, learnedAnything: boolean): Promise<void> {
  // A mid-call booking still waiting on booking-api when they hung up: wait (bounded) for its real
  // outcome so the owner's text and the CRM record don't report "pending" as a failure.
  if (state.booking?.status === "pending") {
    const { settleInflightBooking } = await import("./businessBooking");
    const settled = await settleInflightBooking(callSid).catch(() => null);
    if (settled) state.booking = settled;
  }

  // Main line: they picked an offered time but never gave an email (or hung up first) — book it
  // phone-only now so the time is held; the text to the owner says to confirm with them by phone.
  if (!state.booking) {
    const { bookFromCall } = await import("./businessBooking");
    const booking = await bookFromCall(state, { requireEmail: false }).catch(() => null);
    if (booking) {
      state.booking = booking;
      await ledgerAppend({
        kind: "call", actor: "clara",
        what: `main-line booking for ${state.fromE164} at call end: ${booking.status}${booking.error ? ` (${booking.error})` : ""}`,
        ref: callSid, meta: { direction: "inbound", context: "inbound-business", slot: booking.start, status: booking.status },
      }).catch(() => {});
    }
  }

  // A call that learned nothing is not worth a notification. Wrong numbers and greeting-hangups
  // would otherwise page the owner several times a day and train them to ignore the channel — the
  // failure mode where an alert exists and is useless.
  if (!learnedAnything && reason !== "blocked") return;

  await notifyOwner({
    kind: "lead.inbound_call",
    priority: reason === "wants-human" || reason === "blocked" ? "critical" : "normal",
    text: `${summarize(state)}${reason === "wants-human" ? "\n⚠ Asked for a person." : ""}`,
    dedupeKey: `lead:call:${callSid}`,
  }).catch(() => {});

  // Best-effort CRM write. A failure here must never cost the notification above — the text is the
  // durable record, the OS row is the convenience.
  try {
    await fileInboundCallLead(state, reason);
  } catch (e) {
    await ledgerAppend({
      kind: "action", actor: "clara",
      what: `inbound lead ${callSid} did not reach the OS: ${String(e).slice(0, 160)}`,
      ref: callSid, meta: { degraded: "crm-write" },
    }).catch(() => {});
  }
}
