import { NextResponse } from "next/server";
import { ensureBootstrapped } from "@/lib/clara/bootstrap";
import { consolidateAll } from "@/lib/clara/consolidate";

export const runtime = "nodejs";

export async function POST() {
  await ensureBootstrapped();
  const res = await consolidateAll();
  return NextResponse.json(res);
}
