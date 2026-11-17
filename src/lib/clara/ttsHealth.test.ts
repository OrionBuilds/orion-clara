// ElevenLabs failover (2026-09-29): a failing voice provider must never reach a caller as Twilio's
// error message. speak() falls back to Polly while the provider is marked down, probes it in the
// background after 15 minutes, and emails the owner once per outage.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { TTS_DOWN_MS, ttsUsable, ttsProbeDue, markTtsFailure, markTtsSuccess, ttsOutageText, ttsAttemptToken, _resetTtsHealth } from "./ttsHealth";
import { speak, elevenTTSAudio, probeElevenLabs, startRecordingTwiml, FALLBACK_VOICE, _setTtsOutageNotifier } from "./channels";

const realFetch = globalThis.fetch;
const realKey = process.env.ELEVENLABS_API_KEY;
let emails: string[] = [];

beforeEach(() => {
  _resetTtsHealth();
  emails = [];
  _setTtsOutageNotifier(async (t) => { emails.push(t); });
  process.env.ELEVENLABS_API_KEY = "test-key";
});
afterEach(() => {
  globalThis.fetch = realFetch;
  if (realKey === undefined) delete process.env.ELEVENLABS_API_KEY; else process.env.ELEVENLABS_API_KEY = realKey;
});

function fakeFetch(status: number, body = "x"): void {
  globalThis.fetch = (async () => new Response(status === 200 ? new Uint8Array([1, 2, 3]) : body, { status })) as typeof fetch;
}

test("a fresh process uses Polly until one synth succeeds, and probes straight away", async () => {
  assert.equal(ttsUsable(), false);
  assert.equal(ttsProbeDue(), true);
  fakeFetch(200);
  assert.match(speak("Hello", "https://c.example"), /^<Say /);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(ttsUsable(), true, "the background probe verified the voice");
  assert.match(speak("Hello", "https://c.example"), /^<Play>/);
});

test("a fresh process that finds ElevenLabs down stays on Polly and emails", async () => {
  fakeFetch(401);
  assert.match(speak("Hello", "https://c.example"), /^<Say /);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(ttsUsable(), false);
  assert.equal(emails.length, 1);
});

test("healthy ElevenLabs: speak() plays Clara's voice", () => {
  markTtsSuccess();
  assert.match(speak("Hello", "https://c.example"), /^<Play>https:\/\/c\.example\/api\/channels\/twilio\/tts\?/);
});

test("no key: speak() uses Twilio's voice", () => {
  delete process.env.ELEVENLABS_API_KEY;
  assert.equal(speak("Hello", "https://c.example"), `<Say voice="${FALLBACK_VOICE}">Hello</Say>`);
});

