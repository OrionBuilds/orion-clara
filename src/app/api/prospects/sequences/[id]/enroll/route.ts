// POST /api/prospects/sequences/[id]/enroll — enroll explicit companies or a whole list in this
// sequence (sequence_enroll), keyed off the sequence rather than the list — the builder's own
// "launch from here" action, alongside /lists/[id]/launch's list-first equivalent (PR 14). Body:
// { company_ids?: string[], list_id?: string, start_at?: string } — mirrors the Office's own
// companies/[id]/enroll route's comment (same body shape, just plural).
import { NextRequest, NextResponse } from "next/server";
import { requireInteragent, callOrUnavailable } from "@/lib/clara/prospecting/httpAuth";
import { sequenceEnroll } from "@/lib/clara/prospecting/osBridge";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = requireInteragent(req);
  if (denied) return denied;
  const { id } = await params;

  const body = (await req.json().catch(() => ({}))) as { company_ids?: unknown; list_id?: unknown; start_at?: unknown };
  const companyIds = Array.isArray(body.company_ids) ? body.company_ids.filter((c): c is string => typeof c === "string" && !!c) : [];
  const listId = typeof body.list_id === "string" ? body.list_id.trim() : "";
  if (!companyIds.length && !listId) {
    return NextResponse.json({ ok: false, error: "company_ids or list_id is required" }, { status: 400 });
  }
  const startAt = typeof body.start_at === "string" ? body.start_at : undefined;

  const result = await callOrUnavailable(() =>
    sequenceEnroll({
      sequence_id: id,
      members: companyIds.length ? companyIds.map((company_id) => ({ company_id })) : undefined,
      list_id: listId || undefined,
      start_at: startAt,
      enrolled_via: "office",
    }),
  );
  if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: result.status });
  return NextResponse.json({
    ok: true,
    enrolled: result.data.enrolled.length,
    skipped: result.data.skipped,
    needs_approval: result.data.needs_approval ?? false,
    approval_reason: result.data.approval_reason,
  });
}
