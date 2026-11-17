// Twilio Recording status callback — fires when a recording completes.
// Downloads the .wav, saves to vault/transcripts/YYYY-MM-DD/<sid>.wav, and stubs a transcript file
// that a Whisper/local STT step (W6) can fill in later.

import { promises as fs } from "node:fs";
import path from "node:path";
import { loadConfig } from "@/lib/clara/config";
import { twilioConfig, twilioSignatureValid, twilioPublicUrl } from "@/lib/clara/channels";
import { append as ledgerAppend } from "@/lib/clara/ledger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Only Twilio's own recording-storage host is ever fetched — closes the SSRF/credential-leak
// finding where an attacker-supplied RecordingUrl got our Twilio Basic-auth header attached.
const ALLOWED_RECORDING_HOST = "api.twilio.com";

export async function POST(req: Request) {
  const params: Record<string, string> = {};
  try {
    const form = await req.formData();
    for (const [k, v] of form.entries()) params[k] = String(v);
  } catch { return new Response("ok"); }

  // Public endpoint (Twilio-invoked) — reject anything that isn't a genuine, signed Twilio
  // request. Previously this route had NO signature check at all, unlike voice/screen/sms.
  if (!twilioSignatureValid(req, twilioPublicUrl(req), params)) {
    return new Response("invalid Twilio signature", { status: 403 });
  }

  const recordingUrl = params.RecordingUrl;
  const callSid = params.CallSid ?? "unknown";
  const status = params.RecordingStatus ?? "";
  if (status !== "completed" || !recordingUrl) return new Response("ok");

  // Defense in depth even with a valid signature: refuse to fetch (and attach our live Twilio
  // credential to) anything that isn't literally Twilio's own recording-storage host.
  let parsedHost: string;
  try { parsedHost = new URL(recordingUrl).hostname.toLowerCase(); }
  catch { return new Response("bad RecordingUrl", { status: 400 }); }
  if (parsedHost !== ALLOWED_RECORDING_HOST) {
    return new Response("RecordingUrl host not allowed", { status: 400 });
  }

  const cfg = await loadConfig();
  const tw = twilioConfig();
  const today = new Date().toISOString().slice(0, 10);
  const dir = path.join(cfg.vaultRoot, "transcripts", today);
  await fs.mkdir(dir, { recursive: true });
  const wavPath = path.join(dir, `${callSid}.wav`);
  const stubPath = path.join(dir, `${callSid}.md`);

  // Fetch the audio (Twilio serves .wav on the recording URL + suffix). Requires auth.
  if (tw) {
    try {
      const auth = Buffer.from(`${tw.sid}:${tw.token}`).toString("base64");
      const r = await fetch(`${recordingUrl}.wav`, { headers: { Authorization: `Basic ${auth}` } });
      if (r.ok) await fs.writeFile(wavPath, Buffer.from(await r.arrayBuffer()));
    } catch { /* logged in stub */ }
  }

  await fs.writeFile(stubPath, [
    `# Call transcript — ${callSid}`,
    ``,
    `- date: ${new Date().toISOString()}`,
    `- audio: \`${wavPath}\``,
    `- from: ${params.From ?? "?"}`,
    `- to: ${params.To ?? "?"}`,
    `- duration: ${params.RecordingDuration ?? "?"}s`,
    ``,
    `_Transcript pending — will be filled by local Whisper (W6)._`,
  ].join("\n"), "utf8");

  await ledgerAppend({
    kind: "call",
    actor: "clara",
    what: `recording saved for ${callSid} (${params.RecordingDuration ?? "?"}s)`,
    ref: callSid,
    meta: { wavPath, stubPath },
  });

  return new Response("ok");
}
