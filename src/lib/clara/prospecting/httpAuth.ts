// httpAuth.ts — shared guard + error mapping for the /api/prospects/* write routes.
//
// Interagent-authenticated like every other sibling-facing surface (escalate, status, etc.):
// loopback callers and anyone presenting INTERAGENT_SHARED_SECRET pass; `source` in the body is
// attribution for the ledger/logs, not an identity check (see agent-core's verifyInteragentSecret
// doc comment — the shared secret alone is the trust boundary for genuine cross-agent calls).

import { NextRequest, NextResponse } from "next/server";
import { verifyInteragentSecret } from "@autom8ionlab/agent-core";
import { OsProspectingUnavailableError } from "./osBridge";

export function requireInteragent(req: NextRequest): NextResponse | null {
  if (!verifyInteragentSecret(req)) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  return null;
}

/** Runs an osBridge call and maps "OS prospecting tables not live yet" to a clean 503 instead of a
 *  raw 500 — the honest, expected state until the orion migrations in Part 1-3 are applied. */
export async function callOrUnavailable<T>(fn: () => Promise<T>): Promise<{ ok: true; data: T } | { ok: false; status: number; error: string }> {
  try {
    return { ok: true, data: await fn() };
  } catch (e) {
    if (e instanceof OsProspectingUnavailableError) {
      return { ok: false, status: 503, error: "the OS prospecting tables aren't live yet" };
    }
    return { ok: false, status: 500, error: e instanceof Error ? e.message : String(e) };
  }
}
