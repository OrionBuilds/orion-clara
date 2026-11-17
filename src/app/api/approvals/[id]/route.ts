import { NextRequest, NextResponse } from "next/server";
import { ensureBootstrapped } from "@/lib/clara/bootstrap";
import { approve, reject, get } from "@/lib/clara/approvals";

export const runtime = "nodejs";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  await ensureBootstrapped();
  const { id } = await ctx.params;
  const row = await get(id);
  if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(row);
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  await ensureBootstrapped();
  const { id } = await ctx.params;
  const { decision, note } = await req.json() as { decision: "approve" | "reject"; note?: string };
  const row = decision === "approve" ? await approve(id, note) : await reject(id, note);
  if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(row);
}
