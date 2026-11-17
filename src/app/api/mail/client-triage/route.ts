// POST /api/mail/client-triage — run one client-email triage pass now (owner UI / smoke test).
// Body { dryRun?: boolean }: dryRun returns what CLARA WOULD do for each unread message (client
// match, robot filter, planned tasks) without sending, drafting, dispatching or recording.

import { NextResponse } from "next/server";
import { runClientEmailTriage, clientAckMode } from "@/lib/clara/clientEmailTriage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({})) as { dryRun?: boolean };
  const out = await runClientEmailTriage({ dryRun: body.dryRun === true });
  try { return NextResponse.json({ ackMode: clientAckMode(), ...JSON.parse(out) }); }
  catch { return NextResponse.json({ ackMode: clientAckMode(), summary: out }); }
}
