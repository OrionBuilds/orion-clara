import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import path from "node:path";
import { ensureBootstrapped } from "@/lib/clara/bootstrap";
import { loadConfig } from "@/lib/clara/config";
import { principalFromHeaders } from "@/lib/clara/session";

export const runtime = "nodejs";

// The weekly audio digest lands in the vault, which is outside public/ and holds the owner's private
// notes — so it can't be served statically and this route must never resolve outside briefs/.
export async function GET(req: NextRequest, ctx: { params: Promise<{ date: string }> }) {
  await ensureBootstrapped();
  const principal = principalFromHeaders(req.headers);
  if (!principal) return NextResponse.json({ error: "not authenticated" }, { status: 401 });

  const { date } = await ctx.params;
  const cfg = await loadConfig();
  const dir = path.join(cfg.vaultRoot, "briefs");

  let resolved: string;
  if (date === "latest") {
    // /brief doesn't know which Sunday produced the newest digest, so let the server find it
    // rather than having the client probe a fortnight of dates.
    let names: string[] = [];
    try { names = await fs.readdir(dir); } catch { return NextResponse.json({ error: "no briefs yet" }, { status: 404 }); }
    const digests = names.filter((n) => /^\d{4}-\d{2}-\d{2}-weekly\.mp3$/.test(n)).sort();
    const newest = digests[digests.length - 1];
    if (!newest) return NextResponse.json({ error: "no audio digest yet" }, { status: 404 });
    resolved = newest;
  } else {
    // Strict YYYY-MM-DD — this is the whole path-traversal defense, so it's an allowlist, not a
    // blocklist of "..". Anything else never reaches the filesystem.
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return NextResponse.json({ error: "invalid date" }, { status: 400 });
    }
    resolved = `${date}-weekly.mp3`;
  }

  try {
    const buf = await fs.readFile(path.join(dir, resolved));
    return new NextResponse(new Uint8Array(buf), {
      headers: {
        "content-type": "audio/mpeg",
        "content-length": String(buf.length),
        "cache-control": "private, max-age=3600",
        // Lets /brief label the player with the week it covers without a second request.
        "x-digest-date": resolved.slice(0, 10),
      },
    });
  } catch {
    return NextResponse.json({ error: "no audio digest for that week" }, { status: 404 });
  }
}
