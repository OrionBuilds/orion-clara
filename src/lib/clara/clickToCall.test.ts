// "Connect me to X" (clickToCall.ts): the caller ID the owner presents and the TwiML for their leg.

import { test } from "node:test";
import assert from "node:assert/strict";
import { connectCallerId, toE164, connectPromptTwiml, connectDialTwiml } from "./clickToCall";

test("caller ID is the real work number only once it's verified in Twilio", () => {
  const env = { OWNER_WORK_PHONE: "+16895550100", CLARA_WORKLINE_NUMBER: "+18135550199", CLARA_TWILIO_NUMBER: "+18135550000" };
  assert.equal(connectCallerId(env), "+18135550199");
  assert.equal(connectCallerId({ ...env, OWNER_WORK_PHONE_VERIFIED: "1" }), "+16895550100");
  assert.equal(connectCallerId({ CLARA_TWILIO_NUMBER: "+18135550000" }), "+18135550000");
});

test("toE164 turns US numbers into dialable form and refuses names", () => {
  assert.equal(toE164("813-555-0100"), "+18135550100");
  assert.equal(toE164("1 (813) 555 0100"), "+18135550100");
  assert.equal(toE164("+44 555 010 0100"), "+445550100100");
  assert.equal(toE164("Jackson"), null);
  assert.equal(toE164("555-0100"), null);
});

test("the owner's leg must press 1 before anyone is dialed", () => {
  const xml = connectPromptTwiml({ acceptUrl: "https://c/connect?to=%2B18135550100&step=accept", speakXml: "<Say>Press 1</Say>" });
  assert.equal(xml, `<Response><Gather input="dtmf" numDigits="1" timeout="8" action="https://c/connect?to=%2B18135550100&amp;step=accept" method="POST"><Say>Press 1</Say></Gather><Hangup/></Response>`);
  assert.doesNotMatch(xml, /<Dial/);
});

test("after the 1, they are dialed with the chosen caller ID", () => {
  const xml = connectDialTwiml({ number: "+18135550100", callerId: "+18135550199" });
  assert.equal(xml, `<Response><Dial timeout="30" callerId="+18135550199"><Number>+18135550100</Number></Dial></Response>`);
});

test("numbers with extensions or too few digits are not dialable", () => {
  assert.equal(toE164("813-555-0100 ext 123"), null);
  assert.equal(toE164("5550100"), null);
});
