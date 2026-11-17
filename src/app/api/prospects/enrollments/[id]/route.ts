// PATCH /api/prospects/enrollments/[id] — pause / resume / stop one enrollment. Body:
// { action: "pause" | "resume" | "stop", reason? }.
//
// "stop" maps to the OS's sequence_unenroll (terminal — status→'stopped', next_run_at cleared;
// see osBridge.ts's sequenceUnenroll doc comment). "pause"/"resume" have NO backing OS tool today
// — sequence_enroll only enrolls new members and sequence_unenroll is one-way terminal; there is
// no sequence_enrollments_update (checked against orion/mcp-server/src/tools/prospects.ts's full
// tool list, 2026-10-01). Rather than fake a pause by misusing stop (which would make "resume"
// impossible — a stopped enrollment can't un-stop), these two actions answer the same
// `not_implemented: true` contract every other not-yet-shipped Clara route uses (the Office's
// claraProspects() already renders that as "coming in a later release"), honest about the real
// gap: closing it needs a new orion MCP tool, not something CLARA alone can build.
import { NextRequest, NextResponse } from "next/server";
import { requireInteragent, callOrUnavailable } from "@/lib/clara/prospecting/httpAuth";
import { sequenceUnenroll } from "@/lib/clara/prospecting/osBridge";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ACTIONS = ["pause", "resume", "stop"] as const;
type Action = (typeof ACTIONS)[number];

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = requireInteragent(req);
  if (denied) return denied;
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as { action?: unknown; reason?: unknown };
  if (typeof body.action !== "string" || !ACTIONS.includes(body.action as Action)) {
    return NextResponse.json({ ok: false, error: `action must be one of ${ACTIONS.join(", ")}` }, { status: 400 });
  }
  const action = body.action as Action;
  const reason = typeof body.reason === "string" ? body.reason : undefined;

  if (action === "pause" || action === "resume") {
    return NextResponse.json(
      { ok: false, not_implemented: true, error: `enrollment "${action}" needs an orion MCP tool that doesn't exist yet — only "stop" is live` },
      { status: 501 },
    );
  }

  const result = await callOrUnavailable(() => sequenceUnenroll({ enrollment_id: id, reason }));
  if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: result.status });
  return NextResponse.json({ ok: true, stopped: result.data.stopped });
}
