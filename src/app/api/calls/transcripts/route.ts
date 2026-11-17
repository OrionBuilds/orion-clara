import { NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import path from "node:path";
import { loadConfig } from "@/lib/clara/config";
import { PENDING_MARKER, transcribePending } from "@/lib/clara/transcribe";
import { ensureBootstrapped } from "@/lib/clara/bootstrap";

export const runtime = "nodejs";

export interface TranscriptListing {
  callSid: string;
  dateDir: string;
  relPath: string;       // vault-relative .md path, for MarkdownView / /api/vault/file
  audioRelPath: string;  // vault-relative .wav path, for /api/vault/file?raw=1
  pending: boolean;
  from?: string;
  to?: string;
  durationSec?: string;
}

function parseMeta(raw: string): Record<string, string> {
  const meta: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const m = line.match(/^-\s*(\w+):\s*(.+)$/);
    if (m) meta[m[1]] = m[2];
  }
  return meta;
}

export async function GET() {
  await ensureBootstrapped();
  const cfg = await loadConfig();
  const root = path.join(cfg.vaultRoot, "transcripts");
  let dateDirs: string[] = [];
  try { dateDirs = (await fs.readdir(root, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name); }
  catch { return NextResponse.json({ transcripts: [] }); }

  const out: TranscriptListing[] = [];
  for (const dateDir of dateDirs.sort().reverse()) {
    let files: string[] = [];
    try { files = await fs.readdir(path.join(root, dateDir)); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith(".md")) continue;
      const raw = await fs.readFile(path.join(root, dateDir, f), "utf8").catch(() => "");
      const meta = parseMeta(raw);
      const callSid = f.replace(/\.md$/, "");
      out.push({
        callSid,
        dateDir,
        relPath: `transcripts/${dateDir}/${f}`,
        audioRelPath: `transcripts/${dateDir}/${callSid}.wav`,
        pending: raw.includes(PENDING_MARKER),
        from: meta.from,
        to: meta.to,
        durationSec: meta.duration,
      });
    }
  }
  return NextResponse.json({ transcripts: out });
}

// On-demand "transcribe now" — runs the same job the scheduler fires every 10 minutes.
export async function POST() {
  await ensureBootstrapped();
  const result = await transcribePending();
  return NextResponse.json(result);
}
