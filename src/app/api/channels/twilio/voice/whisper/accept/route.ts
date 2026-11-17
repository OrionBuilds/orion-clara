// The owner's key press on a warm-transfer whisper (workLine.ts). "1" records that they really took the
// call and returns empty TwiML, which ends the whisper and bridges them to the caller. Anything else
// hangs up their leg; dial-status/route.ts then sees an unaccepted dial and takes the caller back.

import { xmlResponse, twilioSignatureValid, twilioPublicUrl } from "@/lib/clara/channels";
import { patchInboundSession } from "@/lib/clara/call-sessions";
import { acceptedDigits } from "@/lib/clara/workLine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const params: Record<string, string> = {};
  try {
    const form = await req.formData();
    for (const [k, v] of form.entries()) params[k] = String(v);
  } catch { /* no digits → not accepted */ }

  // includeQuery=true — the parent callSid rides on the query string.
  if (!twilioSignatureValid(req, twilioPublicUrl(req, true), params)) {
    return new Response("invalid Twilio signature", { status: 403 });
  }

  const callSid = new URL(req.url).searchParams.get("callSid") ?? "";
  if (callSid && acceptedDigits(params.Digits)) {
    patchInboundSession(callSid, { transferAccepted: true, transferOutcome: "connected" });
    return xmlResponse("<Response></Response>");
  }
  // Any other key is the owner saying no. The caller is told the same neutral thing as a missed transfer;
  // the record and the text to the owner say which it was (workLineCalls.ts).
  if (callSid) patchInboundSession(callSid, { transferOutcome: "declined" });
  return xmlResponse("<Response><Hangup/></Response>");
}
