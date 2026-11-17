// GET /api/meetings/wispr/callback — Wispr's OAuth redirect. Public (hostGate OAUTH_PATHS): the
// code exchange itself is the authentication event, bound by PKCE + the stored `state`.

import { NextRequest, NextResponse } from "next/server";
import { finishAuth } from "@/lib/clara/meetings/wispr";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Same header-based reconstruction as /api/google/callback — req.url is the tunnel's local side.
function publicBase(req: NextRequest): string {
  const host = req.headers.get("host") ?? "127.0.0.1:3939";
  const proto = req.headers.get("x-forwarded-proto") ?? "https";
  return `${proto}://${host}`;
}

export async function GET(req: NextRequest) {
  const base = publicBase(req);
  const code = req.nextUrl.searchParams.get("code");
  if (!code) {
    const err = req.nextUrl.searchParams.get("error_description") ?? req.nextUrl.searchParams.get("error") ?? "no auth code";
    return NextResponse.redirect(new URL(`/settings/connect?err=${encodeURIComponent(`wispr: ${err}`)}`, base));
  }
  const r = await finishAuth(code, req.nextUrl.searchParams.get("state"));
  const dest = r.ok ? "/settings/connect?connected=wispr" : `/settings/connect?err=${encodeURIComponent(`wispr: ${r.error.slice(0, 200)}`)}`;
  return NextResponse.redirect(new URL(dest, base));
}
