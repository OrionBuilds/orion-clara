// GET /api/prospects/linkedin-queue — the last few weekdays' LinkedIn drafts (connection note +
// follow-up DM per person) for the Office "LinkedIn queue" view. Read-only; nothing here sends.

import { NextRequest, NextResponse } from "next/server";
import { requireInteragent } from "@/lib/clara/prospecting/httpAuth";
import { readQueue, linkedinQueueMode } from "@/lib/clara/prospecting/linkedinQueue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const denied = requireInteragent(req);
  if (denied) return denied;
  const days = Math.min(30, Math.max(1, Number(req.nextUrl.searchParams.get("days")) || 5));
  return NextResponse.json({ ok: true, mode: linkedinQueueMode(), days: await readQueue(days) });
}
