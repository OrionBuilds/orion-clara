// The caller's hold loop (holdTransfer.ts). Twilio requests this when the caller is parked and again
// every time the returned TwiML finishes, so each replay is a chance to check the hold is still on:
// gone or past its deadline → <Leave/>, which sends the caller to hold/done. That is what makes a
// process restart mid-hold safe — the timer that normally ends the hold lives in the old process.

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
import { holdFor, holdExpired, holdAudioUrl, waitTwiml, leaveTwiml } from "@/lib/clara/holdTransfer";
import { hasHoldAudioFile } from "@/lib/clara/holdAudio";

export async function POST(req: Request) {
  const params = await readParams(req);
  // includeQuery=true — the callSid rides on the query string (see holdTransfer.ts).
  if (!twilioSignatureValid(req, twilioPublicUrl(req, true), params)) {
    return new Response("invalid Twilio signature", { status: 403 });
  }
  const callSid = new URL(req.url).searchParams.get("callSid") ?? params.CallSid ?? "";
  const h = callSid ? holdFor(callSid) : null;
  if (!h || (h.state !== "waiting" && h.state !== "accepted") || (h.state === "waiting" && holdExpired(h, Date.now()))) {
    return xmlResponse(leaveTwiml());
  }
  return xmlResponse(waitTwiml(holdAudioUrl(publicBase(req), process.env, await hasHoldAudioFile())));
}
