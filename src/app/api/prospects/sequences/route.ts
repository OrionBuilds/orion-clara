// POST /api/prospects/sequences — the Office's "New Sequence" modal: a draft with just a name;
// the builder (PR 15) adds steps and settings afterward via PATCH / steps's PUT.
// GET /api/prospects/sequences — list sequences (status filter optional). The Office's own list
// page reads sequences straight from the OS (lib/office/prospects/reads.ts's
// listSequencesWithCounts) rather than through this route, but it's built anyway: PR 15's own
// smoke test and any other caller that doesn't have a direct OS session need it, and every other
// write surface here has a matching read for symmetry.
import { NextRequest, NextResponse } from "next/server";
import { requireInteragent, callOrUnavailable } from "@/lib/clara/prospecting/httpAuth";
import { sequencesCreate, sequencesList } from "@/lib/clara/prospecting/osBridge";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const denied = requireInteragent(req);
  if (denied) return denied;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  if (typeof body.name !== "string" || !body.name.trim()) {
    return NextResponse.json({ ok: false, error: "name is required" }, { status: 400 });
  }
  const result = await callOrUnavailable(() => sequencesCreate(body as never));
  if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: result.status });
  return NextResponse.json({ ok: true, sequence: result.data.sequence, steps: result.data.steps });
}

export async function GET(req: NextRequest) {
  const denied = requireInteragent(req);
  if (denied) return denied;
  const status = req.nextUrl.searchParams.get("status") ?? undefined;
  const result = await callOrUnavailable(() => sequencesList({ status }));
  if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: result.status });
  return NextResponse.json({ ok: true, sequences: result.data });
}
