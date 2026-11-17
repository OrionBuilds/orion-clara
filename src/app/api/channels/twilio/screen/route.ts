// Twilio VOICE screener for OWNER'S PERSONAL LINE.
// Point the owner's number's "A CALL COMES IN" webhook at:
//   <tunnel>/api/channels/twilio/screen
//
// Whitelist → <Dial> straight through to the owner's cell.
// Otherwise if the owner is in focus mode → Clara answers, takes a message.
// Otherwise → <Dial> the owner's cell (default: ring through).
//
// Recording (Clara-answers branch only) is deferred the same way as voice/route.ts: the first
// gather speaks the disclosure with no recording running yet; Twilio only calls back with a
// SpeechResult once that prompt has fully played, so THAT'S when <Start><Recording> fires.

import { ensureBootstrapped } from "@/lib/clara/bootstrap";
import { xmlResponse, twilioSignatureValid, twilioPublicUrl, gather, speak, twilioConfig, esc, startRecordingTwiml } from "@/lib/clara/channels";
import { noteInbound, contextFor, decide } from "@/lib/clara/screening";
import { ownerFocusMode } from "@/lib/clara/focus";
import { respond } from "@/lib/clara/telephony";
import { RECORDING_DISCLOSURE } from "@/lib/clara/recorder";
import { append as ledgerAppend } from "@/lib/clara/ledger";
import { OWNER_FIRST } from "@/lib/clara/owner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function publicBase(req: Request): string {
  const host = req.headers.get("host") ?? "127.0.0.1:3939";
  const proto = req.headers.get("x-forwarded-proto") ?? "https";
  return `${proto}://${host}`;
}

const SCREEN_PATH = "/api/channels/twilio/screen";
const FIRST_REPLY_MARKER = "rec=start";

export async function POST(req: Request) {
  await ensureBootstrapped();
  const params: Record<string, string> = {};
  try {
    const form = await req.formData();
    for (const [k, v] of form.entries()) params[k] = String(v);
  } catch { /* first hit */ }

  // includeQuery=true: our own `action` URLs below carry a `?rec=start` marker, and Twilio
  // computes its signature over the exact URL it requested (query string included) — dropping
  // the query here would make every legitimate follow-up request fail verification.
  if (!twilioSignatureValid(req, twilioPublicUrl(req, true), params)) {
    return new Response("invalid Twilio signature", { status: 403 });
  }

  const base = publicBase(req);
  const from = params.From ?? "";
  const to = params.To ?? "";
  const callSid = params.CallSid ?? "";
  const speech = (params.SpeechResult ?? "").trim();
  const isFirstReply = new URL(req.url).searchParams.get("rec") === "start";

  // Continued conversation with Clara (the owner was busy).
  if (speech) {
    try {
      const reply = await respond("screen-for-owner", speech, from);
      const cont = gather("Anything else you want me to pass along?", base, SCREEN_PATH, "stranger")
        .replace(/^<Response>|<\/Response>$/g, "");
      const startRecord = isFirstReply
        ? startRecordingTwiml(base)
        : "";
      return xmlResponse(`<Response>${startRecord}${speak(reply, base, "stranger")}${cont}</Response>`);
    } catch (e) {
      // This caller is whoever's calling the owner's personal line — never a principal (see
      // voice/route.ts's own stranger-path fallback for the same reasoning) — so a raw error must
      // never be spoken to them. Log it for the record; say something human instead.
      await ledgerAppend({
        kind: "call", actor: "clara",
        what: `screen-for-owner call turn failed for ${from}: ${String(e).slice(0, 160)}`,
        ref: callSid, meta: { error: "turn-failed" },
      }).catch(() => {});
      return xmlResponse(`<Response>${speak(
        "I'm sorry, I'm having trouble on my end. I've flagged this and someone from the team will reach out shortly. Thanks for your patience.",
        base, "stranger",
      )}</Response>`);
    }
  }

  // Fresh call — decide route.
  await noteInbound(from);
  const focus = await ownerFocusMode();
  const ctx = await contextFor(from, to, focus);
  const verdict = decide(ctx);

  await ledgerAppend({
    kind: "call",
    actor: "clara",
    what: `screened call from ${from} → route:${verdict.route} (${verdict.reason})`,
    ref: callSid,
    meta: { direction: "inbound", context: "screen-for-owner", verdict },
  });

  if (verdict.route === "owner") {
    const cfg = twilioConfig();
    const target = cfg?.ownerNumber;
    if (!target) {
      // Can't forward — take a message anyway. No recording yet (see note above).
      const g = gather(
        `${RECORDING_DISCLOSURE} Hi, this is Clara — ${OWNER_FIRST}'s assistant. They can't take the call right now. How can I help?`,
        base, `${SCREEN_PATH}?${FIRST_REPLY_MARKER}`, "stranger",
      );
      return xmlResponse(g);
    }
    // Autonomy Spec v0.1, item #9: this branch used to never record at all — it's the common
    // case (ringing straight through when the owner isn't in focus mode), so "every call captured"
    // required extending recording here too, not just to the focus-mode/stranger-line paths that
    // already had it. The disclosure plays to the CALLER while the owner's phone starts ringing
    // (sequential TwiML — <Say>/<Play> before <Dial> executes first), then record="record-from-
    // answer" starts once the owner actually picks up, same recordingStatusCallback the other paths use.
    return xmlResponse(
      `<Response>${speak(RECORDING_DISCLOSURE, base, "stranger")}` +
      `<Dial callerId="${esc(from)}" record="record-from-answer" recordingStatusCallback="${base}/api/channels/twilio/recording" recordingStatusCallbackEvent="completed">${esc(target)}</Dial></Response>`,
    );
  }

  // Focus mode — Clara answers. No recording yet (see note above).
  const greeting = `${RECORDING_DISCLOSURE} Hi, this is Clara — ${OWNER_FIRST}'s assistant. They're in a meeting right now. What can I help you with?`;
  return xmlResponse(gather(greeting, base, `${SCREEN_PATH}?${FIRST_REPLY_MARKER}`, "stranger"));
}
