import { NextRequest, NextResponse } from "next/server";
import { ensureBootstrapped } from "@/lib/clara/bootstrap";
import { searchMemory } from "@/lib/clara/memory";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  await ensureBootstrapped();
  const q = req.nextUrl.searchParams.get("q") ?? "";
  const hits = await searchMemory(q);
  return NextResponse.json(hits);
}
