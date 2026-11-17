// POST /api/prospects/research/run — the Office's "Run" button after the estimate card. Seeds the
// hex-grid discover tasks and flips the job to `queued`; the orchestrator tick drains it from there.

import { NextRequest, NextResponse } from "next/server";
import { requireInteragent, callOrUnavailable } from "@/lib/clara/prospecting/httpAuth";
import { getResearchJob, updateResearchJob, addTasks } from "@/lib/clara/prospecting/osBridge";
import { hexGrid } from "@/lib/clara/prospecting/discovery/grid";
import { resolveCenter } from "@/lib/clara/prospecting/discovery/center";
import { prospectingMode, type JobSpec } from "@/lib/clara/prospecting/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const denied = requireInteragent(req);
  if (denied) return denied;

  const body = (await req.json().catch(() => ({}))) as { job_id?: unknown };
  const jobId = typeof body.job_id === "string" ? body.job_id.trim() : "";
  if (!jobId) return NextResponse.json({ ok: false, error: "job_id is required" }, { status: 400 });
  if (prospectingMode() === "off") {
    return NextResponse.json({ ok: false, error: "prospecting is off (CLARA_PROSPECTING=off)" }, { status: 409 });
  }

  const result = await callOrUnavailable(async () => {
    const job = await getResearchJob(jobId);
    const centered = await resolveCenter(job.plan as JobSpec);
    if (!centered.ok) throw new Error(centered.error);
    const spec = centered.spec;
    const cells = hexGrid(spec.location.lat!, spec.location.lng!, spec.location.radius_miles);
    await addTasks(
      job.id,
      cells.map((c) => ({
        task_type: "discover",
        stage: 10,
        idempotency_key: `${job.id}:discover:${c.id}`,
        input: { lat: c.lat, lng: c.lng, radiusMiles: c.radiusMiles, cellId: c.id },
      })),
    );
    const updated = await updateResearchJob(job.id, { status: "running", plan: spec });
    return { job: updated, cells: cells.length };
  });

  if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: result.status });
  return NextResponse.json({ ok: true, job: result.data.job, cells: result.data.cells, mode: prospectingMode() });
}
