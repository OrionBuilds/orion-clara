// Twilio calls this once the warm-transfer <Dial> verb finishes (Autonomy Spec v0.1, item #10) —
// either the bridged call ended normally, or the owner never picked up (no-answer/busy/failed). The
// ORIGINAL caller is still connected when this fires, so a no-answer here is exactly where the
// existing take-a-message fallback belongs: same message, same finalize() reason, as if the
// warm-transfer had never been attempted.

import { xmlResponse, twilioSignatureValid, twilioPublicUrl, sayAndHangup } from "@/lib/clara/channels";
import { getInboundSession, patchInboundSession } from "@/lib/clara/call-sessions";
import { transferConnected, transferOutcomeFromDial } from "@/lib/clara/workLine";
import { finalizeInboundCall as finalize } from "@/lib/clara/leads";
import { OWNER_FIRST } from "@/lib/clara/owner";
import { append as ledgerAppend } from "@/lib/clara/ledger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function publicBase(req: Request): string {
  const host = req.headers.get("host") ?? "127.0.0.1:3939";
  const proto = req.headers.get("x-forwarded-proto") ?? "https";
  return `${proto}://${host}`;
}

export async function POST(req: Request) {
  const params: Record<string, string> = {};
  try {
    const form = await req.formData();
    for (const [k, v] of form.entries()) params[k] = String(v);
  } catch { /* */ }

  if (!twilioSignatureValid(req, twilioPublicUrl(req, true), params)) {
    return new Response("invalid Twilio signature", { status: 403 });
  }

  const callSid = new URL(req.url).searchParams.get("callSid") ?? params.CallSid ?? "";
  const status = params.DialCallStatus ?? "";

  await ledgerAppend({
    kind: "call", actor: "clara",
    what: `warm-transfer dial for ${callSid} ended: ${status || "unknown"}`,
    ref: callSid, meta: { dialCallStatus: status },
  }).catch(() => {});

  const session = callSid ? getInboundSession(callSid) : null;

  // Connected means the owner pressed 1 on the whisper (whisper/accept). A "completed" dial they never
  // accepted is their voicemail or a missed whisper — the caller was never really put through.
  if (transferConnected(status, session?.transferAccepted)) {
    // The owner took it and the conversation already happened live — still worth filing whatever was
    // learned pre-transfer, just without the "critical, follow up" framing.
    await finalize(callSid, "transferred").catch(() => {});
    return xmlResponse(`<Response></Response>`);
  }

  // What actually happened to the attempt, for the record — unless the accept route already said
  // (the owner pressed a key other than 1).
  if (session && !session.transferOutcome) patchInboundSession(callSid, { transferOutcome: transferOutcomeFromDial(status) });

  // (Work-line transfers no longer come through <Dial> — they are held and text-accepted, and the
  // hold routes bring the caller back. Only the business line dials the owner directly now.)

  // no-answer / busy / failed / canceled — the owner never connected. Caller is still on the line.
  await finalize(callSid, "wants-human").catch(() => {});
  return xmlResponse(sayAndHangup(
    `Sorry, ${OWNER_FIRST} isn't available right now, but I've passed this along and someone from the team will reach out shortly. Thanks for your patience.`,
    publicBase(req), "stranger",
  ));
}
