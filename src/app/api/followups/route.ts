import { NextRequest, NextResponse } from "next/server";
import { ensureBootstrapped } from "@/lib/clara/bootstrap";
import { listOpen, open, resolve } from "@/lib/clara/followups";

export const runtime = "nodejs";

export async function GET() {
  await ensureBootstrapped();
  return NextResponse.json(await listOpen());
}

export async function POST(req: NextRequest) {
  await ensureBootstrapped();
  const body = await req.json();
  const row = await open(body);
  return NextResponse.json(row, { status: 201 });
}

export async function DELETE(req: NextRequest) {
  await ensureBootstrapped();
  const { id } = await req.json();
  await resolve(id);
  return NextResponse.json({ ok: true });
}
