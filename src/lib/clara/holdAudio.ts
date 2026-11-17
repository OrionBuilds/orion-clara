// Clara — where the owner's hold audio lives (2026-09-29).
//
// Order: CLARA_HOLD_AUDIO_URL (a URL Twilio plays directly; nothing served from here), then
// CLARA_HOLD_AUDIO_FILE, then <dataDir>/audio/hold.mp3 (or .wav) — the git-ignored owner-data
// folder put-through.json already lives in, so the owner drops a file there and it's live on the next
// call. With none of them, holdTransfer plays Twilio's sample and the ledger says so once.

import { promises as fs } from "node:fs";
import path from "node:path";
import { loadConfig } from "./config";

type Env = Record<string, string | undefined>;

export function contentTypeFor(file: string): string {
  const ext = path.extname(file).toLowerCase();
  return ext === ".wav" ? "audio/wav" : ext === ".m4a" ? "audio/mp4" : ext === ".ogg" ? "audio/ogg" : "audio/mpeg";
}

/** Pure: the candidate paths, most specific first. */
export function holdAudioCandidates(env: Env, dataDir: string): string[] {
  const explicit = env.CLARA_HOLD_AUDIO_FILE?.trim();
  const dir = path.join(dataDir, "audio");
  return [...(explicit ? [explicit] : []), path.join(dir, "hold.mp3"), path.join(dir, "hold.wav"), path.join(dir, "hold.m4a")];
}

export async function holdAudioPath(env: Env = process.env): Promise<string | null> {
  const cfg = await loadConfig();
  for (const p of holdAudioCandidates(env, cfg.dataDir)) {
    try {
      const st = await fs.stat(p);
      if (st.isFile() && st.size > 0) return p;
    } catch { /* next candidate */ }
  }
  return null;
}

let warned = false;
export async function hasHoldAudioFile(env: Env = process.env): Promise<boolean> {
  if (env.CLARA_HOLD_AUDIO_URL?.trim()) return false;
  const p = await holdAudioPath(env).catch(() => null);
  if (!p && !warned) {
    warned = true;
    const { append } = await import("./ledger");
    const cfg = await loadConfig().catch(() => null);
    await append({ kind: "action", actor: "clara", what: `no hold audio yet — playing Twilio's sample until a file lands in ${cfg ? path.join(cfg.dataDir, "audio", "hold.mp3") : "<dataDir>/audio/hold.mp3"}` }).catch(() => {});
  }
  return p !== null;
}

export async function holdAudioFile(env: Env = process.env): Promise<{ bytes: Buffer; contentType: string } | null> {
  const p = await holdAudioPath(env);
  if (!p) return null;
  return { bytes: await fs.readFile(p), contentType: contentTypeFor(p) };
}
