// GET /api/meetings/wispr/status — connection + poll state (no tokens, no auth URL).

import { NextRequest, NextResponse } from "next/server";
import { verifyInteragentSecret } from "@autom8ionlab/agent-core";
import { principalFromHeaders } from "@/lib/clara/session";
import { wisprStatus } from "@/lib/clara/meetings/wispr";
import { meetingIngestMode } from "@/lib/clara/meetings/ingest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (!principalFromHeaders(req.headers) && !verifyInteragentSecret(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { pendingAuthUrl, ...s } = await wisprStatus();
  return NextResponse.json({ ...s, authPending: Boolean(pendingAuthUrl), mode: meetingIngestMode() });
}
