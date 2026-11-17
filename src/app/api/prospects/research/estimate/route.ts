// POST /api/prospects/research/estimate — the Office's "cost estimate before run" (§31). Builds a
// plan from the NL request, estimates it, and (when the OS tables exist) creates a draft
// `research_jobs` row (status "estimated") so a follow-up /research/run can reference it by id.

import { NextRequest, NextResponse } from "next/server";
import { requireInteragent } from "@/lib/clara/prospecting/httpAuth";
import { planFromText, describeSpec } from "@/lib/clara/prospecting/planner";
import { estimateJobLive } from "@/lib/clara/prospecting/estimator";
import { createResearchJob, OsProspectingUnavailableError } from "@/lib/clara/prospecting/osBridge";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const denied = requireInteragent(req);
  if (denied) return denied;

  const body = (await req.json().catch(() => ({}))) as { request?: unknown };
  const request = typeof body.request === "string" ? body.request.trim() : "";
  if (!request) return NextResponse.json({ ok: false, error: "request is required" }, { status: 400 });

  const plan = await planFromText(request);
  if (!plan.ok || !plan.spec) {
    return NextResponse.json({ ok: false, error: plan.errors.join("; ") || "could not build a plan", warnings: plan.warnings }, { status: 422 });
  }
  const estimate = await estimateJobLive(plan.spec);

  let jobId: string | undefined;
  try {
    const r = await createResearchJob({
      title: plan.spec.title,
      request_text: request,
      plan: plan.spec,
      budget_usd: Math.ceil(estimate.total * 1.25),
      max_records: plan.spec.max_records,
      estimate,
      requested_via: "office",
      // Persist the draft (status becomes "estimated") so a follow-up /research/run can reference
      // it by id. Previously `dry_run:true` meant the tool synthesized an envelope without an id,
      // so /run could never find a job to run.
      dry_run: false,
    });
    jobId = r.job?.id;
  } catch (e) {
    if (!(e instanceof OsProspectingUnavailableError)) throw e;
    // The estimate below is still useful on its own — the Office just won't have a job_id yet.
  }

  return NextResponse.json({
    ok: true,
    job_id: jobId,
    spec: plan.spec,
    description: describeSpec(plan.spec),
    estimate,
    warnings: plan.warnings,
  });
}
