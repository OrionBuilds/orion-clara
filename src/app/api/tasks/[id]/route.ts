import { NextRequest, NextResponse } from "next/server";
import { ensureBootstrapped } from "@/lib/clara/bootstrap";
import { update, deleteTask } from "@/lib/clara/tasks";

export const runtime = "nodejs";

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  await ensureBootstrapped();
  const { id } = await ctx.params;
  const patch = await req.json();
  const next = await update(id, patch);
  if (!next) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(next);
}

// Local delete only — Google Tasks sync deliberately never propagates deletions (tasks.ts:159).
export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  await ensureBootstrapped();
  const { id } = await ctx.params;
  const ok = await deleteTask(id);
  if (!ok) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
