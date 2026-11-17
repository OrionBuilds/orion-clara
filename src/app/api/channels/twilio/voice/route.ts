// Twilio VOICE webhook — inbound calls to Clara's OWN business number.
// Point the number's "A CALL COMES IN" webhook (POST) at:
//   <tunnel>/api/channels/twilio/voice
//
// Recording flow: on connect, greet + speak the recording disclosure + <Gather> the caller's opener
// WITHOUT recording yet. Twilio only invokes this webhook again with a SpeechResult once the nested
// <Say>/<Play> inside that <Gather> has fully finished playing (documented Twilio behavior), so by
// the time we see speech for the first time the disclosure is GUARANTEED to have been spoken.
// That's exactly when <Start><Recording> begins — never before.
//
// Two callers, two brains (2026-08-03, when this number went on the public site):
//
//   The owner              → telephony.respond(), unchanged. Single-turn, full principal context.
//   anyone else       → inbound-call-brain: multi-turn qualification, business persona only.
//
// The stranger path is the one that needed hardening. It previously looped <Gather> forever with no
// turn ceiling, no <Hangup/>, and no cost ceiling — acceptable when only vendors had the number,
// and an open invoice once it is published on a website. It now carries all three, plus a lead
// write-out so a call that qualifies someone doesn't evaporate when they hang up.

import { ensureBootstrapped } from "@/lib/clara/bootstrap";
import { xmlResponse, twilioSignatureValid, twilioPublicUrl, gather, speak, sayAndHangup, dial, twilioConfig, startRecordingTwiml, enqueue } from "@/lib/clara/channels";
import { noteInbound } from "@/lib/clara/screening";
import { respond } from "@/lib/clara/telephony";
import { resolveByPhone } from "@/lib/clara/principals";
import { RECORDING_DISCLOSURE } from "@/lib/clara/recorder";
import { append as ledgerAppend } from "@/lib/clara/ledger";
import { notifyOwner } from "@/lib/clara/notify";
import {
  ensureInboundSession,
  appendInboundTurn,
  updateInboundLearned,
  setInboundStatus,
  patchInboundSession,
  getInboundSession,
} from "@/lib/clara/call-sessions";
import { greeting, nextInboundTurn } from "@/lib/clara/inbound-call-brain";
import { finalizeInboundCall as finalize } from "@/lib/clara/leads";
import { jobOverCallBudget, callsForPurposeToday, effectiveJobMaxCalls } from "@/lib/clara/usage";
import { OWNER_FIRST, BUSINESS_NAME, BUSINESS_INFO_EMAIL } from "@/lib/clara/owner";
import {
  isWorkLineCall, WORK_LINE_GREETING, callerProfile, openSlots, triageUrgency,
  decideVipGreeting, vipBlocksLiveTransfer, vipTakeMessageFallback,
} from "@/lib/clara/workLine";
import { transferTarget } from "@/lib/clara/ownerPhones";
import { putThroughFor, tierOf } from "@/lib/clara/putThrough";
import { startHold, holdWho, HOLD_PATH } from "@/lib/clara/holdTransfer";
import { busyEvent } from "@/lib/clara/ms-calendar";
import { sendVipImmediateHeadsUp } from "@/lib/clara/workLineCalls";
import { buildCallerMeetingContext } from "@/lib/clara/meetings/callerMeetings";
import { businessBookingEnabled, businessSlots, pendingBooking, bookReady, trackBooking, bookingFallbackLine, BOOKING_TURN_DEADLINE_MS } from "@/lib/clara/businessBooking";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function publicBase(req: Request): string {
  const host = req.headers.get("host") ?? "127.0.0.1:3939";
  const proto = req.headers.get("x-forwarded-proto") ?? "https";
  return `${proto}://${host}`;
}

const VOICE_PATH = "/api/channels/twilio/voice";
const FIRST_REPLY_MARKER = "rec=start";

/** Park a work-line caller in their own queue (holdTransfer.ts) after `sayXml` plays. */
function holdTwiml(queueName: string, callSid: string, base: string, sayXml: string): string {
  const qs = `callSid=${encodeURIComponent(callSid)}`;
  return enqueue({ queueName, waitUrl: `${base}${HOLD_PATH}/wait?${qs}`, actionUrl: `${base}${HOLD_PATH}/done?${qs}`, sayXml });
}

