// Twilio call-status callback for outbound business calls — fires exactly once when the call
// ends (StatusCallbackEvent=completed), however it ended: Clara hung up, the business hung up,
// no-answer, busy, or failed. Single convergence point for finalizing the call, instead of
// building separate "who ended it" code paths.

import { twilioSignatureValid, twilioPublicUrl } from "@/lib/clara/channels";
import { finalizeBusinessCall } from "@/lib/clara/business-calls";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const params: Record<string, string> = {};
  try {
    const form = await req.formData();
    for (const [k, v] of form.entries()) params[k] = String(v);
  } catch { return new Response("ok"); }

  if (!twilioSignatureValid(req, twilioPublicUrl(req, true), params)) {
    return new Response("invalid Twilio signature", { status: 403 });
  }

  const callSid = params.CallSid;
  if (params.CallStatus !== "completed" || !callSid) return new Response("ok");

  await finalizeBusinessCall(callSid).catch(() => {});
  return new Response("ok");
}
