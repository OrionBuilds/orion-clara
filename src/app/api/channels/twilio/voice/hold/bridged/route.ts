// Runs on the CALLER's leg the moment the owner's <Dial><Queue> dequeues them, just before the two legs
// are bridged (holdTransfer.ts). The one place that knows for certain the transfer connected.

import { xmlResponse, twilioSignatureValid, twilioPublicUrl } from "@/lib/clara/channels";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function publicBase(req: Request): string {
  const host = req.headers.get("host") ?? "127.0.0.1:3939";
  const proto = req.headers.get("x-forwarded-proto") ?? "https";
  return `${proto}://${host}`;
}

async function readParams(req: Request): Promise<Record<string, string>> {
  const params: Record<string, string> = {};
  try {
    const form = await req.formData();
    for (const [k, v] of form.entries()) params[k] = String(v);
  } catch { /* Twilio always posts a form; an empty one just fails the signature check */ }
  return params;
}
import { speak } from "@/lib/clara/channels";
import { markBridged } from "@/lib/clara/holdTransfer";
import { patchInboundSession } from "@/lib/clara/call-sessions";
import { OWNER_FIRST } from "@/lib/clara/owner";

export async function POST(req: Request) {
  const params = await readParams(req);
  if (!twilioSignatureValid(req, twilioPublicUrl(req, true), params)) {
    return new Response("invalid Twilio signature", { status: 403 });
  }
  const callSid = new URL(req.url).searchParams.get("callSid") ?? params.CallSid ?? "";
  if (callSid) markBridged(callSid, patchInboundSession);
  return xmlResponse(`<Response>${speak(`Connecting you to ${OWNER_FIRST} now.`, publicBase(req), "stranger")}</Response>`);
}
