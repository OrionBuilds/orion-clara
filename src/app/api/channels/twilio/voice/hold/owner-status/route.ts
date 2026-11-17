// Status callback for the leg to the owner's cell (holdTransfer.ts). If it ended without ever bridging —
// no answer, busy, failed, or answered and abandoned — the caller is still parked and comes back to
// Clara. A leg that bridged is ignored here; the caller's leg reports that.

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
import { onOwnerLegEnded } from "@/lib/clara/holdTransfer";

export async function POST(req: Request) {
  const params = await readParams(req);
  if (!twilioSignatureValid(req, twilioPublicUrl(req, true), params)) {
    return new Response("invalid Twilio signature", { status: 403 });
  }
  const callSid = new URL(req.url).searchParams.get("callSid") ?? "";
  if (callSid) await onOwnerLegEnded(callSid, params.CallStatus);
  return new Response(null, { status: 204 });
}
