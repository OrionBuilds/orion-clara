// Pure pieces of the morning call: script chunking, end-phrase detection, the retry table, the
// voicemail line, the identity check and the call-day/time gates. The Twilio and model paths are
// exercised by the dry-run trigger (POST /api/brief/call {dry:true}), not here.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chunkScript, isEndPhrase, shouldRetry, voicemailText, identityOk, isCallDay, callTime, gatherTwiml, phoneKey,
} from "./owner-call";

test("chunkScript keeps sentences whole and every chunk within the limit", () => {
  const sentence = "This is a sentence about the day ahead. ";
  const text = sentence.repeat(60); // ~2400 chars
  const chunks = chunkScript(text, 700);
  assert.ok(chunks.length >= 4, `${chunks.length}`);
  for (const c of chunks) {
    assert.ok(c.length <= 700, `${c.length}`);
    assert.match(c, /\.$/); // ends on a sentence boundary
  }
  assert.equal(chunks.join(" ").replace(/\s+/g, " "), text.trim().replace(/\s+/g, " "));
});

test("chunkScript hard-cuts a single over-long sentence and strips emoji", () => {
  const long = "word ".repeat(300).trim(); // no punctuation, ~1500 chars
  const chunks = chunkScript(`☀️ ${long}`, 700);
  assert.ok(chunks.every((c) => c.length <= 700));
  assert.ok(chunks.every((c) => !/☀/.test(c)));
  assert.deepEqual(chunkScript("   ", 700), []);
});

test("end phrases are recognised, questions and tasks are not", () => {
  for (const s of ["That's all", "that's it, thanks", "nothing else", "No, I'm good", "ok that's all for now", "bye", "Thanks Clara", "all done", "Goodbye."]) {
    assert.equal(isEndPhrase(s), true, s);
  }
  for (const s of ["what's on my calendar", "remind me to call Marcus", "that's all wrong, redo it", "no, move it to Monday", "Thanks — also book the flight"]) {
    assert.equal(isEndPhrase(s), false, s);
  }
});

test("retry: once, only after an unanswered first attempt, only before 09:30", () => {
  const at = (h: number, m: number) => new Date(2026, 8, 24, h, m);
  assert.equal(shouldRetry({ attempt: 1, status: "no-answer", now: at(8, 31) }), true);
  assert.equal(shouldRetry({ attempt: 1, status: "busy", now: at(9, 0) }), true);
  assert.equal(shouldRetry({ attempt: 1, status: "no-answer", now: at(9, 30) }), false);
  assert.equal(shouldRetry({ attempt: 2, status: "no-answer", now: at(8, 45) }), false);
  assert.equal(shouldRetry({ attempt: 1, status: "completed", now: at(8, 45) }), false);
  assert.equal(shouldRetry({ attempt: 1, status: "voicemail", now: at(8, 45) }), false);
});

test("voicemail text carries the counts and points at the email", () => {
  const t = voicemailText({ meetings: 2, decisions: 1 });
  assert.match(t, /2 meetings today/);
  assert.match(t, /1 thing waiting on you/);
  assert.match(t, /in your email/);
  assert.match(voicemailText({ meetings: 1, decisions: 0 }), /1 meeting today, nothing waiting on you/);
});

test("identity: only an outbound call to the session's number passes; From is never consulted", () => {
  const session = { to: "+17275551234" };
  assert.equal(identityOk({ Direction: "outbound-api", To: "+17275551234" }, session), true);
  assert.equal(identityOk({ Direction: "outbound-api", To: "(727) 555-1234" }, session), true);
  assert.equal(identityOk({ Direction: "outbound-api", To: "+17275559999" }, session), false);
  assert.equal(identityOk({ Direction: "inbound", To: "+17275551234" }, session), false);
  assert.equal(identityOk({ To: "+17275551234" }, session), false);
  assert.equal(identityOk({ Direction: "outbound-api" }, session), false);
  assert.equal(phoneKey("+1 (727) 555-1234"), "7275551234");
});

test("call day and time gates", () => {
  const env = { CLARA_MORNING_CALL: "08:30", CLARA_MORNING_CALL_WEEKENDS: "off", CLARA_HOLIDAYS: "2026-11-26,2026-12-25" };
  assert.equal(isCallDay(new Date(2026, 8, 24, 8, 30), env), true);  // Thursday
  assert.equal(isCallDay(new Date(2026, 8, 26, 8, 30), env), false); // Saturday
  assert.equal(isCallDay(new Date(2026, 8, 26, 8, 30), { ...env, CLARA_MORNING_CALL_WEEKENDS: "on" }), true);
  assert.equal(isCallDay(new Date(2026, 10, 26, 8, 30), env), false); // Thanksgiving
  assert.deepEqual(callTime(env), { hour: 8, minute: 30 });
  assert.deepEqual(callTime({ CLARA_MORNING_CALL: "9:05" }), { hour: 9, minute: 5 });
  assert.equal(callTime({ CLARA_MORNING_CALL: "off" }), null);
  assert.deepEqual(callTime({ CLARA_MORNING_CALL: "nonsense" }), { hour: 8, minute: 30 });
});

test("gather TwiML: speech gather with barge-in, next-turn action and a silence redirect; never a Record", () => {
  const xml = gatherTwiml(["Good morning, Alex.", "What do you need from me?"], "https://clara.example", "abc-123", 3);
  assert.match(xml, /<Gather input="speech" speechTimeout="auto" timeout="6" action="https:\/\/clara\.example\/api\/channels\/twilio\/owner-call\?sid=abc-123&amp;t=3" method="POST">/);
  assert.match(xml, /<Redirect method="POST">https:\/\/clara\.example\/api\/channels\/twilio\/owner-call\?sid=abc-123&amp;t=3&amp;silence=1<\/Redirect>/);
  assert.doesNotMatch(xml, /<Record/);
  assert.ok((xml.match(/<Say|<Play/g) ?? []).length === 2);
});
