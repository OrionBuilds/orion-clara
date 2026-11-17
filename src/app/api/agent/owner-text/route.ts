// Agent-driven owner texts (2026-10-02): a non-emergency channel for FRIDAY to reach the owner
// by SMS, strictly for operational acknowledgements the user asked for by name — "I received the
// change request" and "I finished the change request", both tagged with the agent that owned it.
//
// Design constraints inherited from the escalation rail (/api/agent/escalate):
//  - FRIDAY never rings the owner itself; CLARA is the one voice on their phone. This
//    endpoint stays inside that rule — the SMS is sent BY CLARA, carrying the originating agent
//    tag as the first word of the body so they know who is reporting.
//  - Dedupe is per `kind + dedupeKey`, carried into importantText's own matter-key dedupe window
//    (12h) so a sweep that re-reports is a no-op, never a double text.
//  - Quiet hours apply via textOwnerImportant's own gating (21:00–07:00 local falls to email).
//  - Interagent secret is required, loopback callers clear it (verifyInteragentSecret), same as
//    every sibling-facing surface.

import { NextRequest, NextResponse } from "next/server";
import { verifyInteragentSecret } from "@autom8ionlab/agent-core";
import { textOwnerImportant } from "@/lib/clara/importantText";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// FRIDAY is the only bench that texts through Clara.
const FROM = new Set(["friday"]);
// Allow-list of kinds so a buggy caller cannot invent a new emergency category by name. Keep this
// deliberately small; a new kind is a code change on both sides, not a free-form string.
const KIND = new Set([
  "cr_received", "cr_completed", "cr_pr_failed", "cr_pr_merged",
  "migrations_pushed", "migrations_push_failed",
  "ops_services_restarted", "ops_stale_branches", "ops_branch_cleaned",
]);

export async function POST(req: NextRequest) {
  if (!verifyInteragentSecret(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as {
    from?: string; kind?: string; text?: string; dedupeKey?: string;
  };
  const from = String(body.from ?? "").toLowerCase();
  const kind = String(body.kind ?? "").toLowerCase();
  const text = String(body.text ?? "").trim();
  const dedupeKey = String(body.dedupeKey ?? "").trim().slice(0, 200);
  if (!FROM.has(from)) return NextResponse.json({ error: "from must be friday" }, { status: 400 });
  if (!KIND.has(kind)) return NextResponse.json({ error: `kind must be one of ${[...KIND].join("|")}` }, { status: 400 });
  if (!text) return NextResponse.json({ error: "text required" }, { status: 400 });
  if (!dedupeKey) return NextResponse.json({ error: "dedupeKey required" }, { status: 400 });

  // Agent tag is the first word of the SMS so the owner sees "FRIDAY: ..." when it lands. The matter
  // key is <from>:<kind>:<dedupeKey> so a cr_received text does not dedupe a cr_completed one on
  // the same CR, and each agent's bookkeeping stays separate.
  const matter = `${from}:${kind}:${dedupeKey}`;
  const prefixed = `${from.toUpperCase()}: ${text}`;
  const decision = await textOwnerImportant({ contact: `agent:${from}`, matter, text: prefixed });
  return NextResponse.json({ ok: true, decision });
}
