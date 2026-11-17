// The intent router as a first-class surface.
//
// Same brain the SMS path uses, reachable from the web UI and testable without sending a text.
// Returns the tool calls it made alongside the reply, so a caller can SEE whether anything
// actually happened rather than taking a sentence's word for it — which is the entire point of
// the router (see intent.ts).
//
// Principal-scoped: middleware stamps every web request as the owner, and the router can archive mail,
// move meetings and restart services. It is not exposed to anyone else.

import { NextResponse } from "next/server";
import { ensureBootstrapped } from "@/lib/clara/bootstrap";
import { runIntent } from "@/lib/clara/intent";
import { principalFromHeaders } from "@/lib/clara/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Tool chains can include a full inbox sweep.
export const maxDuration = 800;

export async function POST(req: Request) {
  await ensureBootstrapped();
  const body = await req.json().catch(() => ({})) as { text?: string; source?: string };
  const text = String(body.text ?? "").trim();
  if (!text) return NextResponse.json({ error: "text required" }, { status: 400 });

  // Middleware stamps this header on every web request. Defaulting to "owner" rather than throwing
  // matches how the rest of the app treats the local UI as the owner's own console.
  const principal = principalFromHeaders(req.headers) ?? "owner";
  const source = body.source === "voice" ? "voice" : body.source === "sms" ? "sms" : "chat";

  // source:"voice" installs the same deferSlow the telephony route uses, so voice behaviour is
  // exercisable without placing a call — but it RECORDS what would be deferred instead of running
  // it and paging. The point of the check is that a minutes-long tool is not awaited inline, and
  // that is observable without also sweeping the mailbox again.
  const deferred: string[] = [];
  const outcome = await runIntent(text, {
    principal,
    source,
    deferSlow: source === "voice" ? (tool) => { deferred.push(tool.name); } : undefined,
  });
  return NextResponse.json({
    reply: outcome.reply,
    // The honest part: what ran, and whether it worked. A reply with an empty `calls` array is a
    // reply that changed nothing, no matter how it reads.
    calls: outcome.calls.map((c) => ({ name: c.name, ok: c.ok, result: c.resultLine })),
    failed: outcome.failed,
    clarifying: outcome.clarifying,
    /** Tool names that were started rather than awaited. Only ever populated for source:"voice". */
    deferred,
  });
}
