import { NextRequest, NextResponse } from "next/server";
import { ensureBootstrapped } from "@/lib/clara/bootstrap";
import { recordAnswer, OWNER_QUESTIONS } from "@/lib/clara/onboarding";
import type { PrincipalId } from "@/lib/clara/types";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  await ensureBootstrapped();
  const { principal, qid, text } = await req.json() as { principal: PrincipalId; qid: string; text: string };
  const q = OWNER_QUESTIONS.find((x) => x.id === qid);
  if (!q) return NextResponse.json({ error: "unknown question" }, { status: 400 });
  await recordAnswer(principal, { qid, text, ts: new Date().toISOString() }, q);
  return NextResponse.json({ ok: true });
}
