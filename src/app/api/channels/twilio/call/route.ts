// Outbound call. POST { to, message } — Clara calls the number and speaks `message`.
// Recording + disclosure automatic. For a fully interactive outbound conversation, the call is
// answered by /api/channels/twilio/voice which runs the same gather-loop.

import { NextRequest, NextResponse } from "next/server";
import { ensureBootstrapped } from "@/lib/clara/bootstrap";
import { principalFromHeaders } from "@/lib/clara/session";
import { placeCall, esc, twilioConfig, startRecordingTwiml } from "@/lib/clara/channels";
import { RECORDING_DISCLOSURE } from "@/lib/clara/recorder";
import { append as ledgerAppend } from "@/lib/clara/ledger";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  await ensureBootstrapped();
  if (!principalFromHeaders(req.headers)) return NextResponse.json({ error: "not authenticated" }, { status: 401 });

  const { to, message, interactive } = await req.json() as { to: string; message: string; interactive?: boolean };
  if (!to || !message) return NextResponse.json({ error: "to + message required" }, { status: 400 });

  const cfg = twilioConfig();
  if (!cfg) return NextResponse.json({ error: "Twilio not configured" }, { status: 400 });

  let payload: { twiml?: string; url?: string };
  if (interactive && cfg.publicBase) {
    payload = { url: `${cfg.publicBase}/api/channels/twilio/voice` };
  } else {
    // One-shot delivery: disclosure plays as a fully blocking <Say> BEFORE <Start><Recording> is
    // even reached in the document, so recording genuinely cannot start until the disclosure
    // has finished (unlike Record=true at the Call-resource level, which starts at answer and
    // races the disclosure — see channels.ts placeCall()).
    const say = (t: string) => `<Say voice="Polly.Joanna">${esc(t)}</Say>`;
    const startRecord = cfg.publicBase
      ? startRecordingTwiml(cfg.publicBase)
      : "";
    payload = {
      twiml: `<?xml version="1.0" encoding="UTF-8"?><Response>${say(RECORDING_DISCLOSURE)}<Pause length="1"/>${startRecord}${say(message)}<Pause length="1"/>${say("Goodbye.")}</Response>`,
    };
  }

  const res = await placeCall(to, payload);
  if (res.ok) {
    await ledgerAppend({
      kind: "call",
      actor: "clara",
      what: `outbound call to ${to}: "${message.slice(0, 120)}"`,
      ref: res.sid,
      meta: { direction: "outbound", interactive: Boolean(interactive) },
    });
  }
  return NextResponse.json(res, { status: res.ok ? 200 : 502 });
}
