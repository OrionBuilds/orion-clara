import { NextRequest, NextResponse } from "next/server";
import { ensureBootstrapped } from "@/lib/clara/bootstrap";
import { runDrill, type DrillName } from "@/lib/clara/drills";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  await ensureBootstrapped();
  const { name, execute } = await req.json() as { name: DrillName; execute?: boolean };
  if (!name) return NextResponse.json({ error: "name required" }, { status: 400 });
  const res = await runDrill(name, Boolean(execute));
  return NextResponse.json(res);
}