test("a 401 payment failure marks the voice down, emails once, and speak() switches to Polly", async () => {
  fakeFetch(401, '{"detail":{"type":"payment_required"}}');
  const res = await elevenTTSAudio("one", { telephony: true, noCache: true });
  assert.ok(res.error?.startsWith("ElevenLabs 401"));
  assert.equal(ttsUsable(), false);
  assert.match(speak("Hello", "https://c.example"), /^<Say voice="Polly\.Joanna-Neural">Hello<\/Say>$/);
  await elevenTTSAudio("two", { telephony: true, noCache: true });
  await new Promise((r) => setImmediate(r));
  assert.equal(emails.length, 1, "one email per outage, not per failure");
  assert.match(emails[0], /ElevenLabs voice is unavailable \(ElevenLabs 401/);
});

test("a network error or timeout counts as an outage too", async () => {
  globalThis.fetch = (async () => { throw new Error("The operation was aborted due to timeout"); }) as typeof fetch;
  const res = await elevenTTSAudio("x", { noCache: true });
  assert.match(res.error ?? "", /unreachable/);
  assert.equal(ttsUsable(), false);
});

test("the voice stays on Polly for 15 minutes, then a background probe restores it", async () => {
  markTtsFailure("ElevenLabs 401", Date.now() - TTS_DOWN_MS - 1);
  assert.equal(ttsProbeDue(), true);
  fakeFetch(200);
  // The call that notices the window has passed still gets Polly — the probe runs in the background.
  assert.match(speak("Hi", "https://c.example"), /^<Say /);
  await probeElevenLabs();
  assert.equal(ttsUsable(), true);
  assert.match(speak("Hi", "https://c.example"), /^<Play>/);
});

test("a failed probe keeps Polly for another window and does not email again", async () => {
  markTtsFailure("ElevenLabs 401", Date.now() - TTS_DOWN_MS - 1);
  fakeFetch(401);
  assert.equal(await probeElevenLabs(), false);
  assert.equal(ttsUsable(), false);
  assert.equal(ttsProbeDue(), false);
  assert.equal(emails.length, 0);
});

test("recovery closes the outage, so the next failure emails again", () => {
  assert.equal(markTtsFailure("a").newOutage, true);
  assert.equal(markTtsFailure("b").newOutage, false);
  assert.equal(markTtsSuccess().recovered, true);
  assert.equal(markTtsFailure("c").newOutage, true);
});

test("outage email wording", () => {
  assert.equal(ttsOutageText("ElevenLabs 401: payment"), "Clara's ElevenLabs voice is unavailable (ElevenLabs 401: payment); she's using the standard voice on calls until it's fixed.");
});

test("call recording uses <Start><Recording>, which Twilio's schema accepts", () => {
  assert.equal(
    startRecordingTwiml("https://c.example"),
    '<Start><Recording recordingStatusCallback="https://c.example/api/channels/twilio/recording" recordingStatusCallbackEvent="completed"/></Start>',
  );
  for (const f of ["voice/route.ts", "screen/route.ts", "call/route.ts", "business-call/route.ts"]) {
    const src = readFileSync(new URL(`../../app/api/channels/twilio/${f}`, import.meta.url), "utf8");
    assert.doesNotMatch(src, /<Start><Record /, f);
  }
});

test("204 responses carry no body (a body throws 'Invalid response status code 204')", () => {
  assert.equal(new Response(null, { status: 204 }).status, 204);
  assert.throws(() => new Response("", { status: 204 }));
  const src = readFileSync(new URL("../../app/api/channels/twilio/voice/status/route.ts", import.meta.url), "utf8");
  assert.doesNotMatch(src, /new Response\("[^"]*",\s*\{\s*status:\s*204/);
  assert.equal((src.match(/new Response\(null, \{ status: 204 \}\)/g) ?? []).length, 3);
});

test("the 15-minute voice check catches an outage and a recovery without a caller", async () => {
  const { voiceHealthTick } = await import("./channels");
  markTtsSuccess();
  fakeFetch(401);
  assert.equal(await voiceHealthTick(), "down");
  assert.equal(await voiceHealthTick(), "down (waiting)");
  markTtsFailure("ElevenLabs 401", Date.now() - TTS_DOWN_MS - 1);
  fakeFetch(200);
  assert.equal(await voiceHealthTick(), "ok");
  assert.equal(ttsUsable(), true);
  delete process.env.ELEVENLABS_API_KEY;
  assert.equal(await voiceHealthTick(), "not configured");
});

test("an older request's success can't close a newer outage", () => {
  markTtsSuccess();
  const older = ttsAttemptToken();
  markTtsFailure("ElevenLabs 500");
  assert.equal(markTtsSuccess(older).recovered, false);
  assert.equal(ttsUsable(), false);
  assert.equal(markTtsSuccess(ttsAttemptToken()).recovered, true);
  assert.equal(ttsUsable(), true);
});

test("a stall while the audio body streams is an outage, not an unhandled rejection", async () => {
  markTtsSuccess();
  globalThis.fetch = (async () => ({ ok: true, status: 200, arrayBuffer: async () => { throw new Error("The operation was aborted due to timeout"); }, text: async () => "" })) as unknown as typeof fetch;
  const res = await elevenTTSAudio("x", { noCache: true });
  assert.match(res.error ?? "", /unreachable/);
  assert.equal(ttsUsable(), false);
});

test("an empty 200 body is a failure, not a success", async () => {
  markTtsSuccess();
  globalThis.fetch = (async () => new Response(new Uint8Array(0), { status: 200 })) as typeof fetch;
  const res = await elevenTTSAudio("x", { telephony: true, noCache: true });
  assert.equal(res.error, "ElevenLabs returned empty audio");
  assert.equal(ttsUsable(), false);
});

test("an MP3 success doesn't restore phone playback; a μ-law success does", async () => {
  markTtsFailure("ElevenLabs 500");
  fakeFetch(200);
  await elevenTTSAudio("desk", { noCache: true });
  assert.equal(ttsUsable(), false);
  await elevenTTSAudio("phone", { telephony: true, noCache: true });
  assert.equal(ttsUsable(), true);
});
