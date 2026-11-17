// GET /api/prospects/enrollments?sequence_id=... — the enrollments table behind
// /prospects/sequences/[id]/enrollments. The Office's own page reads this straight from the OS
// (listSequenceEnrollments in lib/office/prospects/reads.ts) rather than through Clara, same as
// sequences/route.ts's GET; built here for parity and for callers without an OS session.
import { NextRequest, NextResponse } from "next/server";
import { requireInteragent, callOrUnavailable } from "@/lib/clara/prospecting/httpAuth";
import { sequenceEnrollmentsList } from "@/lib/clara/prospecting/osBridge";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function num(v: string | null): number | undefined {
  if (v === null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export async function GET(req: NextRequest) {
  const denied = requireInteragent(req);
  if (denied) return denied;
  const q = req.nextUrl.searchParams;
  const sequenceId = q.get("sequence_id") ?? "";
  if (!sequenceId) return NextResponse.json({ ok: false, error: "sequence_id is required" }, { status: 400 });

  const result = await callOrUnavailable(() =>
    sequenceEnrollmentsList({ sequence_id: sequenceId, status: q.get("status") ?? undefined, limit: num(q.get("limit")) ?? 200, offset: num(q.get("offset")) ?? 0 }),
  );
  if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: result.status });
  return NextResponse.json({ ok: true, enrollments: result.data.enrollments });
}
