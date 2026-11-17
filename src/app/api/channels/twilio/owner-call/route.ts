// Twilio VOICE webhook for the 08:30 morning call Clara places TO THE OWNER (owner-call.ts).
//
// This is not the inbound route (voice/route.ts) and not the business-call route. Those identify the
// far end from `From`; on a call Clara placed, `From` is her own number, so resolving it would hand
// The owner the stranger persona. Here identity is the call itself: it must be outbound and its `To` must
// be the number the session was placed to. The principal is the constant "owner". Nothing from the
// stranger, lead-qualification or business-call brains is imported — see scripts/probes/owner-call-imports.ts.
//
// No <Record>: a private owner briefing, nothing in the recording disclosure applies.

import { ensureBootstrapped } from "@/lib/clara/bootstrap";
import { xmlResponse, twilioSignatureValid, twilioPublicUrl } from "@/lib/clara/channels";
import { getOwnerSession, saveOwnerSession } from "@/lib/clara/owner-call-sessions";
import { identityOk, openingTwiml, voicemailTwiml, handleOwnerTurn, hangupTwiml, sessionExpired } from "@/lib/clara/owner-call";
import { append as ledgerAppend } from "@/lib/clara/ledger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function publicBase(req: Request): string {
  const host = req.headers.get("host") ?? "127.0.0.1:3939";
  const proto = req.headers.get("x-forwarded-proto") ?? "https";
  return `${proto}://${host}`;
}

export async function POST(req: Request) {
  await ensureBootstrapped();
  const params: Record<string, string> = {};
  try {
    const form = await req.formData();
    for (const [k, v] of form.entries()) params[k] = String(v);
  } catch { /* first hit sometimes lacks form */ }

  // includeQuery=true: our action URLs carry ?sid=&t=&silence= and Twilio signs the exact URL.
  if (!twilioSignatureValid(req, twilioPublicUrl(req, true), params)) {
    return new Response("invalid Twilio signature", { status: 403 });
  }

  const base = publicBase(req);
  const url = new URL(req.url);
  const sid = url.searchParams.get("sid") ?? "";
  const silence = url.searchParams.get("silence") === "1";
  const hasTurn = url.searchParams.has("t");
  const callSid = params.CallSid ?? "";

  const session = sid ? await getOwnerSession(sid).catch(() => null) : null;
  if (!session || sessionExpired(session)) {
    await ledgerAppend({ kind: "call", actor: "clara", what: `owner-call webhook with ${session ? "an expired" : "an unknown"} session`, ref: callSid, meta: { sid } }).catch(() => {});
    return xmlResponse(hangupTwiml("Sorry, I lost the thread. Your brief is in your email.", base));
  }

  if (!identityOk(params, session)) {
    await ledgerAppend({ kind: "call", actor: "clara", what: "owner-call identity mismatch — refused", ref: callSid, meta: { sessionId: sid, direction: params.Direction, toKey: String(params.To ?? "").slice(-4) } }).catch(() => {});
    return new Response("forbidden", { status: 403 });
  }
  if (session.callSid && callSid && session.callSid !== callSid) {
    await ledgerAppend({ kind: "call", actor: "clara", what: "owner-call CallSid mismatch — refused", ref: callSid, meta: { sessionId: sid } }).catch(() => {});
    return new Response("forbidden", { status: 403 });
  }

  // Machine detection: Twilio reports AnsweredBy on the first webhook hit.
  if (params.AnsweredBy?.startsWith("machine")) {
    session.status = "voicemail";
    await saveOwnerSession(session);
    await ledgerAppend({ kind: "call", actor: "clara", what: "morning call reached voicemail", ref: callSid, meta: { sessionId: sid, answeredBy: params.AnsweredBy } }).catch(() => {});
    return xmlResponse(voicemailTwiml(session, base));
  }

  const speech = (params.SpeechResult ?? "").trim();
  if (!hasTurn && !speech && !silence) {
    session.status = "in-progress";
    await saveOwnerSession(session);
    await ledgerAppend({ kind: "call", actor: "clara", what: "morning call answered", ref: callSid, meta: { sessionId: sid, attempt: session.attempt, purpose: session.purpose } }).catch(() => {});
    return xmlResponse(openingTwiml(session, base));
  }

  try {
    const twiml = await handleOwnerTurn(session, { speech, silence, callSid, base });
    return xmlResponse(twiml);
  } catch (e) {
    await ledgerAppend({ kind: "call", actor: "clara", what: `morning call turn error: ${String(e).slice(0, 160)}`, ref: callSid, meta: { sessionId: sid } }).catch(() => {});
    return xmlResponse(hangupTwiml("I hit a snag; your brief is in your email.", base));
  }
}
