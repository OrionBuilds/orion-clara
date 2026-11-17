// Deep-work run surface (Phase-1 debt closure): the Office's run modal needs list + cancel over
// HTTP — deepwork.ts has had listQueue()/cancelQueued() since the overnight harness landed, but
// nothing mounted them. GET lists the queue (all states, newest first); DELETE ?id= cancels a
// QUEUED job only — a running job is the overnight worker's to finish or the stall-watchdog's to
// kill, never a remote caller's (killing mid-run is exactly the maybe-executed hazard the boot
// sweep exists for). Gated by the interagent secret like every sibling-facing surface.

import { NextRequest, NextResponse } from "next/server";
import { verifyInteragentSecret } from "@autom8ionlab/agent-core";
import { listQueue, cancelQueued } from "@/lib/clara/deepwork";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (!verifyInteragentSecret(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const jobs = await listQueue();
  return NextResponse.json({ jobs });
}

export async function DELETE(req: NextRequest) {
  if (!verifyInteragentSecret(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const id = (req.nextUrl.searchParams.get("id") ?? "").trim();
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  const job = await cancelQueued(id);
  if (!job) return NextResponse.json({ error: "not found or not cancellable (only queued jobs cancel)" }, { status: 409 });
  return NextResponse.json({ ok: true, job });
}
