import { NextRequest, NextResponse } from "next/server";
import { ensureBootstrapped } from "@/lib/clara/bootstrap";
import { progress, sessionQuestions } from "@/lib/clara/onboarding";
import type { PrincipalId } from "@/lib/clara/types";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  await ensureBootstrapped();
  const principal = (req.nextUrl.searchParams.get("principal") ?? "owner") as PrincipalId;
  const prog = await progress(principal);
  const questions = prog.nextSession <= 5 ? sessionQuestions(prog.nextSession as 1 | 2 | 3 | 4 | 5) : [];
  return NextResponse.json({ principal, ...prog, questions });
}
