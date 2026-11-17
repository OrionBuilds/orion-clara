import { NextRequest, NextResponse } from "next/server";
import { ensureBootstrapped } from "@/lib/clara/bootstrap";
import { markDone, decideApproval, type InboxItem } from "@/lib/clara/inbox";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  await ensureBootstrapped();
  const body = await req.json().catch(() => ({}));
  const { item, action } = body as { item?: InboxItem; action?: "done" | "approve" | "reject" };
  if (!item?.id || !action) return NextResponse.json({ error: "item + action required" }, { status: 400 });

  try {
    if (action === "done") await markDone(item);
    // decideApproval routes by source: Clara's own approvals through lib/clara/approvals'
    // approve/reject, "friday-approval" through agentProxy.decideAgentApproval
    // (agent prefix stripped from the id, per-app decision verbs translated there).
    else await decideApproval(item, action);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
