import { NextResponse } from "next/server";
import { connectedAccounts, M_ACCOUNTS } from "@/lib/clara/ms-auth";

export const runtime = "nodejs";

export async function GET() {
  const connected = connectedAccounts();
  const all = M_ACCOUNTS.map((a) => {
    const hit = connected.find((c) => c.account === a);
    return { account: a, connected: Boolean(hit), email: hit?.email ?? null };
  });
  const clientConfigured = Boolean(
    process.env.MS_OAUTH_CLIENT_ID && process.env.MS_OAUTH_CLIENT_SECRET && process.env.MS_OAUTH_TENANT_ID
  );
  return NextResponse.json({ clientConfigured, accounts: all });
}
