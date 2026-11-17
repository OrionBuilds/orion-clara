// Resolves an ambiguous first-run match that sync parked rather than guessing at.
//
//   action "link"   — this remote record IS that local record; create the link, no data moves yet.
//   action "create" — genuinely new; let the next sync create it locally.
//   action "ignore" — drop it from the pending list and stop asking.

import { NextRequest, NextResponse } from "next/server";
import { ensureBootstrapped } from "@/lib/clara/bootstrap";
import { principalFromHeaders } from "@/lib/clara/session";
import { loadLinks, saveLinks, loadPending, savePending, hashRecord } from "@/lib/clara/sync-engine";
import type { MAccount } from "@/lib/clara/ms-auth";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  await ensureBootstrapped();
  if (!principalFromHeaders(req.headers)) return NextResponse.json({ error: "not authenticated" }, { status: 401 });

  const body = await req.json().catch(() => ({})) as {
    kind?: "tasks" | "contacts"; account?: MAccount;
    remoteId?: string; localId?: string; action?: "link" | "create" | "ignore";
  };
  if (!body.kind || !body.remoteId || !body.action) {
    return NextResponse.json({ error: "kind, remoteId and action are required" }, { status: 400 });
  }
  const account = body.account ?? "work";

  const pending = await loadPending(body.kind, account);
  const row = pending.find((p) => p.remoteId === body.remoteId);
  if (!row) return NextResponse.json({ error: "no pending match with that remoteId" }, { status: 404 });

  if (body.action === "link") {
    if (!body.localId) return NextResponse.json({ error: "localId is required to link" }, { status: 400 });
    const store = await loadLinks(body.kind, account);
    // Hashes are left empty so the next run treats both sides as changed and does a real merge
    // rather than assuming the two records already agree.
    store.links[body.localId] = {
      remoteId: body.remoteId,
      base: row.preview as never,
      localHash: "", remoteHash: hashRecord(row.preview),
      state: "linked", lastSyncAt: new Date().toISOString(), failCount: 0,
    };
    store.byRemote[body.remoteId] = body.localId;
    await saveLinks(store);
  }

  await savePending(body.kind, account, pending.filter((p) => p.remoteId !== body.remoteId));
  return NextResponse.json({ ok: true, action: body.action });
}
