// Text-to-accept hold transfer (holdTransfer.ts): the text the owner gets, what counts as his answer, the
// timeout and its grace, machine detection, the TwiML, and the effects with every side effect faked.

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "clara-hold-"));
process.env.CLARA_CONFIG = path.join(tmp, "clara.config.json");
await fs.writeFile(process.env.CLARA_CONFIG, JSON.stringify({ dataDir: tmp, vaultRoot: tmp }), "utf8");
process.env.OWNER_PERSONAL_PHONE = "+13525550100";
process.env.CLARA_WORKLINE_NUMBER = "+18135550200";
process.env.CLARA_TWILIO_NUMBER = "+18135550300";

const hold = await import("./holdTransfer");
const { OWNER_FIRST } = await import("./owner");
const { enqueue } = await import("./channels");

type Patch = Record<string, unknown>;
function fakeDeps(opts: { textOk?: boolean; ringOk?: boolean; redirectOk?: boolean } = {}) {
  const sent = { owner: [] as string[], rings: [] as string[], redirects: [] as string[], patches: [] as Patch[], log: [] as string[], timers: [] as Array<{ fn: () => void; ms: number }> };
  const deps: Partial<import("./holdTransfer").HoldDeps> = {
    textOwner: async (t) => { sent.owner.push(t); return opts.textOk ?? true; },
    ringOwner: async (h) => { sent.rings.push(h.callSid); return (opts.ringOk ?? true) ? { ok: true, sid: "CAowner" } : { ok: false, error: "carrier rejected" }; },
    redirect: async (_sid, url) => { sent.redirects.push(url); return (opts.redirectOk ?? true) ? { ok: true } : { ok: false, error: "Call is not in-progress" }; },
    patchSession: (_sid, p) => { sent.patches.push(p); },
    log: async (what) => { sent.log.push(what); },
    now: () => 1_000_000,
    setTimer: (fn, ms) => { sent.timers.push({ fn, ms }); return setTimeout(() => {}, 0); },
  };
  return { sent, deps };
}
const jackson = { callSid: "CA1", from: "+18135550100", who: "Jackson (Globex)", need: "delivery moved to Friday", vip: false, urgent: true, base: "https://clara.example.com" };

beforeEach(() => hold.resetHolds());

test("the text names the caller, the need, the two answers, the handle, and Clara", () => {
  const t = hold.holdText({ who: "Jackson (Globex)", need: "delivery moved to Friday", vip: false }, { urgent: true });
  assert.equal(t, "Work call holding: Jackson (Globex) — needs: delivery moved to Friday, says urgent. Reply 1 to take it, 2 to pass. (re: Jackson) — Clara");
  assert.equal(hold.holdText({ who: "Dana", vip: true }), "Work call holding: Dana (always put through). Reply 1 to take it, 2 to pass. (re: Dana) — Clara");
  assert.match(hold.holdText({ who: "+18135550100", vip: false }), /\(re: \+18135550100\)/);
});

test("only a clear 1/2 (or words that mean it) is an answer to the hold", () => {
  for (const t of ["1", " 1.", "one", "take it", "yes", "Y", "put him through"]) assert.equal(hold.parseHoldReply(t), "take", t);
  for (const t of ["2", "two", "pass", "no", "N", "not now", "take a message"]) assert.equal(hold.parseHoldReply(t), "pass", t);
  for (const t of ["what's on my calendar?", "tell Jackson Friday works", "1 sec", "12", ""]) assert.equal(hold.parseHoldReply(t), null, t);
});

