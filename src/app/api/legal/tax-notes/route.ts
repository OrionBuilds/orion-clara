import { NextRequest, NextResponse } from "next/server";
import { ensureBootstrapped } from "@/lib/clara/bootstrap";
import { taxNotes } from "@/lib/clara/legal-tax";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  await ensureBootstrapped();
  const body = await req.json().catch(() => ({})) as { periodMonths?: number };
  try {
    const res = await taxNotes({ periodMonths: body.periodMonths ?? 3 });
    return NextResponse.json(res);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
