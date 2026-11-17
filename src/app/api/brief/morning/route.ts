import { NextRequest, NextResponse } from "next/server";
import { ensureBootstrapped } from "@/lib/clara/bootstrap";
import { composeMorningBrief } from "@/lib/clara/briefs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Default: the Brief record (markdown + vault path) the /brief page and Office read.
// ?full=1 (2026-09-24): also the HTML email body and the structured model behind it.
async function compose(req: NextRequest) {
  await ensureBootstrapped();
  const brief = await composeMorningBrief();
  const full = req.nextUrl.searchParams.get("full") === "1";
  if (full) return NextResponse.json({ markdown: brief.markdown, html: brief.html ?? null, model: brief.model ?? null, vaultPath: brief.vaultPath, date: brief.date });
  const { html: _html, model: _model, ...rest } = brief;
  return NextResponse.json(rest);
}

export async function POST(req: NextRequest) { return compose(req); }
export async function GET(req: NextRequest) { return compose(req); }
