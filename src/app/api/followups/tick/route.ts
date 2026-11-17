import { NextResponse } from "next/server";
import { ensureBootstrapped } from "@/lib/clara/bootstrap";
import { tickAndNudge } from "@/lib/clara/followups";

export const runtime = "nodejs";

export async function POST() {
  await ensureBootstrapped();
  const res = await tickAndNudge();
  return NextResponse.json(res);
}
