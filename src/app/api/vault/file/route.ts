import { NextRequest, NextResponse } from "next/server";
import { ensureBootstrapped } from "@/lib/clara/bootstrap";
import { readNote, readRaw, writeNote, VaultPathError, VaultConflictError } from "@/lib/clara/vault";
import { updateFileInIndex } from "@/lib/clara/wikilinks";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  await ensureBootstrapped();
  const p = req.nextUrl.searchParams.get("path");
  if (!p) return NextResponse.json({ error: "path required" }, { status: 400 });
  const raw = req.nextUrl.searchParams.get("raw") === "1";
  try {
    if (raw) {
      const { buf, contentType } = await readRaw(p);
      return new NextResponse(new Uint8Array(buf), { headers: { "content-type": contentType } });
    }
    const { content, mtimeMs } = await readNote(p);
    return NextResponse.json({ content, mtimeMs });
  } catch (e) {
    if (e instanceof VaultPathError) return NextResponse.json({ error: e.message }, { status: 400 });
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
}

export async function PUT(req: NextRequest) {
  await ensureBootstrapped();
  const body = await req.json().catch(() => ({}));
  const { path: p, content, expectedMtime } = body as { path?: string; content?: string; expectedMtime?: number };
  if (!p || typeof content !== "string") return NextResponse.json({ error: "path + content required" }, { status: 400 });
  try {
    const result = await writeNote(p, content, { expectedMtime, actor: "owner" });
    // Incremental link-index update — kept out of vault.ts itself to avoid a circular import
    // (wikilinks.ts already depends on vault.ts's listTree/readNote for the full rebuild).
    void updateFileInIndex(p, content).catch(() => {});
    return NextResponse.json(result);
  } catch (e) {
    if (e instanceof VaultConflictError) {
      return NextResponse.json({ error: "conflict", diskMtimeMs: e.diskMtimeMs }, { status: 409 });
    }
    if (e instanceof VaultPathError) return NextResponse.json({ error: e.message }, { status: 400 });
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
