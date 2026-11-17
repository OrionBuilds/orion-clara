import { NextResponse } from "next/server";
import { ensureBootstrapped } from "@/lib/clara/bootstrap";
import { listInbox } from "@/lib/clara/inbox";

export const runtime = "nodejs";

export async function GET() {
  await ensureBootstrapped();
  return NextResponse.json(await listInbox());
}
