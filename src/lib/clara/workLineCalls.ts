// Clara — the end of a call on the owner's work line. 
//
// Called from leads.finalizeInboundCall once the finalize slot is claimed, so it runs exactly once
// per call whichever of the voice webhook or the status callback gets there first. It:
//   * books the calendar slot the caller agreed to — only one Clara actually offered;
//   * texts the owner ONE plain-English line when the call matters (importantText.ts) — an urgent caller,
//     a transfer they missed, or a VIP — and otherwise leaves it for the morning brief;
//   * logs the call for the brief and writes it to vault memory under the caller (workLineLog.ts);
//   * files a CRM contact only for a caller the OS didn't already know.

import type { InboundCallState, TransferOutcome } from "./call-sessions";
import type { LeadReason } from "./leads";
import { OWNER_FIRST } from "./owner";
import { speakSlot, triageUrgency, vipBlockedWhyPhrase, whoLabel, type DeclineReasonKind } from "./workLine";

export interface WorkLineCallPlan {
  who: string;
  need?: string;
  urgent: boolean;
  missedTransfer: boolean;
  /** Why the transfer didn't connect (2026-09-29). Unset when none was tried, or when it connected. */
  transferOutcome?: Exclude<TransferOutcome, "connected">;
  /** The owner was never rung at all (2026-10-01): a tiered VIP, blocked by their calendar or by tier. */
  vipOutcome?: "vip_blocked_calendar" | "message_only";
  vipReasonKind?: DeclineReasonKind;
  important: boolean;
  bookSlot?: string;
  callback: boolean;
}

/** Pure: the log/brief line for a transfer-tier VIP Clara declined because the owner's calendar was busy. */
export function vipBlockedDid(who: string, kind: DeclineReasonKind): string {
  return `I took a message for ${who} — I didn't ring you because you were ${vipBlockedWhyPhrase(kind)}.`;
}

/** Pure: the log/brief line for a message-only VIP — Clara never rings this tier, ever. */
export function messageOnlyDid(who: string): string {
  return `I took a message for ${who} — he's on your message-only list, so I never rang you.`;
}

/**
 * Pure: what to tell the owner about a transfer that didn't connect. The caller heard one neutral line
 * either way; the owner is told the truth about their own phone. "you passed" for a deliberate no, so they
 * aren't told they missed a call they chose not to take.
 */
export function missedTransferHead(who: string, outcome: WorkLineCallPlan["transferOutcome"]): string {
  switch (outcome) {
    case "declined": return `You passed on ${who}'s call, so I took a message.`;
    case "voicemail": return `Your voicemail picked up when I tried to put ${who} through, so I kept them with me and took a message.`;
    case "no-reply": return `I texted you about ${who}'s call but didn't hear back in time, so I took a message.`;
    case "no-answer": return `I tried to put ${who} through to you but your phone didn't answer, so I took a message.`;
    case "caller-left": return `${who} hung up while I was checking whether you could take the call.`;
    default: return `I tried to put ${who} through to you but couldn't reach you.`;
  }
}

/** Pure: the "what Clara did" line for the brief and her memory, for a transfer that didn't connect. */
export function missedTransferDid(outcome: WorkLineCallPlan["transferOutcome"]): string {
  switch (outcome) {
    case "declined": return "I tried to put them through, you passed, so I took a message.";
    case "voicemail": return "I tried to put them through, your voicemail answered, so I took a message.";
    case "no-reply": return "I texted you about the call, didn't hear back in time, so I took a message.";
    case "no-answer": return "I tried to put them through, your phone didn't answer, so I took a message.";
    case "caller-left": return "They hung up while I was checking whether you could take the call.";
    default: return "I tried to put them through, you didn't pick up, so I took a message.";
  }
}

/** Pure: everything the end of a work-line call decides, before any side effect. */
export function planWorkLineCall(state: InboundCallState, reason: LeadReason): WorkLineCallPlan {
  const l = state.learned;
  const kind = state.profile?.kind ?? "unknown";
  const text = [l.need, l.timeline, ...state.turns.filter((t) => t.role === "caller").map((t) => t.text)].filter(Boolean).join(" ");
  const { urgent } = triageUrgency({ kind, text, wantsOwner: reason === "wants-human" });
  const missedTransfer = Boolean(state.transferTried) && !state.transferAccepted;
  const transferOutcome = missedTransfer && state.transferOutcome !== "connected" ? state.transferOutcome : undefined;
  const bookSlot = l.bookSlot && state.offeredSlots?.includes(l.bookSlot) ? l.bookSlot : undefined;
  const learnedAnything = Object.keys(l).length > 0;
  // Decided at the greeting (workLine.decideVipGreeting), before any transfer was ever attempted —
  // distinct from missedTransfer, which is about a dial that WAS tried and didn't connect.
  const vipOutcome: WorkLineCallPlan["vipOutcome"] = state.vipBusyReason
    ? "vip_blocked_calendar"
    : state.profile?.tier === "message_only" ? "message_only" : undefined;
  return {
    who: whoLabel(l, state.profile, state.fromE164),
    need: l.need,
    urgent,
    missedTransfer,
    transferOutcome,
    vipOutcome,
    vipReasonKind: state.vipBusyReason,
    // Always important when the owner was deliberately never rung for a VIP — they get an immediate
    // heads-up at call-start too (workLineCalls.sendVipImmediateHeadsUp), this is the follow-up
    // with whatever message was actually captured.
    // A caller who hung up while holding was already texted about live (holdTransfer.onCallerLeft);
    // the brief still lists them, the end-of-call text doesn't repeat it.
    important: Boolean(vipOutcome) || (reason !== "transferred" && reason !== "blocked" && transferOutcome !== "caller-left" && (urgent || missedTransfer || (kind === "vip" && learnedAnything))),
    bookSlot,
    callback: reason !== "transferred" && reason !== "blocked" && !bookSlot,
  };
}

