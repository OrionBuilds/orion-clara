// Twilio calls this when OWNER'S phone answers a warm-transferred inbound business call
// (Autonomy Spec v0.1, item #10). The TwiML returned here plays ONLY to the owner — the original
// caller is still on hold hearing ringback throughout. Since 2026-09-25 it asks them to press 1
// (whisper/accept) before the legs are bridged, so a transfer can't land in their voicemail.

import { xmlResponse, twilioSignatureValid, twilioPublicUrl, speak } from "@/lib/clara/channels";
import { getInboundSession } from "@/lib/clara/call-sessions";
import { whisperTwiml, whisperText } from "@/lib/clara/workLine";

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
  } catch { /* Twilio always posts here, but fail open to the generic whisper below */ }

  // includeQuery=true — the callSid is carried on the query string (see dial() call site).
  if (!twilioSignatureValid(req, twilioPublicUrl(req, true), params)) {
    return new Response("invalid Twilio signature", { status: 403 });
  }

  const callSid = new URL(req.url).searchParams.get("callSid") ?? "";
  const state = callSid ? getInboundSession(callSid) : null;
  const base = publicBase(req);
  // Press 1 to take it (workLine.ts): a voicemail greeting can't press a key, so the caller is never
  // bridged into the owner's voicemail. No key → this leg hangs up and dial-status takes the caller back.
  return xmlResponse(whisperTwiml({
    text: whisperText(state),
    speakXml: speak(whisperText(state), base, "owner"),
    acceptUrl: `${base}/api/channels/twilio/voice/whisper/accept?callSid=${encodeURIComponent(callSid)}`,
  }));
}
