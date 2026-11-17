// Twilio VOICE webhook for Clara's OWN outbound business calls — driven by call-sessions.ts +
// business-call-brain.ts, NOT telephony.ts/voice/route.ts's inbound logic (that route's "how can
// I help you?" greeting is backwards for a call Clara herself placed with a purpose). Registered
// as the `url` on the Calls.json request in business-calls.ts's placeApprovedBusinessCall().

import { ensureBootstrapped } from "@/lib/clara/bootstrap";
import { xmlResponse, twilioSignatureValid, twilioPublicUrl, startRecordingTwiml } from "@/lib/clara/channels";
import { rehydrateSession, greetingTwiml, voicemailTwiml, handleBusinessTurn } from "@/lib/clara/business-calls";
import { setStatus } from "@/lib/clara/call-sessions";
import { append as ledgerAppend } from "@/lib/clara/ledger";
import { notifyOwner } from "@/lib/clara/notify";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function publicBase(req: Request): string {
  const host = req.headers.get("host") ?? "127.0.0.1:3939";
  const proto = req.headers.get("x-forwarded-proto") ?? "https";
  return `${proto}://${host}`;
}

const ROUTE_PATH = "/api/channels/twilio/business-call";
const FIRST_REPLY_MARKER = "rec=start";

export async function POST(req: Request) {
  await ensureBootstrapped();
  const params: Record<string, string> = {};
  try {
    const form = await req.formData();
    for (const [k, v] of form.entries()) params[k] = String(v);
  } catch { /* first hit sometimes lacks form */ }

  // includeQuery=true: this route's own action URLs carry `?approvalId=` (and later `&rec=start`)
  // — Twilio signs the exact URL it requested, so dropping the query would fail verification.
  if (!twilioSignatureValid(req, twilioPublicUrl(req, true), params)) {
    return new Response("invalid Twilio signature", { status: 403 });
  }

  const base = publicBase(req);
  const url = new URL(req.url);
  const approvalId = url.searchParams.get("approvalId");
  const callSid = params.CallSid ?? "";
  const isFirstReply = url.searchParams.get("rec") === "start";
  const actionPath = `${ROUTE_PATH}?approvalId=${encodeURIComponent(approvalId ?? "")}`;

  const session = await rehydrateSession(callSid, approvalId);
  if (!session) {
    await notifyOwner({
      kind: "call.business",
      priority: "critical",
      text: `Clara's business call (approval ${approvalId ?? "?"}) lost its session mid-call — couldn't proceed.`,
      dedupeKey: `business-call-lost:${callSid}`,
    }).catch(() => {});
    return xmlResponse(`<Response><Say voice="Polly.Joanna">Sorry, something went wrong on my end. Goodbye.</Say><Hangup/></Response>`);
  }

  // Machine detection — Twilio waits and reports AnsweredBy on this first webhook hit when
  // MachineDetection was enabled on the outbound Calls.json request.
  if (params.AnsweredBy?.startsWith("machine")) {
    setStatus(callSid, "voicemail");
    return xmlResponse(voicemailTwiml(session.objective, base));
  }

  const speech = (params.SpeechResult ?? "").trim();
  if (!speech) {
    // First human-answered hit — no recording yet, matches voice/route.ts's disclosure-before-
    // record ordering (Twilio only re-invokes this webhook once the Gather's spoken prompt has
    // fully played, so by the time we see speech the disclosure has too).
    await ledgerAppend({
      kind: "call",
      actor: "clara",
      what: `business call answered by a human: ${session.objective.businessName}`,
      ref: callSid,
      meta: { direction: "outbound", context: "business-call" },
    }).catch(() => {});
    return xmlResponse(greetingTwiml(session.objective, base, `${actionPath}&${FIRST_REPLY_MARKER}`));
  }

  const twiml = await handleBusinessTurn(callSid, speech, base, actionPath);
  if (isFirstReply) {
    const inner = twiml.replace(/^<Response>|<\/Response>$/g, "");
    const startRecord = startRecordingTwiml(base);
    return xmlResponse(`<Response>${startRecord}${inner}</Response>`);
  }
  return xmlResponse(twiml);
}
