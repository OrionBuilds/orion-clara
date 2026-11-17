// Twilio VOICE status callback — fires when a call reaches a terminal state.
//
// This is the path that files most real leads, not the "done" branch in the voice webhook. A caller
// who has said what they came to say hangs up; they do not wait for Clara to decide the
// conversation is complete. Without this route, every lead Clara qualified right up to the moment
// the caller ended the call would be discarded — the session lives only in memory, keyed by
// CallSid, and nothing would ever read it again.
//
// finalizeInboundCall() claims the finalize slot, so this racing with the voice webhook's own
// "done" branch is safe: whichever arrives first files the lead and the other no-ops.
//
// Wired by POST /api/system/phone as StatusCallback (StatusCallbackEvent=completed).

import { ensureBootstrapped } from "@/lib/clara/bootstrap";
import { twilioSignatureValid, twilioPublicUrl } from "@/lib/clara/channels";
import { setInboundStatus, getInboundSession } from "@/lib/clara/call-sessions";
import { finalizeInboundCall } from "@/lib/clara/leads";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: Request) {
  await ensureBootstrapped();
  const params: Record<string, string> = {};
  try {
    const form = await req.formData();
    for (const [k, v] of form.entries()) params[k] = String(v);
  } catch { /* nothing to do without a body */ }

  if (!twilioSignatureValid(req, twilioPublicUrl(req, true), params)) {
    return new Response("invalid Twilio signature", { status: 403 });
  }

  const callSid = params.CallSid ?? "";
  const callStatus = (params.CallStatus ?? "").toLowerCase();

  // Only terminal states. Twilio also sends initiated/ringing/in-progress when the callback is
  // configured for them, and finalizing on "in-progress" would file the lead mid-conversation.
  const TERMINAL = ["completed", "busy", "failed", "no-answer", "canceled"];
  if (!callSid || !TERMINAL.includes(callStatus)) {
    return new Response(null, { status: 204 });
  }

  // No session means this was a principal's call, an already-finalized one, or a call that never
  // got past the greeting. All three are nothing to do — not an error.
  if (!getInboundSession(callSid)) return new Response(null, { status: 204 });

  setInboundStatus(callSid, callStatus === "completed" ? "ended" : "voicemail");
  // "qualified" is the honest label: whatever Clara had learned by hangup is what gets filed, and
  // finalizeInboundCall already declines to write anything when she learned nothing.
  // A work-line caller who was bridged to the owner (holdTransfer.ts) had that conversation live; if this
  // callback wins the finalize race, it must not file the call as one the owner still needs to return.
  const bridged = getInboundSession(callSid)?.transferOutcome === "connected";
  await finalizeInboundCall(callSid, bridged ? "transferred" : "qualified").catch(() => {});

  return new Response(null, { status: 204 });
}
