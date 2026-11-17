// Run an inbox sweep with explicit bounds, and get the real result back.
//
// The sweep previously had exactly two triggers: the OS daily schedule, and a fire-and-forget SMS/
// chat command whose caller never sees the result object. Neither lets you say "clear the whole
// backlog" or inspect what actually happened — so a sweep could only ever be observed through a
// prose summary. This route is the awaitable, parameterised form, and it is what the intent router
// will call as its `sweep_inbox` tool.
//
// Rails are unchanged: runInboxZero still only ever markRead / archive / star / addLabel, still
// never touches VIP or family, still never deletes, and dryRun still performs zero Gmail writes.

import { NextResponse } from "next/server";
import { ensureBootstrapped } from "@/lib/clara/bootstrap";
import { runInboxZero } from "@/lib/clara/inboxZero";
import { sweepFollowUp } from "@/lib/clara/inboxSweep";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A full-backlog pass is hundreds of sequential Gmail calls; the default 60s is not enough.
export const maxDuration = 800;

export async function POST(req: Request) {
  await ensureBootstrapped();
  const body = await req.json().catch(() => ({})) as {
    dryRun?: boolean; maxMutations?: number; maxScan?: number;
  };

  try {
    const result = await runInboxZero({
      // Defaults to a DRY run. The destructive option has to be asked for by name — the opposite
      // default would make an accidental empty POST rewrite the mailbox.
      dryRun: body.dryRun !== false,
      maxMutations: body.maxMutations,
      maxScan: body.maxScan,
    });
    return NextResponse.json({ summary: sweepFollowUp(result), result });
  } catch (e) {
    // Surfaced, not swallowed — this is the path a dead Gmail token now takes, and the caller must
    // be able to tell it apart from a mailbox that was already clean.
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
