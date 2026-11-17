// POST /api/prospects/research/[id]/pause
import { NextRequest, NextResponse } from "next/server";
import { requireInteragent, callOrUnavailable } from "@/lib/clara/prospecting/httpAuth";
import { updateResearchJob } from "@/lib/clara/prospecting/osBridge";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = requireInteragent(req);
  if (denied) return denied;
  const { id } = await params;
  const result = await callOrUnavailable(() => updateResearchJob(id, { status: "paused", paused_reason: "owner" }));
  if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: result.status });
  return NextResponse.json({ ok: true, job: result.data });
}
