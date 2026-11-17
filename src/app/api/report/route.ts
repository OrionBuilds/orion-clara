// Report-up rail (JARVIS pivot A1): department heads POST completed-work summaries here, and they
// land in the owner+CLARA's shared thread — CLARA the orchestrator sees everything her departments
// finish, and the morning digest inherits it for free (the thread IS her context). Gated by the
// interagent secret like every sibling-facing surface; loopback callers clear it in dev.

import { NextRequest, NextResponse } from "next/server";
import { verifyInteragentSecret } from "@autom8ionlab/agent-core";
import { appendMessage } from "@/lib/clara/messages";
import { append as ledgerAppend } from "@/lib/clara/ledger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HEADS = new Set(["friday"]);

export async function POST(req: NextRequest) {
  if (!verifyInteragentSecret(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { from?: string; summary?: string };
  const from = String(body.from ?? "").toLowerCase();
  const summary = String(body.summary ?? "").trim();
  if (!HEADS.has(from) || !summary) return NextResponse.json({ error: "from (friday) and summary required" }, { status: 400 });

  const line = `📋 ${from.toUpperCase()} reports: ${summary.slice(0, 1500)}`;
  await appendMessage("clara", line).catch(() => {});
  await ledgerAppend({ kind: "action", actor: "clara", what: `department report received from ${from}`, meta: { summary: summary.slice(0, 300) } }).catch(() => {});
  return NextResponse.json({ ok: true });
}
