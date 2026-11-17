import { NextResponse } from "next/server";
import { ensureBootstrapped } from "@/lib/clara/bootstrap";
import { readAll } from "@/lib/clara/ledger";

export const runtime = "nodejs";

export async function GET() {
  await ensureBootstrapped();
  const rows = await readAll();
  return NextResponse.json(rows.slice(-200).reverse());
}
