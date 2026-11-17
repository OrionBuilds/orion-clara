import { NextRequest, NextResponse } from "next/server";
import { ensureBootstrapped } from "@/lib/clara/bootstrap";
import { principalFromHeaders } from "@/lib/clara/session";
import { loadLinks, loadPending } from "@/lib/clara/sync-engine";
import { M_ACCOUNTS, type MAccount } from "@/lib/clara/ms-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  await ensureBootstrapped();
  if (!principalFromHeaders(req.headers)) return NextResponse.json({ error: "not authenticated" }, { status: 401 });

  const out: Record<string, unknown>[] = [];
  // Contacts only ever sync on the work slot; tasks sync on both.
  const combos: { kind: "tasks" | "contacts"; account: MAccount }[] = [
    ...M_ACCOUNTS.map((a) => ({ kind: "tasks" as const, account: a })),
    { kind: "contacts" as const, account: "work" as MAccount },
  ];

  for (const { kind, account } of combos) {
    const store = await loadLinks(kind, account);
    const pending = await loadPending(kind, account);
    const links = Object.values(store.links);
    out.push({
      kind, account,
      lastRunAt: store.lastRunAt ?? null,
      linked: links.filter((l) => l.state === "linked").length,
      orphanLocal: links.filter((l) => l.state === "orphan-local").length,
      orphanRemote: links.filter((l) => l.state === "orphan-remote").length,
      stuck: links.filter((l) => l.state === "conflict").length,
      pending: pending.length,
      pendingRows: pending,
    });
  }
  return NextResponse.json({ stores: out });
}
