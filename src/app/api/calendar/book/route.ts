import { NextRequest, NextResponse } from "next/server";
import { ensureBootstrapped } from "@/lib/clara/bootstrap";
import { bookEvent } from "@/lib/clara/ms-calendar";
import { principalFromHeaders } from "@/lib/clara/session";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  await ensureBootstrapped();
  const principal = principalFromHeaders(req.headers);
  if (!principal) return NextResponse.json({ error: "not authenticated" }, { status: 401 });

  const body = await req.json();
  const res = await bookEvent({ ...body, requestor: principal });
  return NextResponse.json(res, { status: res.ok ? 200 : 400 });
}
