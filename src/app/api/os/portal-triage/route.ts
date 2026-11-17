// POST /api/os/portal-triage — run one portal-ticket triage pass now (owner UI / smoke test).
// Body { dryRun?: boolean }: dryRun decides and returns the per-ticket decisions without touching
// the OS, a bench, or the cursor. Principal-scoped by the host gate like /api/intent.

import { NextResponse } from "next/server";
import { runPortalTicketTriage, portalTriageMode } from "@/lib/clara/portal/triage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({})) as { dryRun?: boolean };
  const out = await runPortalTicketTriage(undefined, { dryRun: body.dryRun === true });
  try { return NextResponse.json({ mode: portalTriageMode(), ...JSON.parse(out) }); }
  catch { return NextResponse.json({ mode: portalTriageMode(), summary: out }); }
}
