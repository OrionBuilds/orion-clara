// Read-only mail-folder inventory (Microsoft Graph; "labels" in the UI/route names is legacy
// Gmail terminology — the underlying objects are now Outlook mail folders).
//
// Deleting a folder here is permanent, so nothing gets deleted until the owner has seen the
// actual list with counts. This route is that list. Mail itself is never destroyed by this route
// — ms-mail.ts's deleteLabel() empties a folder into Archive before deleting it, specifically so
// this route keeps the same "the tag/folder is permanent, the mail survives" guarantee it had
// under Gmail, even though Graph's own DELETE /mailFolders/{id} would otherwise destroy the mail
// filed in it too.
//
// It is also the only practical way to inspect folders at all: `tsx -e` cannot load ms-auth.ts
// in isolation (the dynamic import never settles), so a running server is the only place the work
// account's token is usable.

import { NextResponse } from "next/server";
import { ensureBootstrapped } from "@/lib/clara/bootstrap";
import { listLabels, deleteLabel } from "@/lib/clara/ms-mail";
import { append as ledgerAppend } from "@/lib/clara/ledger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  await ensureBootstrapped();
  try {
    const labels = await listLabels();
    const user = labels.filter((l) => l.type === "user");
    const system = labels.filter((l) => l.type === "system");
    return NextResponse.json({
      total: labels.length,
      // Split because only `user` labels are deletable — Gmail rejects deleting a system label,
      // and showing them in the same list invites asking for something impossible.
      user,
      system: system.map((l) => l.name),
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}

/**
 * POST { ids: string[] } → delete those folders. Permanent (the folder; the mail inside it is
 * moved to Archive first — see the file header and ms-mail.ts's deleteLabel()).
 *
 * Explicit ids only. There is no "delete all", no name matching and no pattern — the caller has to
 * have listed the folders via GET and named each one it wants gone. System folders are refused
 * here rather than relying on Graph to reject them, so the refusal is legible in the response.
 *
 * Every deletion is ledgered by name, because after the fact the id means nothing to anyone.
 */
export async function POST(req: Request) {
  await ensureBootstrapped();
  const body = await req.json().catch(() => ({})) as { ids?: unknown };
  const ids = Array.isArray(body.ids) ? body.ids.filter((x): x is string => typeof x === "string" && !!x) : [];
  if (!ids.length) return NextResponse.json({ error: "ids[] required — this endpoint never deletes by pattern" }, { status: 400 });

  try {
    const all = await listLabels();
    const byId = new Map(all.map((l) => [l.id, l]));

    const deleted: string[] = [];
    const refused: { id: string; reason: string }[] = [];

    for (const id of ids) {
      const label = byId.get(id);
      if (!label) { refused.push({ id, reason: "no such label" }); continue; }
      if (label.type === "system") { refused.push({ id, reason: `"${label.name}" is a system label` }); continue; }
      const r = await deleteLabel(id);
      if (r.ok) deleted.push(label.name);
      else refused.push({ id, reason: `${label.name}: ${r.error ?? "delete failed"}` });
    }

    if (deleted.length) {
      await ledgerAppend({
        kind: "action",
        actor: "clara",
        what: `deleted ${deleted.length} Gmail label(s): ${deleted.join(", ")}`,
        meta: { deleted: deleted.join(","), refused: String(refused.length) },
      }).catch(() => {});
    }

    return NextResponse.json({ deleted, refused, remaining: (await listLabels()).filter((l) => l.type === "user").length });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
