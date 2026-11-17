// POST /api/prospects/sequences/[id]/preview — render one step against a real company's own
// facts/signals (personalize.ts, via sequencePreview.ts), no send. Body: { company_id,
// step_position } — matches the Office's SequencePreview.tsx exactly (it sends step_position, not
// step_no/step_id — there's no per-step id round trip yet since a step's id isn't surfaced back to
// the builder until PR 15's own editor saves one).
import { NextRequest, NextResponse } from "next/server";
import { requireInteragent } from "@/lib/clara/prospecting/httpAuth";
import { OsProspectingUnavailableError } from "@/lib/clara/prospecting/osBridge";
import { renderSequencePreview } from "@/lib/clara/prospecting/sequencePreview";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = requireInteragent(req);
  if (denied) return denied;
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as { company_id?: unknown; step_position?: unknown };
  const companyId = typeof body.company_id === "string" ? body.company_id.trim() : "";
  if (!companyId) return NextResponse.json({ ok: false, error: "company_id is required" }, { status: 400 });
  const stepPosition = typeof body.step_position === "number" ? body.step_position : Number(body.step_position);
  if (!Number.isInteger(stepPosition) || stepPosition < 1) {
    return NextResponse.json({ ok: false, error: "step_position (a positive integer) is required" }, { status: 400 });
  }

  try {
    const outcome = await renderSequencePreview({ sequenceId: id, companyId, stepPosition });
    if (!outcome.ok) {
      if (outcome.error.kind === "sequence_not_found") return NextResponse.json({ ok: false, error: "sequence not found" }, { status: 404 });
      if (outcome.error.kind === "step_not_found") return NextResponse.json({ ok: false, error: `no step at position ${outcome.error.position}` }, { status: 400 });
      return NextResponse.json({ ok: false, error: "company not found" }, { status: 404 });
    }
    const r = outcome.result;
    return NextResponse.json({
      ok: true,
      subject: r.subject,
      body: r.body,
      task_title: r.task_title,
      citations: r.citations,
      rationale: r.rationale,
      used_fallback: r.used_fallback,
    });
  } catch (e) {
    if (e instanceof OsProspectingUnavailableError) {
      return NextResponse.json({ ok: false, error: "the OS prospecting tables aren't live yet" }, { status: 503 });
    }
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
