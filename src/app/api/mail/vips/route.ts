import { NextRequest, NextResponse } from "next/server";
import { ensureBootstrapped } from "@/lib/clara/bootstrap";
import { readVipList, writeVipList } from "@/lib/clara/triage";

export const runtime = "nodejs";

export async function GET() {
  await ensureBootstrapped();
  return NextResponse.json(await readVipList());
}

export async function PUT(req: NextRequest) {
  await ensureBootstrapped();
  const body = await req.json() as { vip: string[] };
  await writeVipList({ vip: body.vip ?? [] });
  return NextResponse.json({ ok: true });
}
