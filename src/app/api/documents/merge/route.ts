import { NextRequest, NextResponse } from "next/server";
import { ensureBootstrapped } from "@/lib/clara/bootstrap";
import { mergeDocuments } from "@/lib/clara/documents";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  await ensureBootstrapped();
  const body = await req.json() as { files: string[]; outFilename: string };
  if (!body.files?.length || !body.outFilename?.trim()) {
    return NextResponse.json({ error: "files (2+) and outFilename required" }, { status: 400 });
  }
  const res = await mergeDocuments(body.files, body.outFilename);
  return NextResponse.json(res, { status: res.ok ? 200 : 400 });
}
