// Twilio status callback for the morning call — registered as StatusCallback on the Calls.json
// request in owner-call.ts. Twilio POSTs here once, when the call ends (statusCallbackEvent=completed
// covers every terminal state: completed, no-answer, busy, failed, canceled). This is where the
// single retry is scheduled and where a completed call is finalized (recap email, ledger).

import { ensureBootstrapped } from "@/lib/clara/bootstrap";
import { twilioSignatureValid, twilioPublicUrl } from "@/lib/clara/channels";
import { getOwnerSession } from "@/lib/clara/owner-call-sessions";
import { handleCallStatus } from "@/lib/clara/owner-call";
import { append as ledgerAppend } from "@/lib/clara/ledger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  await ensureBootstrapped();
  const params: Record<string, string> = {};
  try {
    const form = await req.formData();
    for (const [k, v] of form.entries()) params[k] = String(v);
  } catch { /* ignore */ }

  if (!twilioSignatureValid(req, twilioPublicUrl(req, true), params)) {
    return new Response("invalid Twilio signature", { status: 403 });
  }

  const sid = new URL(req.url).searchParams.get("sid") ?? "";
  const session = sid ? await getOwnerSession(sid).catch(() => null) : null;
  if (!session) return new Response("ok", { status: 200 });

  const callSid = params.CallSid ?? "";
  if (session.callSid && callSid && session.callSid !== callSid) {
    await ledgerAppend({ kind: "call", actor: "clara", what: "owner-call status CallSid mismatch — ignored", ref: callSid, meta: { sessionId: sid } }).catch(() => {});
    return new Response("ok", { status: 200 });
  }

  const outcome = await handleCallStatus(session, params.CallStatus ?? "").catch((e) => `error: ${String(e).slice(0, 120)}`);
  await ledgerAppend({ kind: "call", actor: "clara", what: `morning call status ${params.CallStatus ?? "?"} → ${outcome}`, ref: callSid, meta: { sessionId: sid, duration: params.CallDuration, answeredBy: params.AnsweredBy } }).catch(() => {});
  return new Response("ok", { status: 200 });
}
