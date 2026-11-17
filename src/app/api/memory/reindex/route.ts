import { NextResponse } from "next/server";
import { ensureBootstrapped } from "@/lib/clara/bootstrap";
import { reindexAll } from "@/lib/clara/memory";

export const runtime = "nodejs";

export async function POST() {
  await ensureBootstrapped();
  const res = await reindexAll();
  return NextResponse.json(res);
}
