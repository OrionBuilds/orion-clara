import { NextRequest, NextResponse } from "next/server";
import { ensureBootstrapped } from "@/lib/clara/bootstrap";
import { backlinksFor, forwardLinksFor, rebuildLinkIndex } from "@/lib/clara/wikilinks";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  await ensureBootstrapped();
  const p = req.nextUrl.searchParams.get("path");
  if (!p) return NextResponse.json({ error: "path required" }, { status: 400 });
  const [backlinks, forward] = await Promise.all([backlinksFor(p), forwardLinksFor(p)]);
  return NextResponse.json({ backlinks, forward });
}

export async function POST() {
  await ensureBootstrapped();
  const result = await rebuildLinkIndex();
  return NextResponse.json(result);
}
