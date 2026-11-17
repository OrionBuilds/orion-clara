// "Connect me to X" (clickToCall.ts): Twilio requests this when the owner answers the call Clara placed
// to their personal cell. It tells them who they're being connected to and asks them to press 1 (so a call
// that rolled to their voicemail never dials anyone), then — on step=accept — dials them in with the
// work caller ID. The target rides on the query string of a URL only Clara's own API call created, and
// Twilio signs the request over that exact URL — a forged or altered target fails the signature.

import { xmlResponse, twilioSignatureValid, twilioPublicUrl, speak } from "@/lib/clara/channels";
import { connectCallerId, connectPromptTwiml, connectDialTwiml, toE164 } from "@/lib/clara/clickToCall";
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

  const url = new URL(req.url);
  const number = toE164(url.searchParams.get("to") ?? "");
  const label = (url.searchParams.get("label") ?? "").slice(0, 60) || "them";
  if (!number) return xmlResponse(`<Response>${speak("I lost the number for that call. Ask me again.", publicBase(req), "owner")}<Hangup/></Response>`);

  const base = publicBase(req);
  // Second hit: the owner's key press. Only a 1 dials them — anything else (or voicemail's silence) hangs up.
  if (url.searchParams.get("step") === "accept") {
    if (String(params.Digits ?? "").trim() !== "1") return xmlResponse("<Response><Hangup/></Response>");
    await ledgerAppend({ kind: "call", actor: "clara", what: `connecting the owner to ${label}`, ref: params.CallSid, meta: { direction: "outbound" } }).catch(() => {});
    return xmlResponse(connectDialTwiml({ number, callerId: connectCallerId() }));
  }

  const next = new URLSearchParams({ to: number, label, step: "accept" });
  return xmlResponse(connectPromptTwiml({
    acceptUrl: `${base}/api/channels/twilio/connect?${next.toString()}`,
    speakXml: speak(`It's Clara. Press 1 and I'll connect you to ${label}.`, base, "owner"),
  }));
}
