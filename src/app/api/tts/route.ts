// CLARA speaks in HER voice for the Office deck. Interagent-gated (the Office holds the shared
// secret; the owner's own browser traffic never hits this — the deck's server relays). Keys stay in
// CLARA's env, exactly where they already live for her phone calls.

import { NextRequest } from "next/server";
import { verifyInteragentSecret } from "@autom8ionlab/agent-core";
import { elevenTTSAudio } from "@/lib/clara/channels";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(req: NextRequest) {
  if (!verifyInteragentSecret(req)) return new Response("unauthorized", { status: 401 });
  const text = (req.nextUrl.searchParams.get("text") ?? "").slice(0, 900);
  if (!text.trim()) return new Response("no text", { status: 400 });
  const res = await elevenTTSAudio(text, { tone: "owner" });
  if (!res.buf) return new Response(res.error ?? "tts not configured", { status: 503 });
  return new Response(new Uint8Array(res.buf), {
    headers: { "Content-Type": "audio/mpeg", "Cache-Control": "no-store", "Content-Length": String(res.buf.length) },
  });
}
