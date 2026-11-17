// Signed TTS endpoint. Twilio <Play> fetches from here to hear Clara's ElevenLabs voice.
// Signature-guarded so arbitrary callers can't spend TTS credits.

import { NextRequest } from "next/server";
import { ttsSigValid, elevenTTSAudio } from "@/lib/clara/channels";
import type { ToneContext } from "@/lib/clara/persona";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const text = req.nextUrl.searchParams.get("text") ?? "";
  const sig = req.nextUrl.searchParams.get("sig");
  const tone = (req.nextUrl.searchParams.get("tone") ?? "stranger") as ToneContext;
  if (!text || !ttsSigValid(text, sig)) return new Response("bad signature", { status: 403 });
  const res = await elevenTTSAudio(text, { telephony: true, tone });
  if (res.buf) {
    return new Response(new Uint8Array(res.buf), { headers: { "Content-Type": "audio/basic", "Cache-Control": "public, max-age=300" } });
  }
  return new Response(res.error ?? "tts unavailable", { status: 502 });
}
