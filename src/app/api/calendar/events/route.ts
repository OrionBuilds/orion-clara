import { NextRequest, NextResponse } from "next/server";
import { ensureBootstrapped } from "@/lib/clara/bootstrap";
import { combinedUpcoming, listUpcoming } from "@/lib/clara/ms-calendar";
import type { MAccount } from "@/lib/clara/ms-auth";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  await ensureBootstrapped();
  const account = req.nextUrl.searchParams.get("account") as MAccount | null;
  const days = Number(req.nextUrl.searchParams.get("days") ?? 7);
  try {
    const rows = account ? await listUpcoming({ account, max: 100 }) : await combinedUpcoming(days);
    return NextResponse.json(rows);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
