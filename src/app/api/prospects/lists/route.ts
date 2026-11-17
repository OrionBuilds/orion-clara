// POST /api/prospects/lists — create a prospect list (the Office's "New list" modal).
import { NextRequest, NextResponse } from "next/server";
import { requireInteragent, callOrUnavailable } from "@/lib/clara/prospecting/httpAuth";
import { prospectListsCreate } from "@/lib/clara/prospecting/osBridge";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const denied = requireInteragent(req);
  if (denied) return denied;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  if (typeof body.name !== "string" || !body.name.trim()) {
    return NextResponse.json({ ok: false, error: "name is required" }, { status: 400 });
  }
  const result = await callOrUnavailable(() => prospectListsCreate(body));
  if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: result.status });
  return NextResponse.json({ ok: true, list: result.data });
}