test("the deadline, with a grace window for a reply that crosses it", () => {
  const h = { deadlineAt: 100_000 };
  assert.equal(hold.holdExpired(h, 99_000), false);
  assert.equal(hold.holdExpired(h, 101_000), true);
  assert.equal(hold.holdExpired(h, 101_000, hold.HOLD_REPLY_GRACE_MS), false);
  assert.equal(hold.holdExpired(h, 100_000 + hold.HOLD_REPLY_GRACE_MS + 1, hold.HOLD_REPLY_GRACE_MS), true);
  assert.equal(hold.holdTimeoutMs({}), 45_000);
  assert.equal(hold.holdTimeoutMs({ CLARA_HOLD_TIMEOUT_SEC: "60" }), 60_000);
  assert.equal(hold.holdTimeoutMs({ CLARA_HOLD_TIMEOUT_SEC: "5" }), 45_000);   // too short to read a text
});

test("machine detection: a person bridges, a machine hangs up, unknown asks for a key", () => {
  assert.equal(hold.classifyAnsweredBy("human"), "human");
  for (const m of ["machine_start", "machine_end_beep", "machine_end_silence", "fax"]) assert.equal(hold.classifyAnsweredBy(m), "machine", m);
  assert.equal(hold.classifyAnsweredBy("unknown"), "unknown");
  assert.equal(hold.classifyAnsweredBy(undefined), "unknown");
});

test("the TwiML: one queue per call, the wait and exit URLs, and the bridge from the owner's leg", () => {
  const xml = enqueue({ queueName: hold.queueNameFor("CA123"), waitUrl: "https://c/hold/wait?callSid=CA123", actionUrl: "https://c/hold/done?callSid=CA123", sayXml: "<Say>hi</Say>" });
  assert.match(xml, /^<Response><Say>hi<\/Say><Enqueue waitUrl="https:\/\/c\/hold\/wait\?callSid=CA123" waitUrlMethod="POST" action="https:\/\/c\/hold\/done\?callSid=CA123" method="POST">hold-CA123<\/Enqueue><\/Response>$/);
  const bridge = hold.ownerAnswerTwiml({ sayXml: "<Say>x</Say>", queueName: "hold-CA123", bridgedUrl: "https://c/b?callSid=CA123", actionUrl: "https://c/d?callSid=CA123" });
  assert.match(bridge, /<Dial action="https:\/\/c\/d\?callSid=CA123" method="POST"><Queue url="https:\/\/c\/b\?callSid=CA123" method="POST">hold-CA123<\/Queue><\/Dial>/);
  assert.equal(hold.waitTwiml("https://x/hold.mp3"), "<Response><Play>https://x/hold.mp3</Play></Response>");
  assert.equal(hold.leaveTwiml(), "<Response><Leave/></Response>");
  assert.equal(hold.ownerWhisperLine({ who: "Jackson (Globex)" }), "Connecting you to Jackson from Globex now.");
});

test("hold audio: the owner's URL, else his file through Clara, else Twilio's sample", () => {
  const base = "https://clara.example.com";
  assert.equal(hold.holdAudioUrl(base, { CLARA_HOLD_AUDIO_URL: "https://cdn/x.mp3" }, true), "https://cdn/x.mp3");
  assert.equal(hold.holdAudioUrl(base, {}, true), `${base}/api/channels/twilio/hold-audio`);
  assert.equal(hold.holdAudioUrl(base, { CLARA_HOLD_AUDIO_URL: "not a url" }, false), hold.TWILIO_DEFAULT_HOLD_MUSIC);
});

test("start: the owner's cell rings right away + heads-up text + timer armed, one hold at a time (ring-first 2026-10-02)", async () => {
  const { sent, deps } = fakeDeps();
  const r = await hold.startHold(jackson, { deps });
  // The ring is the primary action — nothing waits on a text that might be unseen.
  assert.deepEqual(sent.rings, ["CA1"]);
  assert.equal(hold.holdFor("CA1")?.state, "accepted");
  assert.deepEqual(r, { ok: true, queueName: "hold-CA1" });
  assert.equal(sent.owner.length, 1);
  assert.match(sent.owner[0], /^Work call holding: Jackson \(Globex\)/);
  assert.equal(sent.timers[0].ms, 45_000);
  assert.deepEqual(sent.patches[0], { transferTried: true });
  assert.equal(hold.liveHold()?.callSid, "CA1");
  // A second urgent caller while Jackson holds goes straight to the message path.
  assert.deepEqual(await hold.startHold({ ...jackson, callSid: "CA2" }, { deps }), { ok: false, reason: "busy" });
  assert.equal(sent.owner.length, 1);
});

