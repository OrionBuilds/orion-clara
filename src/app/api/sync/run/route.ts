// Runs a Microsoft Graph sync. Defaults to dryRun so the first call always returns a PLAN rather
// than writing anything — the caller has to opt in explicitly with { dryRun: false } to execute.
// That's deliberate: the riskiest moment for two-way sync is the very first run, before any links
// exist, when a bad match could merge two different people or duplicate everything.

import { NextRequest, NextResponse } from "next/server";
import { ensureBootstrapped } from "@/lib/clara/bootstrap";
import { principalFromHeaders } from "@/lib/clara/session";
import { syncTasks } from "@/lib/clara/ms-tasks";
import { syncContacts } from "@/lib/clara/ms-contacts";
import type { MAccount } from "@/lib/clara/ms-auth";
import type { SyncReport } from "@/lib/clara/sync-engine";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  await ensureBootstrapped();
  if (!principalFromHeaders(req.headers)) return NextResponse.json({ error: "not authenticated" }, { status: 401 });

  const body = await req.json().catch(() => ({})) as {
    kind?: "tasks" | "contacts" | "all";
    account?: MAccount;
    dryRun?: boolean;
  };
  const kind = body.kind ?? "all";
  const account = body.account ?? "work";
  const dryRun = body.dryRun !== false;   // opt-in to writing, never the default

  const reports: SyncReport[] = [];
  const errors: { kind: string; message: string }[] = [];

  if (kind === "tasks" || kind === "all") {
    try { reports.push(await syncTasks(account, { dryRun })); }
    catch (e) { errors.push({ kind: "tasks", message: String((e as Error).message ?? e) }); }
  }
  // Contacts sync runs on the owner's work account.
  if ((kind === "contacts" || kind === "all") && account === "work") {
    try { reports.push(await syncContacts("work", { dryRun })); }
    catch (e) { errors.push({ kind: "contacts", message: String((e as Error).message ?? e) }); }
  }

  return NextResponse.json({ dryRun, reports, errors });
}
