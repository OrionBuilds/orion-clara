import { NextResponse } from "next/server";
import { ensureBootstrapped } from "@/lib/clara/bootstrap";
import { composeWeeklyReview } from "@/lib/clara/briefs";

export const runtime = "nodejs";

export async function POST() {
  await ensureBootstrapped();
  return NextResponse.json(await composeWeeklyReview());
}
export async function GET() { return POST(); }
