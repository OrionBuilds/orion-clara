// POST /api/prospects/lists/[id]/promote — the Office's "Add to pipeline" button on
// /prospects/lists/[id]: an explicit, threshold-bypassing promotion of one or more selected
// companies in this list (reason "manual" — distinct from the scheduler's fit-threshold watcher).
//
// Body: { company_ids: string[] } — the row selection from the Office table. Each company is
// promoted independently (companies_promote is idempotent, so a company already promoted just
// returns its existing contact/opportunity ids); one failure doesn't block the rest.
import { NextRequest, NextResponse } from "next/server";
import { requireInteragent } from "@/lib/clara/prospecting/httpAuth";
import { promoteCompany } from "@/lib/clara/prospecting/promote";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = requireInteragent(req);
  if (denied) return denied;
  await params; // the list id itself isn't needed by promoteCompany — company_ids are already resolved client-side from this list's table

  const body = (await req.json().catch(() => ({}))) as { company_ids?: unknown };
  const companyIds = Array.isArray(body.company_ids) ? body.company_ids.filter((x): x is string => typeof x === "string" && x.trim().length > 0) : [];
  if (!companyIds.length) {
    return NextResponse.json({ ok: false, error: "company_ids (non-empty array) is required" }, { status: 400 });
  }

  const results = await Promise.all(companyIds.map((id) => promoteCompany(id, { reason: "manual" })));
  const promoted = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);
  return NextResponse.json({ ok: failed.length === 0, promoted, failed: failed.length, results });
}
