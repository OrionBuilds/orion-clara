// The owner's own hold audio for a parked work-line caller (holdTransfer.ts). Twilio's <Play> fetches
// media unsigned, and the file costs nothing to serve, so this is deliberately open — it's on the
// public-path list (hostGate.ts) and inside the Cloudflare bypass for /api/channels/twilio/*.
// Served from disk on every request, so the owner can swap the file without a restart.

import { holdAudioFile } from "@/lib/clara/holdAudio";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const f = await holdAudioFile();
  if (!f) return new Response("no hold audio", { status: 404 });
  return new Response(new Uint8Array(f.bytes), {
    headers: { "Content-Type": f.contentType, "Content-Length": String(f.bytes.length), "Cache-Control": "public, max-age=3600" },
  });
}
