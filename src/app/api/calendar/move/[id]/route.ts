import { NextRequest, NextResponse } from "next/server";
import { ensureBootstrapped } from "@/lib/clara/bootstrap";
import { moveEvent, cancelEvent } from "@/lib/clara/ms-calendar";
import { principalFromHeaders } from "@/lib/clara/session";

export const runtime = "nodejs";

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  await ensureBootstrapped();
  const principal = principalFromHeaders(req.headers);
  if (!principal) return NextResponse.json({ error: "not authenticated" }, { status: 401 });

  const { id } = await ctx.params;
  const body = await req.json();
  const res = await moveEvent(id, { ...body, requestor: principal });
  return NextResponse.json(res, { status: res.ok ? 200 : 400 });
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  await ensureBootstrapped();
  const principal = principalFromHeaders(req.headers);
  if (!principal) return NextResponse.json({ error: "not authenticated" }, { status: 401 });

  const { id } = await ctx.params;
  const body = await req.json().catch(() => ({}));
  const res = await cancelEvent(id, { ...body, requestor: principal });
  return NextResponse.json(res, { status: res.ok ? 200 : 400 });
}
