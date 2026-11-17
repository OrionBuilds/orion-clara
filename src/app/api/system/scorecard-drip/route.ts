// Operator surface for the readiness-scorecard SMS follow-up. Same guard model as
// /api/system/sitrep: loopback + the Access-gated tunnel, no per-route auth.
//
//   GET  /api/system/scorecard-drip                 → mode, window state, and a DRY preview of what
//                                                      the next tick would send (never sends).
//   GET  /api/system/scorecard-drip?lookup=<phone|email> → the lead-context block Clara would use.
//   POST /api/system/scorecard-drip                 → run one tick now (honours CLARA_SCORECARD_DRIP
//                                                      and the 09–18 ET window exactly like the cron).
//   POST /api/system/scorecard-drip {"force":true}  → run one tick ignoring the time window
//                                                      (still honours off/shadow/active).

import { NextResponse } from "next/server";
import { ensureBootstrapped } from "@/lib/clara/bootstrap";
import { dripMode, inSendWindow, hourInDripTz, scorecardDripTick, dueStep, DRIP_STEPS } from "@/lib/clara/scorecardDrip";
import { lookupLead, leadContextBlock } from "@/lib/clara/leadContext";
import { osClient, osEnabled } from "@/lib/clara/osClient";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function unwrap(content: unknown): unknown {
  if (Array.isArray(content)) {
    const first = content.find((c) => c && typeof c === "object" && "text" in (c as object));
    if (first && typeof (first as { text?: unknown }).text === "string") {
      try { return JSON.parse((first as { text: string }).text); } catch { return (first as { text: string }).text; }
    }
  }
  return content;
}

export async function GET(req: Request) {
  await ensureBootstrapped();
  const url = new URL(req.url);
  const lookup = url.searchParams.get("lookup");
  if (lookup) {
    const isEmail = lookup.includes("@");
    const lead = await lookupLead(isEmail ? { email: lookup } : { phone: lookup });
    return NextResponse.json({ lead, block: leadContextBlock(lead) });
  }

  const now = new Date();
  const base = { mode: dripMode(), osConfigured: osEnabled(), hourEt: hourInDripTz(now), inWindow: inSendWindow(now), steps: DRIP_STEPS.map((s) => ({ step: s.step, afterHours: s.afterHours, skipIfOutlineClicked: Boolean(s.skipIfOutlineClicked) })) };
  if (!osEnabled()) return NextResponse.json({ ...base, preview: [] });
  try {
    const rows = unwrap(await osClient.callTool("scorecard_drip_candidates", { limit: 100 }));
    const list = Array.isArray(rows) ? (rows as Array<Record<string, unknown>>) : [];
    const preview = list.map((c) => {
      const step = dueStep(c as never, now);
      return {
        contact_id: c.contact_id,
        name: `${c.first_name ?? ""} ${c.last_name ?? ""}`.trim(),
        phone: c.phone,
        completed_at: c.scorecard_completed_at,
        steps_sent: c.steps_sent,
        e3_clicked: c.e3_clicked,
        due_step: step?.step ?? null,
      };
    });
    return NextResponse.json({ ...base, candidates: list.length, preview });
  } catch (e) {
    return NextResponse.json({ ...base, error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}

//   POST {"force":true,"mode":"active","contactId":"<uuid>"} → supervised live send of the next due
//        step to ONE contact regardless of CLARA_SCORECARD_DRIP (QA / "send me S2 now"). The tick
//        refuses an active override without a contactId.
export async function POST(req: Request) {
  await ensureBootstrapped();
  let body: { force?: boolean; mode?: string; contactId?: string } = {};
  try { body = (await req.json()) as typeof body; } catch { /* no body */ }
  const modeOverride = body.mode === "active" || body.mode === "shadow" || body.mode === "off" ? body.mode : undefined;
  return NextResponse.json(await scorecardDripTick(new Date(), { ignoreWindow: Boolean(body.force), modeOverride, onlyContactId: body.contactId }));
}
