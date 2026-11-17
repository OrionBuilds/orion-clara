// Where a held caller lands when the owner didn't take the call (holdTransfer.returnCaller redirects the
// live leg here): the neutral line, then the ordinary <Gather> into the voice route, so Clara finishes
// the message with everything she already learned on this call.

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
import { gather } from "@/lib/clara/channels";
import { returnLine } from "@/lib/clara/holdTransfer";
import { appendInboundTurn } from "@/lib/clara/call-sessions";

export async function POST(req: Request) {
  const params = await readParams(req);
  if (!twilioSignatureValid(req, twilioPublicUrl(req, true), params)) {
    return new Response("invalid Twilio signature", { status: 403 });
  }
  const callSid = new URL(req.url).searchParams.get("callSid") ?? params.CallSid ?? "";
  const line = returnLine();
  if (callSid) appendInboundTurn(callSid, { role: "clara", text: line, at: new Date().toISOString() });
  return xmlResponse(gather(line, publicBase(req), "/api/channels/twilio/voice", "stranger"));
}
