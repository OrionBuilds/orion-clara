// Removes orphaned sync links. Explicit and never scheduled — sync deliberately never propagates
// deletions, so this is the only path by which a link is forgotten, and it requires confirm:true.
//
// Note this drops the LINK, not the underlying record: neither the local task/contact nor the
// Microsoft one is deleted. Worst case a future sync re-matches or re-creates it.

import { NextRequest, NextResponse } from "next/server";
import { ensureBootstrapped } from "@/lib/clara/bootstrap";
import { principalFromHeaders } from "@/lib/clara/session";
import { reapOrphans } from "@/lib/clara/sync-engine";
import type { MAccount } from "@/lib/clara/ms-auth";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  await ensureBootstrapped();
  if (!principalFromHeaders(req.headers)) return NextResponse.json({ error: "not authenticated" }, { status: 401 });

  const body = await req.json().catch(() => ({})) as {
    kind?: "tasks" | "contacts"; account?: MAccount; ids?: string[]; confirm?: boolean;
  };
  if (!body.confirm) return NextResponse.json({ error: "confirm:true is required" }, { status: 400 });
  if (!body.kind) return NextResponse.json({ error: "kind is required" }, { status: 400 });
  if (!body.ids?.length) return NextResponse.json({ error: "ids[] is required" }, { status: 400 });

  const res = await reapOrphans(body.kind, body.account ?? "work", body.ids);
  return NextResponse.json({ ok: true, ...res });
}
