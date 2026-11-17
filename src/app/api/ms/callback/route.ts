import { NextRequest, NextResponse } from "next/server";
import { exchangeCode, type MAccount } from "@/lib/clara/ms-auth";

export const runtime = "nodejs";

// req.url reflects the internal connection Next.js actually sees (plain http on the tunnel's
// local side), not the public https://clara.example.com the browser is on — building a
// redirect straight from it sends the browser to the wrong origin. Same header-based
// reconstruction google/callback and the Twilio webhook routes use for exactly this reason.
function publicBase(req: NextRequest): string {
  const host = req.headers.get("host") ?? "127.0.0.1:3939";
  const proto = req.headers.get("x-forwarded-proto") ?? "https";
  return `${proto}://${host}`;
}

export async function GET(req: NextRequest) {
  const base = publicBase(req);
  const code = req.nextUrl.searchParams.get("code");
  const account = (req.nextUrl.searchParams.get("state") ?? "work") as MAccount;
  if (!code) {
    const err = req.nextUrl.searchParams.get("error") ?? "no auth code";
    return NextResponse.redirect(new URL(`/settings/connect?err=${encodeURIComponent(err)}`, base));
  }
  const res = await exchangeCode(code, account);
  const dest = res.ok
    ? `/settings/connect?connected=${account}&email=${encodeURIComponent(res.email ?? "")}`
    : `/settings/connect?err=${encodeURIComponent(res.error ?? "unknown")}`;
  return NextResponse.redirect(new URL(dest, base));
}
