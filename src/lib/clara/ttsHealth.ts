// ElevenLabs health, so a failing voice provider never reaches a caller as a Twilio error.
//
// speak() emits <Play> of our signed /tts URL, and Twilio fetches it only when the call is already
// live. If ElevenLabs is failing (2026-09-29: a 401 payment_required) that fetch 502s and the
// caller hears Twilio's application-error message instead of Clara. So a failure anywhere
// (the /tts route, owner-call prewarm, research audio) marks the provider down for 15 minutes, and
// while it is down speak() uses Twilio's own Polly voice. When the window expires the next speak()
// kicks off ONE background probe and keeps using Polly until that probe succeeds — a caller never
// becomes the test of whether ElevenLabs is back.
//
// A fresh process starts UNVERIFIED: speak() uses Polly and kicks off a probe until one synth has
// succeeded, so a restart while ElevenLabs is down never hands the first caller an error.
//
// Each failure bumps a generation counter. A request captures the generation when it starts, and
// its success only clears the outage if no failure happened since — an older, slower request that
// happens to succeed can't reopen <Play> in the middle of a newer outage.
//
// State lives on globalThis because Next can load this module more than once per process (route
// bundles), and a flag split across copies would let one route keep emitting a dead <Play>.

export const TTS_DOWN_MS = 15 * 60_000;

interface TtsHealthState {
  verified: boolean;      // at least one synth has succeeded since the process started
  downUntil: number;      // 0 = not marked down
  reason: string;
  outageOpen: boolean;    // an outage email has been sent and the provider hasn't recovered since
  probing: boolean;
  gen: number;            // bumped on every failure
}

function fresh(): TtsHealthState {
  return { verified: false, downUntil: 0, reason: "", outageOpen: false, probing: false, gen: 0 };
}

const g = globalThis as unknown as { __claraTtsHealth?: TtsHealthState };
function state(): TtsHealthState {
  return (g.__claraTtsHealth ??= fresh());
}

/** Should speak() use ElevenLabs right now? Only once a synth has succeeded and nothing has failed
 *  since — false before the first check, while marked down, and after the window until a probe
 *  succeeds. */
export function ttsUsable(): boolean {
  const s = state();
  return s.verified && s.downUntil === 0;
}

/** True when a probe should run: never verified yet, or the down window has passed. */
export function ttsProbeDue(now = Date.now()): boolean {
  const s = state();
  if (s.probing) return false;
  if (!s.verified && s.downUntil === 0) return true;
  return s.downUntil !== 0 && now >= s.downUntil;
}

/** Capture before a synth request; pass to markTtsSuccess. */
export function ttsAttemptToken(): number {
  return state().gen;
}

export function ttsProbing(): boolean {
  return state().probing;
}

export function markTtsProbing(on: boolean): void {
  state().probing = on;
}

/** Record a failure. `newOutage` is true only for the first failure of an outage — that is the one
 *  that emails the owner. */
export function markTtsFailure(reason: string, now = Date.now()): { newOutage: boolean } {
  const s = state();
  const newOutage = !s.outageOpen;
  s.gen += 1;
  s.downUntil = now + TTS_DOWN_MS;
  s.reason = reason.slice(0, 200);
  s.outageOpen = true;
  return { newOutage };
}

/** Record a success. `recovered` is true when this ends an outage. A success from a request that
 *  started before the latest failure (stale token) is ignored. */
export function markTtsSuccess(token?: number): { recovered: boolean } {
  const s = state();
  if (token !== undefined && token !== s.gen) return { recovered: false };
  const recovered = s.outageOpen;
  s.verified = true;
  s.downUntil = 0;
  s.reason = "";
  s.outageOpen = false;
  return { recovered };
}

export function ttsHealthSnapshot(): { usable: boolean; verified: boolean; downUntil: number; reason: string } {
  const s = state();
  return { usable: s.verified && s.downUntil === 0, verified: s.verified, downUntil: s.downUntil, reason: s.reason };
}

/** Plain-English outage email text. */
export function ttsOutageText(reason: string): string {
  return `Clara's ElevenLabs voice is unavailable (${reason || "unknown error"}); she's using the standard voice on calls until it's fixed.`;
}

/** Tests only. */
export function _resetTtsHealth(): void {
  g.__claraTtsHealth = fresh();
}
