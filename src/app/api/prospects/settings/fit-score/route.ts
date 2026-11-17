// PUT /api/prospects/settings/fit-score — update the active fit-score config (weights editor).
// POST /api/prospects/settings/fit-score — recompute scores under the current config.
import { NextRequest, NextResponse } from "next/server";
import { requireInteragent, callOrUnavailable } from "@/lib/clara/prospecting/httpAuth";
import { fitScoreConfigSet, fitScoreRecompute } from "@/lib/clara/prospecting/osBridge";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PUT(req: NextRequest) {
  const denied = requireInteragent(req);
  if (denied) return denied;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const result = await callOrUnavailable(() => fitScoreConfigSet(body));
  if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: result.status });
  return NextResponse.json({ ok: true, config: result.data });
}

export async function POST(req: NextRequest) {
  const denied = requireInteragent(req);
  if (denied) return denied;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const result = await callOrUnavailable(() => fitScoreRecompute(body));
  if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: result.status });
  return NextResponse.json({ ok: true, result: result.data });
}
