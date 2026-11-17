// Clara — call recording + transcription pipeline.
//
// Recording capture itself is NOT owned here: Twilio's <Start><Recording> verb (see
// app/api/channels/twilio/voice/route.ts) starts it, and the recording webhook
// (app/api/channels/twilio/recording/route.ts) downloads the finished .wav and writes the vault
// stub. This module is the transcription half (B5) — finalizeRecording() locates a call's
// day-folder files and runs them through transcribe.ts.

import { promises as fs } from "node:fs";
import path from "node:path";
import { loadConfig } from "./config";
import { transcribeOne, PENDING_MARKER } from "./transcribe";

export const RECORDING_DISCLOSURE = "This call may be recorded for quality and record-keeping.";

export interface CallRecord {
  callSid: string;
  from: string;
  to: string;
  direction: "inbound" | "outbound";
  startedAt: string;
  endedAt?: string;
  transcript?: string;
  audioPath?: string;
  transcriptPath?: string;
  summary?: string;
}

// startRecording() was removed 2026-08-03. It was an exported async function with an empty body
// and no callers anywhere in the codebase, and its name promised something it could not do: TwiML's
// <Start><Recording> verb (startRecordingTwiml) in voice/route.ts is what actually begins capture. A future caller would
// have "started" a recording, been told nothing was wrong, and got no recording. Deleting it means
// that caller gets a compile error instead of silence.

async function findCallFiles(callSid: string): Promise<{ mdPath: string; wavPath: string; dateDir: string } | null> {
  const cfg = await loadConfig();
  const root = path.join(cfg.vaultRoot, "transcripts");
  let dateDirs: string[] = [];
  try { dateDirs = (await fs.readdir(root, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name); }
  catch { return null; }
  for (const dateDir of dateDirs) {
    const mdPath = path.join(root, dateDir, `${callSid}.md`);
    const wavPath = path.join(root, dateDir, `${callSid}.wav`);
    if (await fs.stat(mdPath).catch(() => null)) return { mdPath, wavPath, dateDir };
  }
  return null;
}

/** Locates the call's md/wav pair and transcribes it synchronously (used for an on-demand
 *  "transcribe now" action; the scheduled job in transcribe.ts handles the general backlog). */
export async function finalizeRecording(callSid: string): Promise<CallRecord> {
  const files = await findCallFiles(callSid);
  if (!files) throw new Error(`no recording found for call ${callSid}`);

  const raw = await fs.readFile(files.mdPath, "utf8");
  const meta: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const m = line.match(/^-\s*(\w+):\s*(.+)$/);
    if (m) meta[m[1]] = m[2];
  }

  if (raw.includes(PENDING_MARKER)) {
    const result = await transcribeOne({ mdPath: files.mdPath, wavPath: files.wavPath, callSid, dateDir: files.dateDir });
    if (!result.ok) throw new Error(result.error ?? "transcription failed");
  }

  const finalRaw = await fs.readFile(files.mdPath, "utf8");
  const transcriptMatch = finalRaw.match(/## Transcript\n\n([\s\S]*)/);

  return {
    callSid,
    from: meta.from ?? "",
    to: meta.to ?? "",
    direction: "inbound",
    startedAt: meta.date ?? new Date().toISOString(),
    transcript: transcriptMatch?.[1]?.trim(),
    audioPath: files.wavPath,
    transcriptPath: files.mdPath,
  };
}
