// GET /api/prospects/sequences/[id] — settings + ordered steps + enrollment counts by status.
// The Office's builder page itself reads this straight from the OS (getSequenceDetail), same
// reasoning as sequences/route.ts's GET; this exists for parity and for callers without an OS
// session.
// PATCH /api/prospects/sequences/[id] — sequence-level settings (send window, throttle,
// from_identity, exit conditions, status draft→active→paused→archived, …). Steps are their own
// PUT (steps/route.ts) since sequence_steps_set replaces the whole list.
import { NextRequest, NextResponse } from "next/server";
import { requireInteragent, callOrUnavailable } from "@/lib/clara/prospecting/httpAuth";
import { sequencesGet, sequencesUpdate, type SequenceStatus } from "@/lib/clara/prospecting/osBridge";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STATUSES: SequenceStatus[] = ["draft", "active", "paused", "archived"];

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = requireInteragent(_req);
  if (denied) return denied;
  const { id } = await params;
  const result = await callOrUnavailable(() => sequencesGet(id));
  if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: result.status });
  if (!result.data.sequence) return NextResponse.json({ ok: false, error: "sequence not found" }, { status: 404 });
  return NextResponse.json({ ok: true, sequence: result.data.sequence, steps: result.data.steps, enrollment_counts: result.data.enrollment_counts });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = requireInteragent(req);
  if (denied) return denied;
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  if (!Object.keys(body).length) {
    return NextResponse.json({ ok: false, error: "no fields to update" }, { status: 400 });
  }
  if (body.status !== undefined && !STATUSES.includes(body.status as SequenceStatus)) {
    return NextResponse.json({ ok: false, error: `status must be one of ${STATUSES.join(", ")}` }, { status: 400 });
  }
  const result = await callOrUnavailable(() => sequencesUpdate(id, body));
  if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: result.status });
  if (!result.data.sequence) return NextResponse.json({ ok: false, error: "sequence not found" }, { status: 404 });
  return NextResponse.json({ ok: true, sequence: result.data.sequence });
}
