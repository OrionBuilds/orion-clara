import { NextRequest, NextResponse } from "next/server";
import { ensureBootstrapped } from "@/lib/clara/bootstrap";
import { entityCandidates } from "@/lib/clara/wikilinks";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  await ensureBootstrapped();
  const q = req.nextUrl.searchParams.get("q") ?? "";
  return NextResponse.json({ candidates: await entityCandidates(q) });
}
