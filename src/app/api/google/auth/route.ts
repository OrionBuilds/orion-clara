import { NextRequest, NextResponse } from "next/server";
import { consentUrl, type GAccount } from "@/lib/clara/google-auth";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const account = (req.nextUrl.searchParams.get("account") ?? "work") as GAccount;
  const url = consentUrl(account);
  if (!url) return NextResponse.json({ error: "GOOGLE_OAUTH_CLIENT_ID/SECRET not set in .env.local" }, { status: 400 });
  return NextResponse.redirect(url);
}
