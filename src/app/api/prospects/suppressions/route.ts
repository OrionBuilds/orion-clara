// POST /api/prospects/suppressions — add a suppression entry (the Office's suppressions table).
import { NextRequest, NextResponse } from "next/server";
import { requireInteragent, callOrUnavailable } from "@/lib/clara/prospecting/httpAuth";
import { suppressionsAdd } from "@/lib/clara/prospecting/osBridge";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const denied = requireInteragent(req);
  if (denied) return denied;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  if (typeof body.kind !== "string" || typeof body.value !== "string" || !body.value.trim()) {
    return NextResponse.json({ ok: false, error: "kind and value are required" }, { status: 400 });
  }
  const result = await callOrUnavailable(() => suppressionsAdd(body));
  if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: result.status });
  return NextResponse.json({ ok: true, suppression: result.data });
}