/** Pure: the text the owner gets. Plain words, no codes, the number to call back on. */
export function importantCallText(plan: WorkLineCallPlan, state: InboundCallState): string {
  const l = state.learned;
  const head = plan.vipOutcome === "vip_blocked_calendar"
    ? vipBlockedDid(plan.who, plan.vipReasonKind ?? "meeting")
    : plan.vipOutcome === "message_only"
    ? messageOnlyDid(plan.who)
    : plan.missedTransfer
    ? missedTransferHead(plan.who, plan.transferOutcome)
    : `${plan.who} called your work phone${plan.urgent ? " and it sounds urgent" : ""}.`;
  const bits = [
    head,
    plan.need ? `They need: ${plan.need}.` : "",
    l.timeline ? `Timing: ${l.timeline}.` : "",
    `Call back on ${l.callback || state.fromE164}.`,
  ];
  return bits.filter(Boolean).join(" ").replace(/\.\./g, ".");
}

export async function finalizeWorkLineCall(state: InboundCallState, reason: LeadReason): Promise<void> {
  const plan = planWorkLineCall(state, reason);
  const l = state.learned;

  let booked: string | null = null;
  if (plan.bookSlot) {
    try {
      const { bookEvent } = await import("./ms-calendar");
      const start = new Date(plan.bookSlot);
      const r = await bookEvent({
        requestor: "owner",
        onCalendar: "work",
        summary: `Call with ${plan.who}`,
        startISO: start.toISOString(),
        endISO: new Date(start.getTime() + 30 * 60_000).toISOString(),
        attendees: l.email ? [l.email] : [],
        description: `Booked by Clara from a call to your work phone.\nWhat they need: ${l.need ?? "not said"}\nCall them on: ${l.callback || state.fromE164}`,
        external: Boolean(l.email),
      });
      if (r.ok) booked = speakSlot(plan.bookSlot);
    } catch { /* falls back to a callback line */ }
  }

  let texted = false;
  if (plan.important) {
    const { textOwnerImportant } = await import("./importantText");
    texted = ["send", "emailed"].includes(await textOwnerImportant({ contact: state.fromE164, matter: plan.need ?? "call", text: importantCallText(plan, state) }));
  }
  // The heads-up at call-start (workLineCalls.sendVipImmediateHeadsUp) is a second, earlier text on
  // a different matter key — it still counts towards "the owner was texted about this call" for the brief.
  if (state.vipImmediateTexted) texted = true;

  const did = reason === "transferred"
    ? "I put them through to you."
    : plan.vipOutcome === "vip_blocked_calendar" ? vipBlockedDid(plan.who, plan.vipReasonKind ?? "meeting")
    : plan.vipOutcome === "message_only" ? messageOnlyDid(plan.who)
    : booked ? `I booked a call with you for ${booked}.`
    : plan.missedTransfer ? missedTransferDid(plan.transferOutcome)
    : Object.keys(l).length ? "I took a message." : "They hung up before leaving a message.";

  const { recordWorkLine } = await import("./workLineLog");
  await recordWorkLine(
    { at: new Date().toISOString(), channel: "call", from: state.fromE164, who: plan.who, need: plan.need, did, callback: plan.callback || (Boolean(plan.bookSlot) && !booked), important: texted },
    {
      threadKey: state.fromE164.replace(/[^\d+]/g, ""),
      subject: l.callerName || state.profile?.name,
      detail: [
        l.company ? `Company: ${l.company}` : "",
        l.timeline ? `When: ${l.timeline}` : "",
        l.callback ? `Callback: ${l.callback}` : "",
        `${state.turns.filter((t) => t.role === "caller").length} caller turn(s); ${OWNER_FIRST}'s phone ${state.transferTried ? (state.transferAccepted ? "took the transfer" : `didn't take the transfer (${state.transferOutcome ?? "not reached"})`) : "wasn't rung"}.`,
      ].filter(Boolean).join(" · "),
    },
  );

  // A caller the OS has never seen becomes a contact; known clients and leads already have one.
  if ((state.profile?.kind ?? "unknown") === "unknown" && Object.keys(l).length) {
    const { fileInboundCallLead } = await import("./leads");
    await fileInboundCallLead(state, reason).catch(() => {});
  }
}

/**
 * Text the owner the instant Clara decides NOT to ring them for a tiered VIP (workLine.decideVipGreeting)
 * — at call-start, before any message is taken, so they can break out of their meeting if they want to.
 * A second, fuller text follows at end-of-call (finalizeWorkLineCall) once the message is known;
 * different matter keys on the two sends so textOwnerImportant's per-matter dedupe doesn't eat
 * either one, while a Twilio retry of the SAME greeting hit still only sends this one once.
 */
export async function sendVipImmediateHeadsUp(
  opts: { contact: string; text: string },
  deps: { send?: (item: { contact: string; matter: string; text: string }) => Promise<string> } = {},
): Promise<boolean> {
  const send = deps.send ?? (async (item) => {
    const { textOwnerImportant } = await import("./importantText");
    return textOwnerImportant(item);
  });
  const result = await send({ contact: opts.contact, matter: "vip-heads-up", text: opts.text }).catch(() => "failed");
  return result === "send" || result === "emailed";
}
