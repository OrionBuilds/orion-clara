import { NextRequest, NextResponse } from "next/server";
import { ensureBootstrapped } from "@/lib/clara/bootstrap";
import { add, listAll } from "@/lib/clara/tasks";

export const runtime = "nodejs";

export async function GET() {
  await ensureBootstrapped();
  return NextResponse.json(await listAll());
}

export async function POST(req: NextRequest) {
  await ensureBootstrapped();
  const body = await req.json();
  if (!body?.title || typeof body.title !== "string") {
    return NextResponse.json({ error: "title required" }, { status: 400 });
  }
  const t = await add(body);
  return NextResponse.json(t, { status: 201 });
}
