import { NextRequest, NextResponse } from "next/server";
import { ensureBootstrapped } from "@/lib/clara/bootstrap";
import { reviewContract } from "@/lib/clara/legal-tax";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  await ensureBootstrapped();
  const body = await req.json() as { text: string; context?: string };
  if (!body.text?.trim()) return NextResponse.json({ error: "text required" }, { status: 400 });
  try {
    const res = await reviewContract(body);
    return NextResponse.json(res);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