export async function POST(req: Request) {
  await ensureBootstrapped();
  const params: Record<string, string> = {};
  try {
    const form = await req.formData();
    for (const [k, v] of form.entries()) params[k] = String(v);
  } catch { /* first hit sometimes lacks form */ }

  // includeQuery=true: our own `action` URLs below carry a `?rec=start` marker, and Twilio
  // computes its signature over the exact URL it requested (query string included) — dropping
  // the query here would make every legitimate follow-up request fail verification.
  if (!twilioSignatureValid(req, twilioPublicUrl(req, true), params)) {
    return new Response("invalid Twilio signature", { status: 403 });
  }

  const base = publicBase(req);
  const from = params.From ?? "";
  const callSid = params.CallSid ?? "";
  const speech = (params.SpeechResult ?? "").trim();
  const isFirstReply = new URL(req.url).searchParams.get("rec") === "start";

  // Resolve once per webhook hit. Failing closed to "stranger" is the safe direction: an
  // unrecognized the owner gets a stiff greeting, an unrecognized stranger gets the owner's private context.
  const principal = await resolveByPhone(from).catch(() => null);
  // The owner's work phone forwarded here (workLine.ts): same loop, owner's-assistant persona, warm transfer
  // to the owner's personal cell for urgent callers. Decided from the To number on every hit.
  const workLine = isWorkLineCall(params);

  if (!speech) {
    await noteInbound(from);
    await ledgerAppend({
      kind: "call",
      actor: "clara",
      what: `inbound call answered from ${from}${principal ? ` (${principal.displayName})` : " (stranger)"}${workLine ? " on the work line" : ""}`,
      ref: callSid,
      meta: { direction: "inbound", context: principal ? "inbound-to-clara" : workLine ? "inbound-workline" : "inbound-business" },
    });
    // Open the work-line session at the greeting, so a caller who hangs up without a word still shows
    // in the brief as a missed call (the status callback finalizes it).
    if (workLine && !principal) {
      patchInboundSession(ensureInboundSession(callSid, from).callSid, { line: "work" });
      // The owner's always-put-through list (putThrough.ts): a short hello and straight onto hold while
      // Clara texts the owner (holdTransfer.ts) — no questions, no triage. If they don't take it, the caller
      // comes back here with the profile already set, and she takes a message.
      //
      // Two tiers (2026-10-01): "message_only" never rings the owner at all. "transfer" is gated on their
      // calendar — busy (calendar.busyEvent) means a calendar-aware decline + message instead of a
      // ring, with the owner texted right away either way so they can break out if they want.
      const pt = await putThroughFor(from);
      // Once per call: a caller sent back here after the owner didn't take it must never be re-held.
      if (pt && !getInboundSession(callSid)?.transferTried) {
        const tier = tierOf(pt);
        patchInboundSession(callSid, { profile: { kind: "vip", name: pt.name, tier } });
        const busy = tier === "transfer" ? await busyEvent(new Date().toISOString()).catch(() => null) : null;
        const decision = decideVipGreeting(pt.name, tier, busy);
        if (decision.outcome !== "hold") {
          if (decision.outcome === "vip_blocked_calendar") patchInboundSession(callSid, { vipBusyReason: decision.reasonKind });
          await sendVipImmediateHeadsUp({ contact: from, text: decision.headsUp }).catch(() => false);
          patchInboundSession(callSid, { vipImmediateTexted: true });
          await ledgerAppend({
            kind: "call", actor: "clara",
            what: decision.outcome === "message_only"
              ? `work-line VIP ${pt.name} is message-only — greeted, no ring, taking a message`
              : `work-line VIP ${pt.name} declined — ${OWNER_FIRST} is busy (${decision.reasonKind}), taking a message`,
            ref: callSid, meta: { direction: "inbound", context: "inbound-workline" },
          }).catch(() => {});
          return xmlResponse(gather(`${RECORDING_DISCLOSURE} ${decision.greeting}`, base, `${VOICE_PATH}?${FIRST_REPLY_MARKER}`, "stranger"));
        }
        const held = await startHold({ callSid, from, who: pt.name, vip: true, base });
        if (held.ok) {
          // Short, but complete: she says who she is even to the people who skip the questions.
          const hello = speak(`${RECORDING_DISCLOSURE} Hi ${pt.name}, it's Clara, ${OWNER_FIRST}'s AI assistant. One moment — I'm letting ${OWNER_FIRST} know you're on the line.`, base, "stranger");
          return xmlResponse(holdTwiml(held.queueName, callSid, base, hello));
        }
        await ledgerAppend({ kind: "call", actor: "clara", what: `work-line put-through for ${pt.name} not held (${held.reason}) — taking a message`, ref: callSid, meta: { direction: "inbound", context: "inbound-workline" } }).catch(() => {});
      }
    }
    const opener = principal
      ? `Hi, this is Clara — ${OWNER_FIRST}'s assistant. How can I help you?`
      : workLine ? WORK_LINE_GREETING : greeting();
    // No recording yet — the disclosure hasn't been confirmed spoken until Twilio comes back
    // with a SpeechResult, which only happens after this Gather's prompt finishes playing.
    return xmlResponse(gather(
      `${RECORDING_DISCLOSURE} ${opener}`,
      base,
      `${VOICE_PATH}?${FIRST_REPLY_MARKER}`,
      principal ? principal.id : "stranger",
    ));
  }

  const startRecord = isFirstReply
    ? startRecordingTwiml(base)
    : "";

  // ── Principal path: the intent router, so she can actually DO things by phone ─────────────────
  //
  // Until 2026-08-03 this called telephony.respond() — single-turn, no tools. The owner could ring her
  // and ask for their inbox to be cleared and get a pleasant conversation about it and no work: the
  // same defect as the SMS one that started all this, on the channel where it is least obvious
  // because you cannot see that nothing happened.
  //
  // Slow tools are deferred rather than awaited. A sweep runs for minutes; Twilio times the webhook
  // out around 15s and the caller hears silence long before that. She says she's started it and
  // texts the result — deferSlow below is what makes that true rather than a promise.
  if (principal) {
    try {
      const { ownerTurn, recordOwnerTurn, toolTags } = await import("@/lib/clara/ownerTurn");
      // An answer to a question Clara asked on this call (or earlier by text) is resolved before
      // the router — "yes" must never be paraphrased into conversation (decisionReply.ts).
      const { tryHandleDecisionReply } = await import("@/lib/clara/decisionReply");
      const decided = await tryHandleDecisionReply(speech, { channel: "voice", from, requestRef: callSid }).catch(() => null);
      if (decided !== null) {
        const spokenDecision = decided.split("\n\n")[0].slice(0, 600);
        await recordOwnerTurn({ channel: "voice", from, userText: speech, reply: spokenDecision, tools: ["decide"] });
        await ledgerAppend({ kind: "call", actor: "clara", what: `voice decision: "${decided.slice(0, 100)}"`, ref: callSid, meta: { direction: "inbound" } }).catch(() => {});
        const contD = gather(spokenDecision, base, VOICE_PATH, principal.id).replace(/^<Response>|<\/Response>$/g, "");
        return xmlResponse(`<Response>${startRecord}${contD}</Response>`);
      }
      const { outcome, history } = await ownerTurn({
        channel: "voice",
        from,
        text: speech,
        requestRef: callSid,
        deferSlow: (tool, args) => {
          void (async () => {
            try {
              const out = await tool.run(args, { principal: principal.id, source: "voice" });
              await notifyOwner({
                kind: "voice.deferred_result",
                priority: "normal",
                text: `From our call — ${out.line}`.slice(0, 1200),
                dedupeKey: `voice-deferred:${callSid}:${tool.name}`,
              });
            } catch (e) {
              // A deferred failure must still reach the owner. Started-and-silent is the worst outcome:
              // they'd believe it ran.
              await notifyOwner({
                kind: "voice.deferred_result",
                priority: "critical",
                text: `From our call — ${tool.name} FAILED and did not complete: ${String(e).slice(0, 200)}`,
                dedupeKey: `voice-deferred-fail:${callSid}:${tool.name}`,
              }).catch(() => {});
            }
          })();
        },
      });

      // Router had nothing to act on and nothing it needed to say — fall back to conversation,
      // which carries the principal persona and memory the router deliberately doesn't.
      const reply = (outcome.calls.length || outcome.failed || outcome.clarifying)
        ? outcome.reply
        : await respond("inbound-to-clara", speech, from, history);

      if (outcome.calls.length) {
        await ledgerAppend({
          kind: "call", actor: "clara",
          what: `voice intent: ${outcome.calls.map((c) => `${c.name}${c.ok ? "" : "(failed)"}`).join(", ")} for "${speech.slice(0, 80)}"`,
          ref: callSid,
          meta: { tools: outcome.calls.map((c) => c.name).join(","), direction: "inbound" },
        }).catch(() => {});
      }

      // Spoken, so strip the ground-truth block the text channels want — she reads the headline and
      // the detail is already going to their phone.
      const spoken = reply.split("\n\n")[0].slice(0, 600);
      // Voice turns persisted nothing until 2026-09-24 — a call left no trace for the SMS/desk that
      // followed it. Now every principal turn lands in the shared owner thread.
      await recordOwnerTurn({ channel: "voice", from, userText: speech, reply: spoken, tools: toolTags(outcome) });
      const cont = gather(spoken, base, VOICE_PATH, principal.id).replace(/^<Response>|<\/Response>$/g, "");
      return xmlResponse(`<Response>${startRecord}${cont}</Response>`);
    } catch (e) {
      return xmlResponse(`<Response>${speak(`I hit a snag. ${String(e).slice(0, 120)}`, base, principal.id)}</Response>`);
    }
  }

  // ── Stranger path: metered, capped, multi-turn qualification ─────────────────────────────────

  // Cost ceiling before the model call, not after. Principals are exempt (checked above), so a
  // stranger flood can never lock the owner out of their own line — the same split the SMS path uses.
  if (await jobOverCallBudget("inbound-call")) {
    const [used, cap] = await Promise.all([callsForPurposeToday("inbound-call"), effectiveJobMaxCalls()]);
    await notifyOwner({
      kind: "job.call_cap",
      priority: "critical",
      text: `⏸ Clara stopped answering inbound calls conversationally — ${used} model calls today (cap ${cap}). Callers now get a take-a-message message. Text "raise clara calls 200" to add 200 for today only.`,
      dedupeKey: `clara:callcap:inbound-call:${new Date().toISOString().slice(0, 10)}`,
    }).catch(() => {});
    await ledgerAppend({
      kind: "call", actor: "clara",
      what: `inbound call from ${from} answered with the fallback message — per-job call cap reached (${used}/${cap})`,
      ref: callSid, meta: { dropped: "call-cap" },
    }).catch(() => {});
    await finalize(callSid, "capped");
    return xmlResponse(`<Response>${startRecord}${sayAndHangup(
      workLine
        ? `This is Clara, ${OWNER_FIRST}'s assistant. I can't take details right now — please text this number and ${OWNER_FIRST} will get back to you.`
        : `Thanks for calling ${BUSINESS_NAME}. I can't take details right now, but please email ${BUSINESS_INFO_EMAIL.replace("@", " at ").replace(/\./g, " dot ")} and the team will get right back to you.`,
      base, "stranger",
    ).replace(/^<Response>|<\/Response>$/g, "")}</Response>`);
  }

  const state = ensureInboundSession(callSid, from);
  if (workLine && !state.profile) {
    // First turn on the work line: who is this to the owner, and when could they talk. Both bounded — a slow
    // lookup costs the caller a pause, never the call.
    const [profile, offeredSlots] = await Promise.all([
      Promise.race([callerProfile(from), new Promise<null>((r) => setTimeout(() => r(null), 3_000))]).catch(() => null),
      openSlots(3),
    ]);
    patchInboundSession(callSid, { line: "work", profile: profile ?? { kind: "unknown" }, offeredSlots });
    // Vault-backed recall for anything they said in a recent meeting WITH the owner (or a meeting the
    // vault shows them attending). Bounded so a slow filesystem can't delay the call turn; the
    // field is only used by the prompt when present, so a timeout is a safe skip.
    const name = profile?.name;
    if (name) {
      const meetingContext = await Promise.race([
        buildCallerMeetingContext(name),
        new Promise<null>((r) => setTimeout(() => r(null), 2_000)),
      ]).catch(() => null);
      if (meetingContext != null) patchInboundSession(callSid, { meetingContext });
    }
  }
  if (!workLine && state.line !== "work" && state.offeredSlots === undefined) {
    // First turn on the main line: a few real open times on the OS booking calendar (the same one
    // the website books into). Bounded — a slow lookup costs a pause, never the call; [] means
    // "can't see the calendar", which the prompt handles.
    const slots = businessBookingEnabled()
      ? await Promise.race([businessSlots(3), new Promise<[]>((r) => setTimeout(() => r([]), 4_000))]).catch(() => [])
      : [];
    patchInboundSession(callSid, {
      line: "business",
      offeredSlots: slots.map((s) => s.start),
      offeredSlotEnds: Object.fromEntries(slots.map((s) => [s.start, s.end])),
    });
  }
  appendInboundTurn(callSid, { role: "caller", text: speech, at: new Date().toISOString() });

  const turnStarted = Date.now();
  try {
    const turn = await nextInboundTurn(state, speech);
    if (turn.learnedPatch) updateInboundLearned(callSid, turn.learnedPatch);

    // Main line: book as soon as they've picked an offered time AND given an email, so what Clara
    // says next is true. Claimed first so an overlapping webhook can't book it twice. A taken slot
    // replaces her line — she must never confirm a booking that didn't happen. No email by the end
    // of the call → leads.finalizeInboundCall books it phone-only.
    const live = getInboundSession(callSid) ?? state;
    const ready = live.line !== "work" && !turn.hardBlocked ? pendingBooking(live, { requireEmail: true }) : null;
    if (ready) {
      patchInboundSession(callSid, { booking: { start: ready.slot.start, status: "pending" } });
      // The booking keeps running past this webhook if it must: its outcome lands on the session
      // (and in the ledger) whenever it settles, and call finalization waits for it off the webhook
      // path. This turn only waits what's left of Twilio's 15 s budget.
      const bookingP = trackBooking(callSid, bookReady(live, ready));
      bookingP.then(async (booking) => {
        patchInboundSession(callSid, { booking });
        await ledgerAppend({
          kind: "call", actor: "clara",
          what: `main-line booking for ${from}: ${booking.status}${booking.error ? ` (${booking.error})` : ""}`,
          ref: callSid, meta: { direction: "inbound", context: "inbound-business", slot: booking.start, status: booking.status },
        }).catch(() => {});
      }).catch(() => {});
      const budget = Math.max(1_000, BOOKING_TURN_DEADLINE_MS - (Date.now() - turnStarted));
      const booking = await Promise.race([bookingP.catch(() => null), new Promise<null>((r) => setTimeout(() => r(null), budget))]);
      if (!booking) turn.sayText = bookingFallbackLine("pending", turn.hangup);
      else if (booking.status !== "booked") turn.sayText = bookingFallbackLine(booking.status, turn.hangup);
    }
    appendInboundTurn(callSid, { role: "clara", text: turn.sayText, at: new Date().toISOString() });

    // Work line: an urgent caller is parked while the owner is texted "reply 1 to take it" (holdTransfer.ts),
    // once we know what they need. One attempt per call; if the owner doesn't take it, the hold routes bring
    // them back to finish the message.
    if (state.line === "work" && !turn.hardBlocked && !state.transferTried && !vipBlocksLiveTransfer(state.profile, state.vipBusyReason)) {
      // The owner's personal cell only — never the work phone, which forwards straight back here.
      const ownerNumber = transferTarget();
      const { urgent } = triageUrgency({
        kind: state.profile?.kind ?? "unknown",
        text: `${state.learned.need ?? ""} ${speech}`,
        wantsOwner: turn.wantsHuman,
      });
      const knowsWhy = Boolean(state.learned.need) || state.turns.filter((t) => t.role === "caller").length >= 2;
      if (urgent && knowsWhy && ownerNumber) {
        // Park them and text the owner (holdTransfer.ts). If that can't happen — the owner already has someone
        // holding, or the text didn't go — she just carries on taking the message, one line honest.
        const held = await startHold({ callSid, from, who: holdWho(state), need: state.learned.need, vip: state.profile?.kind === "vip", urgent: true, base });
        if (held.ok) {
          const line = `Understood. One moment — I'm letting ${OWNER_FIRST} know you're on the line.`;
          appendInboundTurn(callSid, { role: "clara", text: line, at: new Date().toISOString() });
          return xmlResponse(holdTwiml(held.queueName, callSid, base, `${startRecord}${speak(line, base, "stranger")}`));
        }
        // Counted as an attempt that never reached the owner, so the end-of-call text says so and the caller
        // is never held twice.
        patchInboundSession(callSid, { transferTried: true, transferOutcome: "no-answer" });
        await ledgerAppend({ kind: "call", actor: "clara", what: `work-line hold for ${from} not started (${held.reason}) — taking a message`, ref: callSid, meta: { direction: "inbound", context: "inbound-workline" } }).catch(() => {});
        if (held.reason === "busy") {
          const line = `${OWNER_FIRST}'s tied up on another call just now. ${turn.sayText}`;
          const cont = gather(line, base, VOICE_PATH, "stranger").replace(/^<Response>|<\/Response>$/g, "");
          return xmlResponse(`<Response>${startRecord}${cont}</Response>`);
        }
      }
    }

    if (turn.hangup) {
      // Autonomy Spec v0.1, item #10: a stranger asking for a person used to just get hung up on
      // and texted-about afterward. Now it's a live, WHISPERED transfer — the owner hears who's calling
      // and why before the caller is bridged in — with the exact same take-a-message fallback
      // (dial-status/route.ts) if the owner doesn't pick up. hardBlocked/goal-met calls are unchanged.
      const ownerNumber = twilioConfig()?.ownerNumber;
      if (state.line !== "work" && turn.wantsHuman && !turn.hardBlocked && ownerNumber) {
        setInboundStatus(callSid, "goal-met");
        patchInboundSession(callSid, { transferTried: true });
        const qs = `callSid=${encodeURIComponent(callSid)}`;
        return xmlResponse(dial({
          number: ownerNumber,
          whisperUrl: `${base}${VOICE_PATH}/whisper?${qs}`,
          actionUrl: `${base}${VOICE_PATH}/dial-status?${qs}`,
          callerId: from,
        }));
      }
      setInboundStatus(callSid, turn.hardBlocked ? "injection-blocked" : "goal-met");
      await finalize(callSid, turn.hardBlocked ? "blocked" : turn.wantsHuman ? "wants-human" : "qualified");
      return xmlResponse(`<Response>${startRecord}${sayAndHangup(turn.sayText, base, "stranger").replace(/^<Response>|<\/Response>$/g, "")}</Response>`);
    }

    // Clara's line IS the gather prompt — speaking it separately and then opening an empty
    // <Gather> would emit a blank <Play> and give the caller silence to talk over.
    const cont = gather(turn.sayText, base, VOICE_PATH, "stranger").replace(/^<Response>|<\/Response>$/g, "");
    return xmlResponse(`<Response>${startRecord}${cont}</Response>`);
  } catch (e) {
    // Never leak an internal error to a prospect — say something human, keep what was learned.
    await ledgerAppend({
      kind: "call", actor: "clara",
      what: `inbound call turn failed for ${from}: ${String(e).slice(0, 160)}`,
      ref: callSid, meta: { error: "turn-failed" },
    }).catch(() => {});
    await finalize(callSid, "wants-human");
    // On the work line the caller is the owner's, not the company's: she names herself and the owner, never
    // "someone from the team". A tiered VIP already mid message-capture (never going to be rung on
    // this call) hears the take-a-message variant instead of the generic trouble line.
    const vipState = getInboundSession(callSid);
    const vipFallback = workLine && vipState && vipBlocksLiveTransfer(vipState.profile, vipState.vipBusyReason);
    return xmlResponse(sayAndHangup(
      vipFallback
        ? vipTakeMessageFallback()
        : workLine
        ? `I'm sorry — this is Clara, ${OWNER_FIRST}'s assistant, and I'm having trouble on my end. I've flagged this so ${OWNER_FIRST} sees it, or you can text this number. Thanks for your patience.`
        : "I'm sorry, I'm having trouble on my end. I've flagged this and someone from the team will reach out shortly. Thanks for your patience.",
      base, "stranger",
    ));
  }
}