test("start: nobody is parked when the owner's cell can't be rung (ring-failed is the critical hop now)", async () => {
  const noNumber = await hold.startHold(jackson, { deps: fakeDeps().deps, env: { CLARA_TWILIO_NUMBER: "+18135550300" } });
  assert.deepEqual(noNumber, { ok: false, reason: "no-number" });
  const { sent, deps } = fakeDeps({ ringOk: false });
  assert.deepEqual(await hold.startHold(jackson, { deps }), { ok: false, reason: "ring-failed" });
  assert.equal(hold.liveHold(), null);
  assert.equal(sent.timers.length, 0);
});

test("start: a text that fails is never fatal — it's a parallel heads-up, the ring is what commits", async () => {
  const { sent, deps } = fakeDeps({ textOk: false });
  const r = await hold.startHold(jackson, { deps });
  assert.deepEqual(r, { ok: true, queueName: "hold-CA1" });
  // Ring went in; text was attempted (fire-and-forget) but its failure didn't abort the hold.
  assert.deepEqual(sent.rings, ["CA1"]);
  assert.equal(hold.holdFor("CA1")?.state, "accepted");
});

test("human answer → confirm whisper (not auto-bridge); his leg failing brings the caller back", async () => {
  const { sent, deps } = fakeDeps();
  await hold.startHold(jackson, { deps });
  // Ring went straight through; state committed to accepted on startHold.
  assert.deepEqual(sent.rings, ["CA1"]);
  assert.equal(hold.holdFor("CA1")?.state, "accepted");
  // Human answer no longer auto-bridges — the owner has to press 1 on the whisper (owner rule 2026-10-02).
  assert.deepEqual(await hold.onOwnerAnswered("CA1", "human", deps), { action: "confirm" });
  assert.equal(hold.holdFor("CA1")?.state, "accepted", "state stays accepted until a digit decides");
  // A late text "1" while the whisper is up is informative only.
  assert.match((await hold.tryHandleHoldReply("1", { now: 1_010_000, deps })) ?? "", /Already ringing you/);
  // Simulate the whisper's "1" press via markBridged (the /hold/answer route does this).
  hold.markBridged("CA1", deps.patchSession!);
  assert.equal(hold.holdFor("CA1")?.state, "bridged");
  assert.deepEqual(sent.patches.at(-1), { transferAccepted: true, transferOutcome: "connected" });
  assert.equal(sent.redirects.length, 0);
  assert.equal(hold.liveHold(), null);

  // His leg ends without a bridge → caller comes back to Clara.
  hold.resetHolds();
  await hold.startHold(jackson, { deps });
  await hold.onOwnerLegEnded("CA1", "no-answer", deps);
  assert.equal(hold.holdFor("CA1")?.state, "returned");
  assert.match(sent.redirects.at(-1) ?? "", /\/api\/channels\/twilio\/voice\/hold\/return\?callSid=CA1&why=no-answer$/);
  assert.deepEqual(sent.patches.at(-1), { transferOutcome: "no-answer" });
  assert.match(sent.owner.at(-1) ?? "", /Couldn't reach your cell/);
});

test("whisper 2 (or any non-1 digit): declineOnWhisper marks it declined and brings the caller back", async () => {
  const { sent, deps } = fakeDeps();
  await hold.startHold(jackson, { deps });
  await hold.declineOnWhisper("CA1", deps);
  assert.equal(hold.holdFor("CA1")?.state, "returned");
  assert.match(sent.redirects.at(-1) ?? "", /why=declined$/);
  assert.deepEqual(sent.patches.at(-1), { transferOutcome: "declined" });
});

test("his voicemail never takes the call: the leg is hung up and the caller comes back", async () => {
  const { sent, deps } = fakeDeps();
  await hold.startHold(jackson, { deps });
  assert.deepEqual(await hold.onOwnerAnswered("CA1", "machine_end_beep", deps), { action: "hangup", why: "voicemail" });
  assert.equal(hold.holdFor("CA1")?.state, "returned");
  assert.match(sent.redirects.at(-1) ?? "", /why=voicemail$/);
  assert.match(sent.owner.at(-1) ?? "", /Your voicemail picked up/);
  // Unknown → still the digit-choice whisper (owner rule 2026-10-02 — human and unknown both confirm).
  hold.resetHolds();
  await hold.startHold(jackson, { deps });
  assert.deepEqual(await hold.onOwnerAnswered("CA1", "unknown", deps), { action: "confirm" });
  assert.equal(hold.holdFor("CA1")?.state, "accepted");
});

test("fallback text 2 (he hears the heads-up SMS, taps a reply) still declines like it used to", async () => {
  const { sent, deps } = fakeDeps();
  await hold.startHold(jackson, { deps });
  // State is "accepted" now (ring went in). A text "2" is a late pass — tryHandleHoldReply says so.
  assert.match((await hold.tryHandleHoldReply("pass", { now: 1_010_000, deps })) ?? "", /already ringing/);
});

test("no reply: the timer returns the caller even when the whisper never resolved", async () => {
  const { sent, deps } = fakeDeps();
  await hold.startHold(jackson, { deps });
  sent.timers[0].fn();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(hold.holdFor("CA1")?.state, "returned");
  assert.match(sent.redirects[0], /why=no-reply$/);
  assert.match(sent.owner.at(-1) ?? "", /didn't hear back in time/);
  assert.equal(await hold.tryHandleHoldReply("1", { now: 2_000_000, deps }), null);
});

test("the caller hanging up while holding tells the owner and cancels everything", async () => {
  const { sent, deps } = fakeDeps();
  await hold.startHold(jackson, { deps });
  await hold.onCallerLeft("CA1", deps);
  assert.equal(hold.holdFor("CA1")?.state, "caller-left");
  assert.deepEqual(sent.patches.at(-1), { transferOutcome: "caller-left" });
  assert.match(sent.owner.at(-1) ?? "", /hung up while holding/);
  assert.equal(hold.liveHold(), null);
  // A redirect that fails because the call is over is the same thing.
  hold.resetHolds();
  const gone = fakeDeps({ redirectOk: false });
  await hold.startHold(jackson, { deps: gone.deps });
  assert.equal(await hold.returnCaller("CA1", "declined", gone.deps), false);
  assert.deepEqual(gone.sent.patches.at(-1), { transferOutcome: "caller-left" });
});

test("a plain owner text while a hold is live is not an answer to it", async () => {
  const { deps } = fakeDeps();
  await hold.startHold(jackson, { deps });
  assert.equal(await hold.tryHandleHoldReply("what's on my calendar today?", { now: 1_010_000, deps }), null);
  // State is "accepted" immediately after startHold now — the ring has already gone out, waiting
  // for the whisper to confirm. A free-text message doesn't change that.
  assert.equal(hold.holdFor("CA1")?.state, "accepted");
});

test("a caller who left the queue on their own (the backstop) is recorded without a redirect", async () => {
  const { sent, deps } = fakeDeps();
  await hold.startHold(jackson, { deps });
  assert.equal(await hold.markReturned("CA1", "no-reply", deps), true);
  assert.equal(sent.redirects.length, 0);
  assert.equal(hold.holdFor("CA1")?.state, "returned");
  assert.deepEqual(sent.patches.at(-1), { transferOutcome: "no-reply" });
  assert.match(sent.owner.at(-1) ?? "", /didn't hear back in time/);
  // Settled once: the timer firing afterwards changes nothing and texts nothing more.
  const n = sent.owner.length;
  sent.timers[0].fn();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(sent.owner.length, n);
  assert.equal(await hold.markReturned("CA1", "declined", deps), false);
});
