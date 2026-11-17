import { NextRequest, NextResponse } from "next/server";
import { ensureBootstrapped } from "@/lib/clara/bootstrap";
import { planTrip, type TravelRequest } from "@/lib/clara/travel";
import { principalFromHeaders } from "@/lib/clara/session";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  await ensureBootstrapped();
  const principal = principalFromHeaders(req.headers);
  if (!principal) return NextResponse.json({ error: "not authenticated" }, { status: 401 });

  const body = await req.json() as TravelRequest;
  // requestor is ALWAYS the verified session principal, never trusted from the body —
  // closes the client-asserted-identity finding (a caller could otherwise claim to be the owner).
  const safeBody: TravelRequest = { ...body, requestor: principal };
  try {
    const res = await planTrip(safeBody);
    return NextResponse.json(res);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
