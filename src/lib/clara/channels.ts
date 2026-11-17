// Clara channels — Twilio SMS/voice + ElevenLabs TTS.
//
// Clara-scoped envs (CLARA_TWILIO_*, CLARA_ELEVENLABS_VOICE_ID) so she never crosses wires with FRIDAY.

import crypto from "node:crypto";
import { toneFor, type ToneContext } from "./persona";
import { ownerDeliveryPhoneFromEnv } from "./ownerPhones";
import { effectiveVoiceId, peekAgentSettings, voiceSettingOverrides } from "./agentSettings";
import { ttsUsable, ttsProbeDue, markTtsProbing, markTtsFailure, markTtsSuccess, ttsOutageText, ttsAttemptToken, ttsProbing } from "./ttsHealth";

// ── Twilio config ────────────────────────────────────────────────────────
export interface TwilioCfg {
  sid: string; token: string; from: string;
  ownerNumber?: string;       // where inbound "for the owner" calls are transferred: their personal cell, else OWNER_PHONE
  publicBase?: string;       // https://clara.example.com — for signed <Play>
}

export function twilioConfig(): TwilioCfg | null {
  const sid = process.env.CLARA_TWILIO_ACCOUNT_SID?.trim();
  const token = process.env.CLARA_TWILIO_AUTH_TOKEN?.trim();
  const from = process.env.CLARA_TWILIO_NUMBER?.trim();
  if (!sid || !token || !from) return null;
  return {
    sid, token, from,
    ownerNumber: ownerDeliveryPhoneFromEnv(),
    publicBase: process.env.CLARA_PUBLIC_WEBHOOK_BASE?.trim().replace(/\/$/, ""),
  };
}

export async function sendSMS(to: string, body: string): Promise<{ ok: boolean; sid?: string; error?: string }> {
  const cfg = twilioConfig();
  if (!cfg) return { ok: false, error: "Twilio not configured (set CLARA_TWILIO_* in .env.local)" };
  const auth = Buffer.from(`${cfg.sid}:${cfg.token}`).toString("base64");
  const form = new URLSearchParams({ To: to, From: cfg.from, Body: body.slice(0, 1500) });
  const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${cfg.sid}/Messages.json`, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  if (!r.ok) return { ok: false, error: `Twilio SMS ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}` };
  const j = await r.json().catch(() => ({})) as { sid?: string };
  return { ok: true, sid: j.sid };
}

// Place an outbound call. The call is answered by /api/channels/twilio/call-tw-answer which
// speaks `message` in Clara's voice (with legal-disclosure prepended), records, then hangs up.
// For a two-way conversation, point `url` at a webhook with its own gather-loop (see voice/route.ts
// and business-call/route.ts). `opts` covers what a goal-directed outbound call needs beyond the
// basic dial: a status callback for call-end finalization, and answering-machine detection.
export async function placeCall(
  to: string,
  twimlOrUrl: { twiml?: string; url?: string },
  opts?: { statusCallback?: string; statusCallbackEvent?: string[]; machineDetection?: "Enable" | "DetectMessageEnd"; machineDetectionTimeoutSec?: number; timeoutSec?: number },
): Promise<{ ok: boolean; sid?: string; error?: string }> {
  const cfg = twilioConfig();
  if (!cfg) return { ok: false, error: "Twilio not configured" };
  const auth = Buffer.from(`${cfg.sid}:${cfg.token}`).toString("base64");
  const form = new URLSearchParams({ To: to, From: cfg.from });
  if (twimlOrUrl.twiml) form.set("Twiml", twimlOrUrl.twiml);
  else if (twimlOrUrl.url) form.set("Url", twimlOrUrl.url);
  else return { ok: false, error: "twiml or url required" };
  if (opts?.statusCallback) form.set("StatusCallback", opts.statusCallback);
  for (const ev of opts?.statusCallbackEvent ?? []) form.append("StatusCallbackEvent", ev);
  if (opts?.machineDetection) form.set("MachineDetection", opts.machineDetection);
  // How long detection may take before Twilio gives up and reports "unknown" (Twilio's floor is 3s).
  if (opts?.machineDetectionTimeoutSec) form.set("MachineDetectionTimeout", String(Math.max(3, Math.min(59, Math.round(opts.machineDetectionTimeoutSec)))));
  // Ring time before Twilio gives up (no-answer). The morning call uses 25s so an unanswered
  // ring never rolls to a carrier voicemail that machine detection then has to sit through.
  if (opts?.timeoutSec) form.set("Timeout", String(Math.max(5, Math.min(600, Math.round(opts.timeoutSec)))));
  // Recording is intentionally NOT enabled at the Call-resource level (Record=true starts
  // capturing from the moment the call is answered, racing the spoken disclosure that's
  // supposed to precede it). Instead each TwiML path starts recording itself via
  // startRecordingTwiml() (<Start><Recording>) placed AFTER the disclosure has already played as a blocking verb — see call/route.ts and
  // voice/route.ts.
  const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${cfg.sid}/Calls.json`, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  if (!r.ok) return { ok: false, error: `Twilio call ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}` };
  const j = await r.json().catch(() => ({})) as { sid?: string };
  return { ok: true, sid: j.sid };
}

