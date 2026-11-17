// POST /api/meetings/ingest — run the meeting ingester now, or digest one meeting.
//   {}                                   → one full poll (Wispr, then Meet docs), per CLARA_MEETING_INGEST
//   { source: "wispr"|"meet", id }       → digest that meeting (mode per env; "off" runs as shadow)
//   { ..., dryRun: true }                → digest only: returns the digest + note preview, writes nothing
//   { ..., force: true }                 → ignore the already-digested ledger (e.g. re-run a shadow digest as active)
// Loopback / verified owner / interagent secret only — same gate as the other write routes.

import { NextRequest, NextResponse } from "next/server";
import { verifyInteragentSecret } from "@autom8ionlab/agent-core";
import { principalFromHeaders } from "@/lib/clara/session";
import { ingestRecord, meetingIngestMode, runMeetingIngest } from "@/lib/clara/meetings/ingest";
import { getMeeting } from "@/lib/clara/meetings/wispr";
import { getMeetNote } from "@/lib/clara/meetings/meet";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  if (!principalFromHeaders(req.headers) && !verifyInteragentSecret(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => ({})) as { source?: string; id?: string; dryRun?: boolean; force?: boolean };

  if (!body.id) {
    if (body.dryRun) return NextResponse.json({ error: "dryRun needs a specific { source, id }" }, { status: 400 });
    return NextResponse.json({ ok: true, report: await runMeetingIngest() });
  }

  const source = body.source ?? "wispr";
  if (source !== "wispr" && source !== "meet") return NextResponse.json({ error: "source must be wispr or meet" }, { status: 400 });
  try {
    const rec = source === "wispr" ? await getMeeting(body.id) : await getMeetNote(body.id);
    if (!rec) return NextResponse.json({ error: "meeting not found or empty" }, { status: 404 });
    const outcome = await ingestRecord(rec, { dryRun: Boolean(body.dryRun), force: Boolean(body.force), mode: meetingIngestMode() });
    return NextResponse.json({ ok: outcome.status !== "error", outcome });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String((e as Error).message ?? e).slice(0, 300) }, { status: 502 });
  }
}
