// The caller left the hold queue (holdTransfer.ts): bridged to the owner and that call is over, left via
// the wait route's <Leave/> backstop, hung up while waiting, or redirected away by Clara (whose
// TwiML takes over, so nothing is needed here).

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
import { classifyQueueResult, onCallerLeft, markReturned, returnLine, finishHold } from "@/lib/clara/holdTransfer";
import { appendInboundTurn, patchInboundSession } from "@/lib/clara/call-sessions";
import { finalizeInboundCall as finalize } from "@/lib/clara/leads";

export async function POST(req: Request) {
  const params = await readParams(req);
  if (!twilioSignatureValid(req, twilioPublicUrl(req, true), params)) {
    return new Response("invalid Twilio signature", { status: 403 });
  }
  const callSid = new URL(req.url).searchParams.get("callSid") ?? params.CallSid ?? "";
  const result = classifyQueueResult(params.QueueResult);
  const base = publicBase(req);

  switch (result) {
    case "bridged":
      // They talked to the owner and that conversation has ended; file what was learned before the transfer.
      await finalize(callSid, "transferred").catch(() => {});
      await finishHold(callSid);
      return xmlResponse("<Response><Hangup/></Response>");
    case "hangup":
      await onCallerLeft(callSid);
      await finalize(callSid, "qualified").catch(() => {});
      await finishHold(callSid);
      return xmlResponse("<Response><Hangup/></Response>");
    case "redirected":
    case "bridging-in-process":
      // Clara's redirect (or the bridge) already owns this leg.
      return xmlResponse("<Response></Response>");
    default: {
      // leave (the backstop), error, queue-full, system-error: the caller is still on the line and
      // this TwiML is what they hear next — the same neutral line, then back into the conversation.
      // No redirect here: they have already left the queue.
      if (!(await markReturned(callSid, result === "leave" ? "no-reply" : "no-answer"))) {
        // No record (a restart mid-hold): the session still learns the attempt didn't connect.
        patchInboundSession(callSid, { transferTried: true, transferOutcome: "no-reply" });
      }
      const line = returnLine();
      appendInboundTurn(callSid, { role: "clara", text: line, at: new Date().toISOString() });
      return xmlResponse(gather(line, base, "/api/channels/twilio/voice", "stranger"));
    }
  }
}