async function twilioRest(path: string, method: "POST" | "GET" | "DELETE", form?: URLSearchParams): Promise<{ ok: boolean; status: number; body: string }> {
  const cfg = twilioConfig();
  if (!cfg) return { ok: false, status: 0, body: "Twilio not configured" };
  const auth = Buffer.from(`${cfg.sid}:${cfg.token}`).toString("base64");
  const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${cfg.sid}${path}`, {
    method,
    headers: { Authorization: `Basic ${auth}`, ...(form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}) },
    body: form?.toString(),
  });
  const text = await r.text().catch(() => "");
  // A successful body is data the caller parses (a queue list); only an error body is trimmed for a message.
  return { ok: r.ok, status: r.status, body: r.ok ? text : text.slice(0, 300) };
}

/** Pure: from one Twilio Queues page body, the queue sid with this exact name and, if not found, the
 *  path (with query) of the next page. Both null when nothing matched and the list is done. */
export function queuePageSearch(body: string, name: string): { sid: string | null; nextPath: string | null } {
  try {
    const j = JSON.parse(body) as { queues?: Array<{ sid?: string; friendly_name?: string }>; next_page_uri?: string | null };
    const sid = j.queues?.find((q) => q.friendly_name === name)?.sid ?? null;
    // Twilio's next_page_uri already carries the API version, e.g. "/2010-04-01/Accounts/AC…/Queues.json?Page=2&…".
    const raw = j.next_page_uri ?? null;
    const nextPath = raw ? raw.replace(/^\/2010-04-01\/Accounts\/[^/]+/, "") : null;
    return { sid, nextPath };
  } catch {
    return { sid: null, nextPath: null };
  }
}

/** Kept for the older tests: the first page's match only. */
export function queueSidFromList(body: string, name: string): string | null {
  return queuePageSearch(body, name).sid;
}

/**
 * Move a live call to new TwiML right now, wherever it is — parked in a queue, mid-<Play>, mid-
 * <Gather>. This is how a held work-line caller comes back to Clara the moment the owner texts "2"
 * (holdTransfer.ts). Fails when the call has already ended, which callers treat as "they hung up".
 */
export async function redirectCall(callSid: string, url: string): Promise<{ ok: boolean; error?: string }> {
  const r = await twilioRest(`/Calls/${encodeURIComponent(callSid)}.json`, "POST", new URLSearchParams({ Url: url, Method: "POST" }));
  return r.ok ? { ok: true } : { ok: false, error: `Twilio redirect ${r.status}: ${r.body}` };
}

export async function hangupCall(callSid: string): Promise<{ ok: boolean; error?: string }> {
  const r = await twilioRest(`/Calls/${encodeURIComponent(callSid)}.json`, "POST", new URLSearchParams({ Status: "completed" }));
  return r.ok ? { ok: true } : { ok: false, error: `Twilio hangup ${r.status}: ${r.body}` };
}

/** Delete a call queue by its friendly name once its one caller has left — <Enqueue> creates them on demand. */
export async function deleteQueueByName(name: string): Promise<boolean> {
  // The Queues list has no name filter and (however unlikely) can span pages. Follow next_page_uri
  // until the exact name matches or the list runs out; report success only when either we deleted
  // it or every page confirmed it isn't there. A hard cap of 20 pages keeps a runaway list bounded.
  let next: string | null = `/Queues.json?PageSize=50`;
  for (let page = 0; page < 20 && next; page++) {
    const list = await twilioRest(next, "GET");
    if (!list.ok) return false;
    const found = queuePageSearch(list.body, name);
    if (found.sid) return (await twilioRest(`/Queues/${found.sid}.json`, "DELETE")).ok;
    next = found.nextPath;
  }
  // Ran out of pages without finding it (or the cap tripped): report success only if the list
  // really ended. A cap-tripped run is a "we don't know", which is a failure.
  return next === null;
}

// ── TwiML helpers ────────────────────────────────────────────────────────
export function xmlResponse(body: string): Response {
  return new Response(`<?xml version="1.0" encoding="UTF-8"?>\n${body}`, {
    headers: { "Content-Type": "text/xml; charset=utf-8" },
  });
}
export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
export function twimlMessage(text: string): string {
  return `<Response><Message>${esc(text)}</Message></Response>`;
}

// Background call recording, started mid-call once the disclosure has played. Twilio's schema for
// <Start> takes <Recording> (not the standalone <Record> verb) — <Start><Record> drew a 12200
// validation warning on every call and is not a supported form.
export function startRecordingTwiml(base: string): string {
  return `<Start><Recording recordingStatusCallback="${esc(`${base}/api/channels/twilio/recording`)}" recordingStatusCallbackEvent="completed"/></Start>`;
}

// Twilio's own voice, used when ElevenLabs is unconfigured or failing (ttsHealth.ts).
export const FALLBACK_VOICE = "Polly.Joanna-Neural";

// ── Speak — <Play> a signed URL to our TTS route, or fall back to Polly. ──
// Polly also covers an ElevenLabs outage: a <Play> whose fetch 502s plays Twilio's error message to
// the caller, so while ttsHealth says the provider is down Clara speaks with Twilio's voice instead.
export function speak(text: string, base: string, tone: ToneContext = "stranger"): string {
  const t = text.slice(0, 850).trim();
  if (elevenKey()) {
    if (ttsUsable()) {
      const url = `${base}/api/channels/twilio/tts?text=${encodeURIComponent(t)}&sig=${ttsSign(t)}&tone=${tone}`;
      return `<Play>${esc(url)}</Play>`;
    }
    if (ttsProbeDue()) void probeElevenLabs().catch(() => {});
  }
  return `<Say voice="${FALLBACK_VOICE}">${esc(t)}</Say>`;
}

/** Scheduler check (every 15 min): finds an ElevenLabs outage before a caller does, and brings the
 *  voice back once it recovers. A tiny synth, so the cost is a few hundred characters a day. */
export async function voiceHealthTick(): Promise<string> {
  if (!elevenKey()) return "not configured";
  if (!ttsUsable() && !ttsProbeDue()) return ttsProbing() ? "checking" : "down (waiting)";
  return (await probeElevenLabs()) ? "ok" : "down";
}

/** One background synth after the down window, so a live caller is never the test. */
export async function probeElevenLabs(): Promise<boolean> {
  markTtsProbing(true);
  try {
    const res = await elevenTTSAudio("Voice check.", { telephony: true, tone: "stranger", noCache: true });
    return Boolean(res.buf);
  } finally {
    markTtsProbing(false);
  }
}

// Gather-then-hit-webhook loop for a live spoken conversation.
export function gather(prompt: string, base: string, actionPath: string, tone: ToneContext = "stranger"): string {
  return `<Response>` +
    `<Gather input="speech" speechTimeout="auto" action="${esc(actionPath)}" method="POST">` +
    speak(prompt, base, tone) +
    `</Gather>` +
    speak("I didn't catch that. Call back any time.", base, tone) +
    `</Response>`;
}

// Speak a final line and end the call — used when a goal-directed conversation (business-call
// route) decides it's done, rather than looping into another <Gather>.
export function sayAndHangup(text: string, base: string, tone: ToneContext = "stranger"): string {
  return `<Response>${speak(text, base, tone)}<Hangup/></Response>`;
}

// Autonomy Spec v0.1, item #10: live, WHISPERED transfer — <Number url> is the TwiML Twilio
// requests once the callee (the owner) actually answers, and plays ONLY to the owner before the two legs
// are bridged; the caller keeps hearing ringback throughout. `action` fires once the dial verb
// itself finishes (bridged call ended, OR never connected — no-answer/busy/failed), with the
// ORIGINAL caller still connected, so that route is exactly where the no-answer fallback lives.
/**
 * Park the caller in a queue of their own (holdTransfer.ts). Twilio requests `waitUrl` for the hold
 * TwiML and again each time it finishes, and `action` once the caller leaves the queue — bridged,
 * left, hung up, or redirected away. The say-XML plays before they are parked.
 */
export function enqueue(opts: { queueName: string; waitUrl: string; actionUrl: string; sayXml?: string }): string {
  return `<Response>${opts.sayXml ?? ""}` +
    `<Enqueue waitUrl="${esc(opts.waitUrl)}" waitUrlMethod="POST" action="${esc(opts.actionUrl)}" method="POST">${esc(opts.queueName)}</Enqueue>` +
    `</Response>`;
}

export function dial(opts: { number: string; whisperUrl: string; actionUrl: string; callerId?: string; timeoutSec?: number }): string {
  return `<Response><Dial timeout="${opts.timeoutSec ?? 20}" action="${esc(opts.actionUrl)}"${opts.callerId ? ` callerId="${esc(opts.callerId)}"` : ""}>` +
    `<Number url="${esc(opts.whisperUrl)}">${esc(opts.number)}</Number></Dial></Response>`;
}

// ── Twilio signature verify ──────────────────────────────────────────────
export function twilioPublicUrl(req: Request, includeQuery = false): string {
  const host = req.headers.get("host") ?? "127.0.0.1:3939";
  const proto = req.headers.get("x-forwarded-proto") ?? "https";
  const u = new URL(req.url);
  return `${proto}://${host}${u.pathname}${includeQuery ? u.search : ""}`;
}
/** @param isProdOverride Test-only escape hatch so the prod fail-closed branches are directly
 *  unit-testable without mutating process.env.NODE_ENV in a live server. Defaults to the real
 *  environment for every actual call site. */
