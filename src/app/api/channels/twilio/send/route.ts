// Outbound SMS from Clara. POST { to, body } (defaults to the owner if to is omitted).

import { NextRequest, NextResponse } from "next/server";
import { ensureBootstrapped } from "@/lib/clara/bootstrap";
import { sendSMS, twilioConfig } from "@/lib/clara/channels";
import { append as ledgerAppend } from "@/lib/clara/ledger";

export const runtime = "nodejs";

export async function GET() {
  await ensureBootstrapped();
  const cfg = twilioConfig();
  return NextResponse.json({
    configured: Boolean(cfg),
    claraNumber: cfg?.from ?? null,
    ownerNumber: cfg?.ownerNumber ?? null,
  });
}

export async function POST(req: NextRequest) {
  await ensureBootstrapped();
  const b = await req.json().catch(() => ({}));
  const text = String(b.body ?? "").trim();
  if (!text) return NextResponse.json({ error: "body required" }, { status: 400 });
  const cfg = twilioConfig();
  const to = String(b.to ?? cfg?.ownerNumber ?? "").trim();
  if (!to) return NextResponse.json({ error: "no recipient (pass 'to' or set OWNER_PHONE)" }, { status: 400 });
  const res = await sendSMS(to, text);
  if (res.ok) {
    await ledgerAppend({ kind: "sms.sent", actor: "clara", what: `SMS to ${to}: "${text.slice(0, 120)}"`, ref: res.sid });
  }
  return NextResponse.json(res, { status: res.ok ? 200 : 502 });
}
