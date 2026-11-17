import { NextResponse } from "next/server";
import { ensureBootstrapped } from "@/lib/clara/bootstrap";
import { healthReport } from "@/lib/clara/health";

export const runtime = "nodejs";

export async function GET() {
  await ensureBootstrapped();
  return NextResponse.json(await healthReport());
}
