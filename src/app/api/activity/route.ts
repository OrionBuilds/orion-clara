// Recent activity — Clara's analog to FRIDAY's /api/friday/feed. Clara has no logs.jsonl-style
// event stream; the ledger (every charge/booking/sent email/SMS/call/action) is her closest
// equivalent, so this tails it the same way — powers the Activity rail on the chat page.

import { NextRequest, NextResponse } from "next/server";
import { ensureBootstrapped } from "@/lib/clara/bootstrap";
import { readAll } from "@/lib/clara/ledger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  await ensureBootstrapped();
  const limit = Math.min(Number(req.nextUrl.searchParams.get("limit") ?? 30), 200);
  const rows = await readAll();
  const recent = rows.slice(-limit).reverse();
  return NextResponse.json({ activity: recent });
}