export function twilioSignatureValid(req: Request, url: string, params: Record<string, string>, isProdOverride?: boolean): boolean {
  const isProd = isProdOverride ?? process.env.NODE_ENV === "production";
  // The explicit dev-mode escape hatch and the "no token configured" fallback must NEVER apply
  // in production — previously both silently accepted unsigned requests in prod too, which
  // combined with the missing-auth finding meant every Twilio webhook could be forged end to end.
  if (process.env.TWILIO_ENFORCE_SIGNATURE === "false") {
    if (isProd) throw new Error("TWILIO_ENFORCE_SIGNATURE=false is not permitted in production");
    return true;
  }
  const token = process.env.CLARA_TWILIO_AUTH_TOKEN?.trim();
  if (!token) {
    if (isProd) return false; // fail closed in prod — an unset token must not open the gate
    return true; // fail open only for local dev convenience
  }
  const header = req.headers.get("x-twilio-signature");
  if (!header) return false;
  let data = url;
  for (const k of Object.keys(params).sort()) data += k + params[k];
  const expected = crypto.createHmac("sha1", token).update(Buffer.from(data, "utf8")).digest("base64");
  const a = Buffer.from(expected), b = Buffer.from(header);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ── Signed TTS URL (Twilio's <Play> doesn't sign media fetches). ─────────
export function ttsSign(text: string): string {
  const key = process.env.CLARA_TWILIO_AUTH_TOKEN?.trim() || "clara-tts";
  return crypto.createHmac("sha256", key).update(text).digest("hex").slice(0, 24);
}
export function ttsSigValid(text: string, sig: string | null): boolean {
  if (!sig) return false;
  const a = Buffer.from(ttsSign(text)), b = Buffer.from(sig);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ── ElevenLabs ───────────────────────────────────────────────────────────
export function elevenKey(): string | null {
  return process.env.ELEVENLABS_API_KEY?.trim() || null;
}
export function elevenVoiceId(): string {
  // The owner's chosen voice id — fallback to Rachel if unset (matches FRIDAY default).
  const v = process.env.CLARA_ELEVENLABS_VOICE_ID?.trim();
  const envOrDefault = v && /^[A-Za-z0-9]{16,}$/.test(v) ? v : "21m00Tcm4TlvDq8ikWAM";
  // A voice picked for CLARA in the OS (Settings → AI Agents) wins when it is set and available;
  // an org-wide default voice does not override the env choice (agentSettings.ts).
  return effectiveVoiceId(peekAgentSettings().root, envOrDefault);
}

const _ttsCache = new Map<string, Buffer>();
const TTS_CACHE_MAX = 80;

export async function elevenTTSAudio(text: string, opts: { telephony?: boolean; tone?: ToneContext; noCache?: boolean } = {}): Promise<{ buf?: Buffer; error?: string }> {
  const key = elevenKey();
  if (!key) return { error: "ElevenLabs not configured (set ELEVENLABS_API_KEY)" };
  const vid = elevenVoiceId();
  const fmt = opts.telephony ? "ulaw_8000" : "mp3_44100_128";
  const tone = opts.tone ?? "stranger";
  const tp = toneFor(tone);
  // OS voice_settings (stability / similarity_boost / style / use_speaker_boost) override the
  // per-audience tone where set; part of the cache key so a settings change is heard at once.
  const vo = voiceSettingOverrides(peekAgentSettings().root);
  const cacheKey = `${vid}:${fmt}:${tone}:${JSON.stringify(vo)}:${text}`;
  const hit = opts.noCache ? undefined : _ttsCache.get(cacheKey);
  if (hit) return { buf: hit };
  const token = ttsAttemptToken();
  let buf: Buffer;
  try {
    const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${vid}?output_format=${fmt}&optimize_streaming_latency=4`, {
      method: "POST",
      headers: { "xi-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify({
        text: text.slice(0, 2500),
        model_id: "eleven_flash_v2_5",
        voice_settings: {
          stability: vo.stability ?? tp.stability,
          similarity_boost: vo.similarity_boost ?? tp.similarity,
          style: vo.style ?? tp.style,
          use_speaker_boost: vo.use_speaker_boost ?? true,
        },
      }),
      // Twilio waits on this through our /tts route while the caller hears silence; a hung provider
      // is an outage like any other.
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) return ttsFailed(`ElevenLabs ${r.status}: ${(await r.text().catch(() => "")).slice(0, 160)}`);
    // Inside the try: the timeout can also fire while the audio body is still streaming.
    buf = Buffer.from(await r.arrayBuffer());
  } catch (e) {
    return ttsFailed(`ElevenLabs unreachable: ${String((e as Error)?.message ?? e).slice(0, 120)}`);
  }
  if (buf.length === 0) return ttsFailed("ElevenLabs returned empty audio");
  // Only a phone-format (μ-law) success restores <Play> on calls: an MP3 success for the desk or a
  // research digest says nothing about the format Twilio fetches. Any failure still marks it down.
  if (opts.telephony) markTtsSuccess(token);
  _ttsCache.set(cacheKey, buf);
  if (_ttsCache.size > TTS_CACHE_MAX) { const first = _ttsCache.keys().next().value; if (first) _ttsCache.delete(first); }
  return { buf };
}

/** Any provider failure marks it down (speak() switches to Polly) and emails the owner once per outage —
 *  timely email, never SMS: a missing voice is worth knowing about, not worth a page. */
function ttsFailed(error: string): { error: string } {
  const { newOutage } = markTtsFailure(error);
  if (newOutage) void ttsOutageNotifier(ttsOutageText(error)).catch(() => {});
  return { error };
}

let ttsOutageNotifier: (text: string) => Promise<unknown> = (text) =>
  import("./notify").then(({ notifyOwner }) => notifyOwner({
    kind: "voice.tts_unavailable",
    priority: "critical",
    text,
    dedupeKey: `tts-outage:${new Date().toISOString().slice(0, 13)}`,
  }));
/** Tests only: swap the outage email for a spy. */
export function _setTtsOutageNotifier(fn: (text: string) => Promise<unknown>): void {
  ttsOutageNotifier = fn;
}

export async function elevenTTSDataUrl(text: string, tone: ToneContext = "owner"): Promise<{ audio?: string; error?: string }> {
  const res = await elevenTTSAudio(text, { tone });
  if (res.buf) return { audio: `data:audio/mp3;base64,${res.buf.toString("base64")}` };
  return { error: res.error };
}
