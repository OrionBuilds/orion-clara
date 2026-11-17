// Work line (workLine.ts): which calls are the forwarded work phone, who gets put through to the owner,
// and the press-1 whisper that keeps a transfer out of his voicemail.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isWorkLineCall, triageUrgency, urgencySignals, classifyCaller, whisperTwiml, whisperText, transferOutcomeFromDial,
  acceptedDigits, transferConnected, whoLabel,
} from "./workLine";

const ENV = { CLARA_WORKLINE_NUMBER: "+18135550199", OWNER_WORK_PHONE: "+16895550100" };

test("a call to the work-line number is the work line, however the number is formatted", () => {
  assert.equal(isWorkLineCall({ To: "+18135550199" }, ENV), true);
  assert.equal(isWorkLineCall({ To: "(813) 555-0199" }, ENV), true);
  assert.equal(isWorkLineCall({ To: "+18135550000" }, ENV), false);
});

test("a call forwarded from the work phone is the work line even on another number", () => {
  assert.equal(isWorkLineCall({ To: "+18135550000", ForwardedFrom: "6895550100" }, ENV), true);
  assert.equal(isWorkLineCall({ To: "+18135550000", ForwardedFrom: "+16895559999" }, ENV), false);
});

test("the work line is inert until configured", () => {
  assert.equal(isWorkLineCall({ To: "+18135550199", ForwardedFrom: "+16895550100" }, {}), false);
});

test("urgency signals read plain speech", () => {
  assert.deepEqual(urgencySignals("our site is down and we need it fixed today").sort(), ["broken", "deadline"]);
  assert.deepEqual(urgencySignals("the invoice was charged twice"), ["money"]);
  assert.deepEqual(urgencySignals("just wanted to say hi"), []);
});

test("a client with something broken today is urgent; a stranger with the same words is not", () => {
  const text = "the checkout is broken and we launch today";
  assert.equal(triageUrgency({ kind: "client", text }).urgent, true);
  assert.equal(triageUrgency({ kind: "unknown", text }).urgent, false);
  assert.equal(triageUrgency({ kind: "unknown", text: `emergency — ${text}` }).urgent, true);
});

test("a VIP asking for the owner gets through; a lead asking for the owner leaves a message", () => {
  assert.equal(triageUrgency({ kind: "vip", text: "can I speak to the owner" }).urgent, true);
  assert.equal(triageUrgency({ kind: "lead", text: "can I speak to the owner" }).urgent, false);
  assert.equal(triageUrgency({ kind: "vip", text: "hello", wantsOwner: true }).urgent, true);
});

test("vendors get through for outages, not routine billing", () => {
  assert.equal(triageUrgency({ kind: "vendor", text: "your server is offline" }).urgent, true);
  assert.equal(triageUrgency({ kind: "vendor", text: "about next month's invoice" }).urgent, false);
  assert.equal(triageUrgency({ kind: "vendor", text: "payment is overdue and due today" }).urgent, true);
});

test("classifyCaller: friends are personal, whitelist and vip contacts are VIP, OS stage decides client vs lead", () => {
  assert.equal(classifyCaller({ whitelisted: false, local: { name: "Dana", relation: "friend", vip: false } }).kind, "personal");
  assert.equal(classifyCaller({ whitelisted: true }).kind, "vip");
  assert.equal(classifyCaller({ whitelisted: false, local: { name: "Pat", relation: "vendor", vip: false } }).kind, "vendor");
  assert.equal(classifyCaller({ whitelisted: false, os: { name: "Jackson", company: "Acme Co", tags: ["client"] } }).kind, "client");
  assert.equal(classifyCaller({ whitelisted: false, os: { name: "Kim", tags: [], stage: "Closed Won" } }).kind, "client");
  const lead = classifyCaller({ whitelisted: false, os: { name: "Lee", company: "Acme", tags: ["scorecard"] } });
  assert.deepEqual(lead, { kind: "lead", name: "Lee", company: "Acme" });
  assert.equal(classifyCaller({ whitelisted: false }).kind, "unknown");
});

test("the whisper makes the owner press 1 and hangs up his leg otherwise", () => {
  const xml = whisperTwiml({ text: "x", speakXml: "<Say>Work call</Say>", acceptUrl: "https://c/accept?callSid=CA1&x=1" });
  assert.match(xml, /<Gather input="dtmf" numDigits="1" timeout="8" action="https:\/\/c\/accept\?callSid=CA1&amp;x=1" method="POST"><Say>Work call<\/Say><\/Gather><Hangup\/>/);
});

test("whisper text names the caller and the need", () => {
  const t = whisperText({ learned: { callerName: "Jackson", company: "Acme Co", need: "site is down" }, fromE164: "+18135550100", line: "work" });
  assert.equal(t, "Work call from Jackson from Acme Co. They need: site is down. Press 1 to take it.");
  assert.match(whisperText(null), /inbound caller/);
});

test("only a 1 accepts, and only an accepted dial counts as connected", () => {
  assert.equal(acceptedDigits("1"), true);
  assert.equal(acceptedDigits("2"), false);
  assert.equal(acceptedDigits(undefined), false);
  assert.equal(transferConnected("completed", true), true);
  assert.equal(transferConnected("completed", undefined), false); // voicemail picked up the bridge
  assert.equal(transferConnected("no-answer", true), false);
});

test("whoLabel prefers what the caller said, then what we knew, then the number", () => {
  assert.equal(whoLabel({ callerName: "Kim" }, { name: "Kimberly", company: "Acme" }, "+1"), "Kim (Acme)");
  assert.equal(whoLabel({}, undefined, "+18135550100"), "+18135550100");
});

test("an unaccepted dial is 'no-reply' when his phone picked up, 'no-answer' when it never did", () => {
  assert.equal(transferOutcomeFromDial("completed"), "no-reply");
  assert.equal(transferOutcomeFromDial("answered"), "no-reply");
  for (const s of ["no-answer", "busy", "failed", "canceled"]) assert.equal(transferOutcomeFromDial(s), "no-answer");
});
