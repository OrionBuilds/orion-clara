import { NextRequest, NextResponse } from "next/server";
import { ensureBootstrapped } from "@/lib/clara/bootstrap";
import { listAll, listPending } from "@/lib/clara/approvals";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  await ensureBootstrapped();
  const all = req.nextUrl.searchParams.get("all") === "1";
  return NextResponse.json(all ? await listAll() : await listPending());
}
