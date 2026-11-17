import { NextRequest, NextResponse } from "next/server";
import { ensureBootstrapped } from "@/lib/clara/bootstrap";
import { delegate, fridayHealth } from "@/lib/clara/friday-bridge";

export const runtime = "nodejs";

export async function GET() {
  await ensureBootstrapped();
  return NextResponse.json(await fridayHealth());
}

export async function POST(req: NextRequest) {
  await ensureBootstrapped();
  const { prompt, kind, history } = await req.json() as { prompt: string; kind?: "research"|"draft"|"code"|"seo"|"generic"; history?: { role: "user"|"assistant"; text: string }[] };
  if (!prompt?.trim()) return NextResponse.json({ error: "prompt required" }, { status: 400 });
  const res = await delegate(prompt, { kind, history });
  return NextResponse.json(res, { status: res.ok ? 200 : 502 });
}
