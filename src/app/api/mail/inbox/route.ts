import { NextResponse } from "next/server";
import { ensureBootstrapped } from "@/lib/clara/bootstrap";
import { listUnreadInbox } from "@/lib/clara/ms-mail";

export const runtime = "nodejs";

export async function GET() {
  await ensureBootstrapped();
  try {
    const rows = await listUnreadInbox(50);
    return NextResponse.json(rows);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
