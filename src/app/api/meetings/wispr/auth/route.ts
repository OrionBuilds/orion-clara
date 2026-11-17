// GET /api/meetings/wispr/auth — owner-only. Starts Wispr Flow's MCP OAuth (discovery + dynamic
// client registration + PKCE, all via the MCP SDK) and 302s the browser to Wispr's consent page.
// The callback lands on /api/meetings/wispr/callback.

import { NextRequest, NextResponse } from "next/server";
import { principalFromHeaders } from "@/lib/clara/session";
import { beginAuth } from "@/lib/clara/meetings/wispr";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function publicBase(req: NextRequest): string {
  const host = req.headers.get("host") ?? "127.0.0.1:3939";
  const proto = req.headers.get("x-forwarded-proto") ?? "https";
  return `${proto}://${host}`;
}

export async function GET(req: NextRequest) {
  if (!principalFromHeaders(req.headers)) return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  const r = await beginAuth();
  if (!r.ok) return NextResponse.redirect(new URL(`/settings/connect?err=${encodeURIComponent(`wispr: ${r.error}`)}`, publicBase(req)), 302);
  return NextResponse.redirect(r.url, 302);
}
