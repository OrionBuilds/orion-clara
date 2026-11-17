import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import path from "node:path";
import { ensureBootstrapped } from "@/lib/clara/bootstrap";
import { loadConfig } from "@/lib/clara/config";

export const runtime = "nodejs";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ file: string }> }) {
  await ensureBootstrapped();
  const { file } = await ctx.params;

  // Vault-scoped, path-traversal-safe: reject anything that isn't a bare filename, then
  // re-verify the resolved absolute path is still inside documents/ before reading.
  const base = path.basename(file);
  if (base !== file || base.includes("..")) {
    return NextResponse.json({ error: "invalid filename" }, { status: 400 });
  }

  const cfg = await loadConfig();
  const dir = path.join(cfg.vaultRoot, "documents");
  const target = path.join(dir, base);
  if (!target.startsWith(dir + path.sep) && target !== dir) {
    return NextResponse.json({ error: "invalid path" }, { status: 400 });
  }

  try {
    const buf = await fs.readFile(target);
    return new NextResponse(buf, {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="${base}"`,
      },
    });
  } catch {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
}
