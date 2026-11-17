// Clara — local call transcription. Twilio's recording webhook (api/channels/twilio/recording)
// already saves vault/transcripts/YYYY-MM-DD/<sid>.wav + a stub .md with the literal marker below;
// this module fills those stubs in. Runs entirely local (whisper.cpp) — audio never leaves the
// machine, matching the same "sensitive stays local" posture as sensitivity.ts.
//
// Neither whisper.cpp nor ffmpeg ships with Clara — see config.ts's whisperBin/whisperModel/
// ffmpegBin. whisperHealth() surfaces whether they're actually findable so /system can show it
// plainly instead of this module silently doing nothing.

import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import path from "node:path";
import { loadConfig } from "./config";
import { runProcess } from "@autom8ionlab/agent-core";
import { append as ledgerAppend } from "./ledger";
import { indexVaultFile } from "./memory";

export const PENDING_MARKER = "_Transcript pending";
const MAX_ATTEMPTS = 3;
const TRANSCRIBE_TIMEOUT_MS = 15 * 60_000;

export interface PendingCall { mdPath: string; wavPath: string; callSid: string; dateDir: string }

async function transcriptsDir(): Promise<string> {
  const cfg = await loadConfig();
  return path.join(cfg.vaultRoot, "transcripts");
}

export async function findPending(): Promise<PendingCall[]> {
  const root = await transcriptsDir();
  let dateDirs: string[] = [];
  try { dateDirs = (await fs.readdir(root, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name); }
  catch { return []; }

  const out: PendingCall[] = [];
  for (const dateDir of dateDirs) {
    const dir = path.join(root, dateDir);
    let files: string[] = [];
    try { files = await fs.readdir(dir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith(".md")) continue;
      const mdPath = path.join(dir, f);
      const wavPath = path.join(dir, f.replace(/\.md$/, ".wav"));
      if (!existsSync(wavPath)) continue;
      const raw = await fs.readFile(mdPath, "utf8").catch(() => "");
      if (raw.includes(PENDING_MARKER)) out.push({ mdPath, wavPath, callSid: f.replace(/\.md$/, ""), dateDir });
    }
  }
  return out;
}

interface TranscribeState { [callSid: string]: { attempts: number; lastError?: string; lastAt: string } }

async function statePath(): Promise<string> {
  const cfg = await loadConfig();
  return path.join(cfg.dataDir, "transcribe-state.json");
}
async function readState(): Promise<TranscribeState> {
  try { return JSON.parse(await fs.readFile(await statePath(), "utf8")); } catch { return {}; }
}
async function writeState(s: TranscribeState): Promise<void> {
  await fs.writeFile(await statePath(), JSON.stringify(s, null, 2), "utf8").catch(() => {});
}

export interface WhisperHealth { binFound: boolean; modelFound: boolean; ffmpegFound: boolean }
export async function whisperHealth(): Promise<WhisperHealth> {
  const cfg = await loadConfig();
  const binFound = Boolean(cfg.whisperBin) && existsSync(cfg.whisperBin);
  const modelFound = Boolean(cfg.whisperModel) && existsSync(cfg.whisperModel);
  // ffmpeg may be a bare command resolved via PATH (default) rather than an absolute path — a
  // quick `-version` probe is the only reliable way to know either way.
  let ffmpegFound = false;
  try { ffmpegFound = (await runProcess(cfg.ffmpegBin, ["-version"], { timeoutMs: 5000 })).ok; } catch { ffmpegFound = false; }
  return { binFound, modelFound, ffmpegFound };
}

interface TranscribeResult { ok: boolean; error?: string }

// Autonomy Spec v0.1, item #9: every transcribed call gets a short summary appended and a normal-
// priority notify (batches into the daily brief rather than paging — most calls are routine).
// Returns null on any doubt (no API key, no model response) so a summarization hiccup never
// blocks the transcript itself from landing.
async function summarizeCall(text: string): Promise<string | null> {
  const system = "Summarize this phone call transcript in 2-4 short lines: who it was with (if identifiable from what's said), the topic, any decisions made, and any action items. Plain text, no headers, no preamble. If the transcript is too garbled or short to say anything useful, respond with exactly SKIP.";
  // OS model setting (agentSettings.ts) → its fallback → this site's built-in model.
  const { callModelText } = await import("./modelCall");
  const res = await callModelText({ site: "call-summary", purpose: "call-summary", defaultModel: "claude-sonnet-5", system, prompt: text.slice(0, 6000), maxTokens: 300 });
  const out = res?.text?.trim();
  return out && !/^SKIP\b/i.test(out) ? out : null;
}

export async function transcribeOne(call: PendingCall): Promise<TranscribeResult> {
  const cfg = await loadConfig();
  const health = await whisperHealth();
  if (!health.binFound || !health.modelFound) {
    return { ok: false, error: "whisper not configured — set CLARA_WHISPER_BIN / CLARA_WHISPER_MODEL" };
  }
  if (!health.ffmpegFound) return { ok: false, error: "ffmpeg not found — set CLARA_FFMPEG_BIN or add ffmpeg to PATH" };

  const tmpDir = path.join(cfg.dataDir, "tmp");
  await fs.mkdir(tmpDir, { recursive: true });
  const resampled = path.join(tmpDir, `${call.callSid}-16k.wav`);
  const outPrefix = path.join(tmpDir, `${call.callSid}-out`);

  try {
    // Twilio wavs are 8kHz; whisper.cpp wants 16kHz mono.
    const resample = await runProcess(cfg.ffmpegBin, ["-y", "-i", call.wavPath, "-ar", "16000", "-ac", "1", resampled], { timeoutMs: 60_000 });
    if (!resample.ok) return { ok: false, error: `ffmpeg resample failed: ${resample.stderr.slice(0, 300)}` };

    const whisper = await runProcess(cfg.whisperBin, ["-m", cfg.whisperModel, "-f", resampled, "-nt", "-otxt", "-of", outPrefix], { timeoutMs: TRANSCRIBE_TIMEOUT_MS });
    if (!whisper.ok) return { ok: false, error: `whisper failed: ${whisper.stderr.slice(0, 300)}` };

    const text = (await fs.readFile(`${outPrefix}.txt`, "utf8").catch(() => "")).trim();
    if (!text) return { ok: false, error: "whisper produced no text" };

    // Preserve the stub's metadata header; replace only the pending line with the real transcript.
    const raw = await fs.readFile(call.mdPath, "utf8");
    const rewritten = raw.includes(PENDING_MARKER)
      ? raw.replace(new RegExp(`${PENDING_MARKER}.*`, "s"), `## Transcript\n\n${text}\n`)
      : `${raw}\n\n## Transcript\n\n${text}\n`;

    const summary = await summarizeCall(text).catch(() => null);
    const finalMd = summary ? `${rewritten}\n## Summary\n\n${summary}\n` : rewritten;
    await fs.writeFile(call.mdPath, finalMd, "utf8");

    await ledgerAppend({ kind: "call", actor: "clara", what: `transcribed call ${call.callSid}`, ref: call.callSid }).catch(() => {});
    void indexVaultFile(call.mdPath).catch(() => {}); // picks up the existing "transcripts:" provenance tag automatically

    // Meeting digest (tasks/dispatch/vault note/notify) — the same pipeline as Wispr/Meet meetings.
    // The old one-line summary notify stays as the fallback when the digest doesn't land.
    let digested = false;
    try {
      const { ingestRecord, meetingIngestMode } = await import("./meetings/ingest");
      if (meetingIngestMode() !== "off") {
        const from = raw.match(/^- from: (.+)$/m)?.[1]?.trim();
        const endedAt = (await fs.stat(call.wavPath).catch(() => null))?.mtime.toISOString() ?? new Date().toISOString();
        const out = await ingestRecord({
          source: "call",
          sourceId: call.callSid,
          title: `Phone call${from && from !== "?" ? ` with ${from}` : ""} (${call.callSid.slice(-6)})`,
          attendees: from && from !== "?" ? [from] : [],
          startedAt: endedAt,
          transcript: text,
          summary: summary ?? undefined,
          vaultTranscriptPath: path.relative(cfg.vaultRoot, call.mdPath).replace(/\\/g, "/"),
        });
        digested = out.status === "digested";
      }
    } catch { /* fall back to the plain summary notify */ }

    if (summary && !digested) {
      const { notifyOwner } = await import("./notify");
      await notifyOwner({
        kind: "call.summary",
        priority: "normal",
        dedupeKey: `call-summary:${call.callSid}`,
        text: `Call summary (${call.callSid.slice(-6)}): ${summary.slice(0, 300)}`,
      }).catch(() => {});
    }

    return { ok: true };
  } finally {
    await fs.rm(resampled, { force: true }).catch(() => {});
    await fs.rm(`${outPrefix}.txt`, { force: true }).catch(() => {});
  }
}

export interface TranscribePendingResult { found: number; done: number; failed: number; skipped: number }

/** Sequential (never parallel — CPU-bound), 3-strike failure marker so a corrupt/unreadable wav
 *  can't wedge the job forever. Called from a detached scheduler job. */
export async function transcribePending(): Promise<TranscribePendingResult> {
  const pending = await findPending();
  const state = await readState();
  let done = 0, failed = 0, skipped = 0;

  for (const call of pending) {
    const s = state[call.callSid] ?? { attempts: 0, lastAt: "" };
    if (s.attempts >= MAX_ATTEMPTS) { skipped++; continue; }

    const result = await transcribeOne(call);
    if (result.ok) {
      done++;
      delete state[call.callSid];
    } else {
      failed++;
      s.attempts += 1;
      s.lastError = result.error;
      s.lastAt = new Date().toISOString();
      state[call.callSid] = s;
      if (s.attempts >= MAX_ATTEMPTS) {
        // Stop retrying forever — mark the file itself so it's visible without checking state.json.
        const raw = await fs.readFile(call.mdPath, "utf8").catch(() => "");
        if (raw.includes(PENDING_MARKER)) {
          await fs.writeFile(call.mdPath, raw.replace(new RegExp(`${PENDING_MARKER}.*`, "s"), `_Transcription failed after ${MAX_ATTEMPTS} attempts: ${result.error}_\n`), "utf8").catch(() => {});
        }
      }
    }
  }
  await writeState(state);
  return { found: pending.length, done, failed, skipped };
}
