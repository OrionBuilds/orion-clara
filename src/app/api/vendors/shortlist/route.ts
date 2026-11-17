import { NextRequest, NextResponse } from "next/server";
import { ensureBootstrapped } from "@/lib/clara/bootstrap";
import { shortlistForQuotes } from "@/lib/clara/vendors";
import { principalFromHeaders } from "@/lib/clara/session";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  await ensureBootstrapped();
  const principal = principalFromHeaders(req.headers);
  if (!principal) return NextResponse.json({ error: "not authenticated" }, { status: 401 });

  const body = await req.json();
  const res = await shortlistForQuotes({ ...body, requestor: principal });
  return NextResponse.json(res);
}
