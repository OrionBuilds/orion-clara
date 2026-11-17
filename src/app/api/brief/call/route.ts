// Manual / dry-run trigger for the morning call. POST { dry?: boolean }.
//
// dry:true places a real call to the owner with today's script but as a "dry-run" session: it
// doesn't count as today's call, never retries, and sends no recap email. Used to verify the
// pipeline (script, barge-in, a question, a task, "that's all") before CLARA_MORNING_CALL goes live.
// The destination is never a parameter — owner-call.ts derives it from config and refuses a mismatch.

import { NextRequest, NextResponse } from "next/server";
import { ensureBootstrapped } from "@/lib/clara/bootstrap";
import { principalFromHeaders } from "@/lib/clara/session";
import { placeMorningCall } from "@/lib/clara/owner-call";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  await ensureBootstrapped();
  if (!principalFromHeaders(req.headers)) return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { dry?: boolean };
  const res = await placeMorningCall({ dry: Boolean(body.dry) });
  return NextResponse.json(res, { status: res.ok ? 200 : 409 });
}
