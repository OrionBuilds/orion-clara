import { NextResponse } from "next/server";
import { ensureBootstrapped } from "@/lib/clara/bootstrap";
import { runTriage } from "@/lib/clara/triage";

export const runtime = "nodejs";

export async function POST() {
  await ensureBootstrapped();
  try {
    const results = await runTriage();
    return NextResponse.json({ count: results.length, results });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
