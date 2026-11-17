// POST /api/prospects/research/[id]/resume
import { NextRequest, NextResponse } from "next/server";
import { requireInteragent, callOrUnavailable } from "@/lib/clara/prospecting/httpAuth";
import { updateResearchJob } from "@/lib/clara/prospecting/osBridge";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = requireInteragent(req);
  if (denied) return denied;
  const { id } = await params;
  const result = await callOrUnavailable(() => updateResearchJob(id, { status: "running", paused_reason: null }));
  if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: result.status });
  return NextResponse.json({ ok: true, job: result.data });
}
