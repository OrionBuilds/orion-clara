import { NextResponse } from "next/server";
import { connectedAccounts, G_ACCOUNTS } from "@/lib/clara/google-auth";

export const runtime = "nodejs";

export async function GET() {
  const connected = connectedAccounts();
  const all = G_ACCOUNTS.map((a) => {
    const hit = connected.find((c) => c.account === a);
    return { account: a, connected: Boolean(hit), email: hit?.email ?? null };
  });
  const clientConfigured = Boolean(
    (process.env.GOOGLE_OAUTH_CLIENT_ID ?? process.env.GOOGLE_CLIENT_ID) &&
    (process.env.GOOGLE_OAUTH_CLIENT_SECRET ?? process.env.GOOGLE_CLIENT_SECRET)
  );
  return NextResponse.json({ clientConfigured, accounts: all });
}
