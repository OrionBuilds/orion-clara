import { NextRequest, NextResponse } from "next/server";
import { consentUrl, type MAccount } from "@/lib/clara/ms-auth";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const account = (req.nextUrl.searchParams.get("account") ?? "work") as MAccount;
  const url = consentUrl(account);
  if (!url) return NextResponse.json({ error: "MS_OAUTH_CLIENT_ID/SECRET/TENANT_ID not set in .env.local" }, { status: 400 });
  return NextResponse.redirect(url);
}
