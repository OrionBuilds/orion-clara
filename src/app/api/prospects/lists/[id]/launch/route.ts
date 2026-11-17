// POST /api/prospects/lists/[id]/launch — the Office's "Launch campaign" button on
// /prospects/lists/[id]: enrolls the whole list into a sequence. The OS's `sequence_enroll` RPC
// runs suppression_check per member itself (blocked members come back in `skipped`, never
// enrolled) — this route is a thin pass-through, same shape as `promote/route.ts`.
//
// Body: { sequence_id: string, start_at?: string }
import { NextRequest, NextResponse } from "next/server";
import { requireInteragent, callOrUnavailable } from "@/lib/clara/prospecting/httpAuth";
import { sequenceEnroll } from "@/lib/clara/prospecting/osBridge";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = requireInteragent(req);
  if (denied) return denied;
  const { id: listId } = await params;

  const body = (await req.json().catch(() => ({}))) as { sequence_id?: unknown; start_at?: unknown };
  const sequenceId = typeof body.sequence_id === "string" ? body.sequence_id.trim() : "";
  if (!sequenceId) return NextResponse.json({ ok: false, error: "sequence_id is required" }, { status: 400 });
  const startAt = typeof body.start_at === "string" ? body.start_at : undefined;

  const result = await callOrUnavailable(() => sequenceEnroll({ sequence_id: sequenceId, list_id: listId, start_at: startAt, enrolled_via: "office" }));
  if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: result.status });
  return NextResponse.json({
    ok: true,
    enrolled: result.data.enrolled.length,
    skipped: result.data.skipped,
    needs_approval: result.data.needs_approval ?? false,
    approval_reason: result.data.approval_reason,
  });
}
