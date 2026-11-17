import { NextRequest, NextResponse } from "next/server";
import { ensureBootstrapped } from "@/lib/clara/bootstrap";
import { listVendors, saveVendor } from "@/lib/clara/vendors";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  await ensureBootstrapped();
  const category = req.nextUrl.searchParams.get("category") ?? undefined;
  return NextResponse.json(await listVendors(category));
}

export async function POST(req: NextRequest) {
  await ensureBootstrapped();
  const body = await req.json();
  const v = await saveVendor(body);
  return NextResponse.json(v);
}
