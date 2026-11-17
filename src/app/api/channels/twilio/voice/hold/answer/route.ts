// The owner's cell answered the call Clara placed after their "1" (holdTransfer.ts). Twilio finishes
// answering-machine detection before requesting this, so AnsweredBy says whether it's the owner:
//   human   → a short whisper, then <Dial><Queue> pulls the parked caller into this call.
//   machine → hang up the owner's leg; the caller is redirected back to Clara (never into their voicemail).
//   unknown → "press any key" (the existing whisper); a key here re-enters with confirmed=1.

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
import { holdFor, onOwnerAnswered, ownerAnswerTwiml, ownerWhisperLine, ownerConfirmWhisperLine, declineOnWhisper, HOLD_PATH } from "@/lib/clara/holdTransfer";
import { whisperTwiml } from "@/lib/clara/workLine";

export async function POST(req: Request) {
  const params = await readParams(req);
  if (!twilioSignatureValid(req, twilioPublicUrl(req, true), params)) {
    return new Response("invalid Twilio signature", { status: 403 });
  }
  const url = new URL(req.url);
  const callSid = url.searchParams.get("callSid") ?? "";
  const confirmed = url.searchParams.get("confirmed") === "1" && Boolean(params.Digits);
  const base = publicBase(req);
  const h = callSid ? holdFor(callSid) : null;
  const qs = `callSid=${encodeURIComponent(callSid)}`;

  const bridge = () => xmlResponse(ownerAnswerTwiml({
    sayXml: speak(ownerWhisperLine(h!), base, "owner"),
    queueName: h!.queueName,
    bridgedUrl: `${base}${HOLD_PATH}/bridged?${qs}`,
    actionUrl: `${base}${HOLD_PATH}/owner-done?${qs}`,
  }));

  if (confirmed) {
    // Press 1 = take it, press 2 (or anything else) = pass. "2" is the explicit decline wording in
    // the whisper line; any other digit is treated as decline to be safe (owner rule 2026-10-02).
    if (params.Digits === "1" && h?.state === "accepted") return bridge();
    if (callSid) await declineOnWhisper(callSid);
    return xmlResponse("<Response><Hangup/></Response>");
  }

  const decision = await onOwnerAnswered(callSid, params.AnsweredBy);
  // onOwnerAnswered now returns `confirm` on both human and unknown — the whisper gates the
  // bridge on a digit press, never auto-connects. `bridge` kept as a branch for test coverage
  // and in case a future deps override wants the old behaviour.
  if (decision.action === "bridge") return bridge();
  if (decision.action === "confirm") {
    const text = ownerConfirmWhisperLine(h!);
    return xmlResponse(whisperTwiml({ text, speakXml: speak(text, base, "owner"), acceptUrl: `${base}${HOLD_PATH}/answer?${qs}&confirmed=1` }));
  }
  return xmlResponse("<Response><Hangup/></Response>");
}
