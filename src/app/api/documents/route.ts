import { NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import path from "node:path";
import { ensureBootstrapped } from "@/lib/clara/bootstrap";
import { loadConfig } from "@/lib/clara/config";

export const runtime = "nodejs";

export async function GET() {
  await ensureBootstrapped();
  const cfg = await loadConfig();
  const dir = path.join(cfg.vaultRoot, "documents");
  let files: { name: string; sizeKb: number; modifiedAt: string }[] = [];
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    files = await Promise.all(
      entries.filter((e) => e.isFile()).map(async (e) => {
        const st = await fs.stat(path.join(dir, e.name));
        return { name: e.name, sizeKb: Math.round(st.size / 1024), modifiedAt: st.mtime.toISOString() };
      })
    );
    files.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  } catch { /* no documents yet */ }
  return NextResponse.json(files);
}
