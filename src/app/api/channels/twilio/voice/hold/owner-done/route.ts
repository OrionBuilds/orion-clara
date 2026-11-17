// The owner's <Dial><Queue> finished (holdTransfer.ts): the bridged call ended, or the queue was empty
// because the caller left first. Either way the owner's leg is done. What happens to the caller is decided
// by their own leg (hold/done) and by owner-status.

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

export async function POST(req: Request) {
  const params = await readParams(req);
  if (!twilioSignatureValid(req, twilioPublicUrl(req, true), params)) {
    return new Response("invalid Twilio signature", { status: 403 });
  }
  return xmlResponse("<Response><Hangup/></Response>");
}
