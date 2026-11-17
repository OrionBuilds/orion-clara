// BlueBubbles relay (bluebubbles.ts): webhook payload parsing, what never gets a reply, the owner's own
// reply standing Clara down, her own echo not doing so, and the relay health step.
// Fixtures follow BlueBubbles Server's webhook body: { type, data: MessageSerializer output }.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseRelayEvent, ignoreReason, isShortCode, isVerificationCode, applyFromMe, noteMessage, standDownActive, addPendingSend, dropPendingSend, confirmedRejection, isPreSendFailure, mergeChatHistory,
  relayHealthStep, webhookSecretOk, sendBody, relayConfig, STAND_DOWN_MS, RELAY_DOWN_EMAIL_AFTER_MS, type RelayState,
  needsIntro, signAsClara, identifiesClara, CLARA_INTRO, CLARA_SIGN_OFF, RELAY_TEXT_MAX,
} from "./bluebubbles";

const oneToOne = {
  type: "new-message",
  data: {
    guid: "p:0/5E1C-1",
    text: "Hey, can the owner call me about the site today?",
    isFromMe: false,
    handle: { address: "+18135550100", service: "iMessage" },
    chats: [{ guid: "iMessage;-;+18135550100", style: 45, chatIdentifier: "+18135550100", displayName: "" }],
    dateCreated: 1790000000000,
    associatedMessageGuid: null,
    associatedMessageType: null,
    attachments: [],
    itemType: 0,
  },
};
const fromMe = {
  type: "new-message",
  data: { guid: "p:0/5E1C-2", text: "On it, calling you now", isFromMe: true, handle: null, chats: [{ guid: "iMessage;-;+18135550100", style: 45 }], dateCreated: 1790000060000 },
};
const group = {
  type: "new-message",
  data: { guid: "g1", text: "who's in for lunch", isFromMe: false, handle: { address: "+18135550100", service: "iMessage" }, chats: [{ guid: "iMessage;+;chat123456", style: 43 }] },
};
const tapback = {
  type: "new-message",
  data: { guid: "t1", text: "Loved “ok”", isFromMe: false, handle: { address: "+18135550100", service: "iMessage" }, chats: [{ guid: "iMessage;-;+18135550100", style: 45 }], associatedMessageGuid: "p:0/5E1C-1", associatedMessageType: 2000 },
};

test("a 1:1 new-message parses to the sender, chat and text", () => {
  const m = parseRelayEvent(oneToOne)!;
  assert.equal(m.address, "+18135550100");
  assert.equal(m.chatGuid, "iMessage;-;+18135550100");
  assert.equal(m.isGroup, false);
  assert.equal(m.isFromMe, false);
  assert.equal(m.service, "iMessage");
  assert.equal(m.at, 1790000000000);
  assert.equal(ignoreReason(m), null);
});

test("the owner's own send has no handle; the other party comes from the chat guid", () => {
  const m = parseRelayEvent(fromMe)!;
  assert.equal(m.isFromMe, true);
  assert.equal(m.address, "+18135550100");
});

test("other event types and junk are not messages", () => {
  assert.equal(parseRelayEvent({ type: "typing-indicator", data: {} }), null);
  assert.equal(parseRelayEvent({ type: "updated-message", data: oneToOne.data }), null);
  assert.equal(parseRelayEvent("nope"), null);
  assert.equal(parseRelayEvent(null), null);
});

test("group chats and tapbacks are never answered", () => {
  assert.equal(ignoreReason(parseRelayEvent(group)!), "group");
  assert.equal(ignoreReason(parseRelayEvent(tapback)!), "reaction");
});

test("short codes and alphanumeric senders are never answered; real numbers and Apple IDs are", () => {
  assert.equal(isShortCode("72975"), true);
  assert.equal(isShortCode("262966"), true);
  assert.equal(isShortCode("AMZN"), true);
  assert.equal(isShortCode("+18135550100"), false);
  assert.equal(isShortCode("jackson@globex.example"), false);
  const sc = parseRelayEvent({ ...oneToOne, data: { ...oneToOne.data, handle: { address: "72975", service: "SMS" } } })!;
  assert.equal(ignoreReason(sc), "short-code");
});

test("verification codes are never answered, even from a real number", () => {
  assert.equal(isVerificationCode("Your verification code is 482913"), true);
  assert.equal(isVerificationCode("482913 is your Chase login code. Do not share it."), true);
  assert.equal(isVerificationCode("G-554812 is your Google verification code."), true);
  assert.equal(isVerificationCode("Can we meet at 3 about the code review?"), false);
  const vc = parseRelayEvent({ ...oneToOne, data: { ...oneToOne.data, text: "Your login code: 123456" } })!;
  assert.equal(ignoreReason(vc), "verification-code");
});

test("the owner replying in a thread stands Clara down on it for 12 hours", () => {
  const now = 1_790_000_100_000;
  const { state, owner } = applyFromMe({ threads: {} }, parseRelayEvent(fromMe)!, now);
  assert.equal(owner, true);
  const t = state.threads["iMessage;-;+18135550100"];
  assert.equal(t.standDownUntil, now + STAND_DOWN_MS);
  assert.equal(standDownActive(t, now + STAND_DOWN_MS - 1), true);
  assert.equal(standDownActive(t, now + STAND_DOWN_MS), false);
});

test("Clara's own message echoing back does not stand her down — even before her send returns", () => {
  const now = 1_790_000_100_000;
  // Recorded as pending before the POST; the echo can arrive while it's still in flight.
  const s = addPendingSend({ threads: {} }, "iMessage;-;+18135550100", "On it, calling you now", now - 1000, "a");
  const r = applyFromMe(s, parseRelayEvent(fromMe)!, now);
  assert.equal(r.owner, false);
  assert.equal(r.state.threads["iMessage;-;+18135550100"].standDownUntil, undefined);
});

test("a rejected send is forgotten, so the owner later sending the same words still stands her down", () => {
  const now = 1_790_000_100_000;
  let s: RelayState = addPendingSend({ threads: {} }, "iMessage;-;+18135550100", "On it, calling you now", now - 1000, "a");
  s = dropPendingSend(s, "iMessage;-;+18135550100", "a");
  assert.equal(applyFromMe(s, parseRelayEvent(fromMe)!, now).owner, true);
});

test("dropping one pending send keeps an identical one sent in the same millisecond", () => {
  const now = 1_790_000_100_000;
  let s: RelayState = addPendingSend({ threads: {} }, "c", "same", now, "a");
  s = addPendingSend(s, "c", "same", now, "b");
  s = dropPendingSend(s, "c", "a");
  assert.deepEqual(s.threads.c.sent, [{ id: "b", text: "same", at: now }]);
});

test("only a definite refusal counts as not sent; timeouts, rate limits and 5xx are ambiguous", () => {
  assert.equal(confirmedRejection(400), true);
  assert.equal(confirmedRejection(401), true);
  assert.equal(confirmedRejection(408), false);
  assert.equal(confirmedRejection(429), false);
  assert.equal(confirmedRejection(500), false);
  assert.equal(confirmedRejection(504), false);
});

test("noteMessage records when Clara last wrote in the thread", () => {
  const s = noteMessage({ threads: {} }, "c", "clara", "hi", 1);
  assert.equal(s.threads.c.introduced, true);
  assert.equal(s.threads.c.lastClaraAt, 1);
  assert.equal(noteMessage({ threads: {} }, "c", "them", "hi", 1).threads.c.lastClaraAt, undefined);
});

test("every text names Clara: the introduction after a day's silence, a sign-off in between, never twice", () => {
  const H = 3_600_000;
  const now = 100 * H;
  // Never written here, or a state from before lastClaraAt existed → the introduction.
  assert.equal(needsIntro(undefined, now), true);
  assert.equal(needsIntro({ introduced: true }, now), true);
  assert.equal(needsIntro({ lastClaraAt: now - 25 * H }, now), true);
  assert.equal(needsIntro({ lastClaraAt: now - 23 * H }, now), false);
  // Old state with history but no lastClaraAt still counts her last message.
  assert.equal(needsIntro({ history: [{ from: "clara", text: "x", at: now - 2 * H }] }, now), false);

  assert.equal(signAsClara("Got it, he'll get back to you.", undefined, now), `${CLARA_INTRO}Got it, he'll get back to you.`);
  assert.equal(signAsClara("Got it, he'll get back to you.", { lastClaraAt: now - H }, now), "Got it, he'll get back to you. — Clara");
  assert.equal(signAsClara("Jordan says Thursday at 2 works.", { lastClaraAt: now - H }, now), "Jordan says Thursday at 2 works. — Clara");
  // Words that already say who she is are left alone, whichever way round.
  assert.equal(signAsClara("This is Clara, Jordan's assistant — understood.", undefined, now), "This is Clara, Jordan's assistant — understood.");
  assert.equal(signAsClara("Thanks — I'm Clara, Jordan's assistant. Let me check.", { lastClaraAt: now - H }, now), "Thanks — I'm Clara, Jordan's assistant. Let me check.");
  assert.equal(signAsClara("   ", undefined, now), "");
});

test("mentioning Clara in passing is not saying who's writing", () => {
  const H = 3_600_000;
  const now = 100 * H;
  assert.equal(identifiesClara("Jordan says the meeting with Clara is confirmed."), false);
  assert.equal(identifiesClara("Clara will send the invite."), false);
  assert.equal(identifiesClara("This is Clara, Jordan's assistant — understood."), true);
  assert.equal(identifiesClara("Thanks — I'm Clara, Jordan's assistant. Let me check."), true);
  assert.equal(identifiesClara("Got it. — Clara"), true);
  assert.equal(identifiesClara("Got it. — Clara, Jordan's assistant"), true);
  assert.equal(signAsClara("Jordan says the meeting with Clara is confirmed.", { lastClaraAt: now - H }, now), "Jordan says the meeting with Clara is confirmed. — Clara");
  assert.equal(signAsClara("Clara will send the invite.", undefined, now), `${CLARA_INTRO}Clara will send the invite.`);
});

test("a long reply is cut to make room for the sign-off, never the other way round", () => {
  const H = 3_600_000;
  const now = 100 * H;
  const long = "x".repeat(2_000);
  const signed = signAsClara(long, { lastClaraAt: now - H }, now);
  assert.equal(signed.length <= RELAY_TEXT_MAX, true);
  assert.ok(signed.endsWith(`…${CLARA_SIGN_OFF}`));
  const intro = signAsClara(long, undefined, now);
  assert.equal(intro.length <= RELAY_TEXT_MAX, true);
  assert.ok(intro.startsWith(CLARA_INTRO));
  assert.ok(intro.endsWith("…"));
  // Short text is untouched apart from the tag.
  assert.equal(signAsClara("ok", { lastClaraAt: now - H }, now), `ok${CLARA_SIGN_OFF}`);
});

test("relay health: one email after 15 minutes down, one when it recovers", () => {
  const t0 = 1_000_000;
  let step = relayHealthStep(undefined, false, t0);
  assert.equal(step.email, null);
  step = relayHealthStep(step.relay, false, t0 + RELAY_DOWN_EMAIL_AFTER_MS - 1);
  assert.equal(step.email, null);
  step = relayHealthStep(step.relay, false, t0 + RELAY_DOWN_EMAIL_AFTER_MS);
  assert.equal(step.email, "down");
  step = relayHealthStep(step.relay, false, t0 + 3 * RELAY_DOWN_EMAIL_AFTER_MS);
  assert.equal(step.email, null); // said once
  step = relayHealthStep(step.relay, true, t0 + 4 * RELAY_DOWN_EMAIL_AFTER_MS);
  assert.equal(step.email, "recovered");
  assert.equal(relayHealthStep(step.relay, true, t0 + 5 * RELAY_DOWN_EMAIL_AFTER_MS).email, null);
});

test("the webhook secret must match exactly and must be configured", () => {
  assert.equal(webhookSecretOk("s3cret-value", { BLUEBUBBLES_WEBHOOK_SECRET: "s3cret-value" }), true);
  assert.equal(webhookSecretOk("s3cret-valuX", { BLUEBUBBLES_WEBHOOK_SECRET: "s3cret-value" }), false);
  assert.equal(webhookSecretOk("short", { BLUEBUBBLES_WEBHOOK_SECRET: "s3cret-value" }), false);
  assert.equal(webhookSecretOk("", {}), false);
  assert.equal(webhookSecretOk("anything", {}), false);
});

test("sends go to the chat with a temp guid via AppleScript; config needs url and password", () => {
  assert.deepEqual(sendBody("iMessage;-;+18135550100", "Hi", "clara-1"), { chatGuid: "iMessage;-;+18135550100", tempGuid: "clara-1", message: "Hi", method: "apple-script" });
  assert.equal(relayConfig({ BLUEBUBBLES_URL: "http://10.0.0.5:1234/" }), null);
  assert.deepEqual(relayConfig({ BLUEBUBBLES_URL: "http://10.0.0.5:1234/", BLUEBUBBLES_PASSWORD: "pw" }), { url: "http://10.0.0.5:1234", password: "pw" });
});

test("texts from the work phone or Clara's own lines are never answered", () => {
  const env = { OWNER_WORK_PHONE: "+16895550100", CLARA_TWILIO_NUMBER: "+18135550000" };
  const fromClara = parseRelayEvent({ ...oneToOne, data: { ...oneToOne.data, handle: { address: "+18135550000", service: "SMS" } } })!;
  assert.equal(ignoreReason(fromClara, env), "self");
  assert.equal(ignoreReason(parseRelayEvent(oneToOne)!, env), null);
});

test("a connection that never reached the relay is a definite failure; a timeout is not", () => {
  const withCode = (code: string) => Object.assign(new TypeError("fetch failed"), { cause: { code } });
  assert.equal(isPreSendFailure(withCode("ECONNREFUSED")), true);
  assert.equal(isPreSendFailure(withCode("ENOTFOUND")), true);
  assert.equal(isPreSendFailure(withCode("ECONNRESET")), false);
  assert.equal(isPreSendFailure(new DOMException("The operation was aborted due to timeout", "TimeoutError")), false);
  assert.equal(isPreSendFailure("nope"), false);
});

test("mergeChatHistory: BB history is passed through; nothing to re-tag when local is absent", () => {
  const now = Date.now();
  const bb = [
    { from: "them" as const, text: "Hey", at: now - 60_000 },
    { from: "owner" as const, text: "Hi there", at: now - 50_000 },
  ];
  assert.deepEqual(mergeChatHistory(bb, undefined), bb);
  assert.deepEqual(mergeChatHistory(bb, []), bb);
});

test("mergeChatHistory: a BB isFromMe that matches a Clara send within the echo window is re-tagged to clara", () => {
  const now = Date.now();
  const bb = [
    { from: "them" as const, text: "Hey", at: now - 180_000 },
    // sent by Clara, bluebubbles reports it as isFromMe (= our fetchChatHistory flags as "owner")
    { from: "owner" as const, text: "Hi, this is Clara, Jordan's assistant. He'll call you back today.", at: now - 150_000 },
    // sent by the owner himself from the phone
    { from: "owner" as const, text: "On my way", at: now - 60_000 },
  ];
  const local = [
    { from: "them" as const, text: "Hey", at: now - 180_000 },
    { from: "clara" as const, text: "Hi, this is Clara, Jordan's assistant. He'll call you back today.", at: now - 150_500 },
  ];
  const merged = mergeChatHistory(bb, local);
  assert.equal(merged[1].from, "clara", "Clara's send is restored");
  assert.equal(merged[2].from, "owner", "the owner's own send stays the owner's");
  // Order preserved (oldest first).
  assert.equal(merged[0].text, "Hey");
  assert.equal(merged[2].text, "On my way");
});

test("mergeChatHistory: whitespace-only differences don't block the re-tag", () => {
  const now = Date.now();
  const bb = [{ from: "owner" as const, text: "Hi   there  ", at: now - 10_000 }];
  const local = [{ from: "clara" as const, text: "Hi there", at: now - 10_500 }];
  const [merged] = mergeChatHistory(bb, local);
  assert.equal(merged.from, "clara");
});

test("mergeChatHistory: a text match outside the echo window stays the owner's", () => {
  const now = Date.now();
  const bb = [{ from: "owner" as const, text: "On my way", at: now }];
  const local = [{ from: "clara" as const, text: "On my way", at: now - 24 * 3_600_000 }];
  assert.equal(mergeChatHistory(bb, local)[0].from, "owner");
});

test("mergeChatHistory: result is capped at `max`, keeping the newest entries", () => {
  const now = Date.now();
  const bb = Array.from({ length: 25 }, (_, i) => ({ from: "them" as const, text: `msg ${i}`, at: now - (25 - i) * 60_000 }));
  const merged = mergeChatHistory(bb, undefined, 10);
  assert.equal(merged.length, 10);
  assert.equal(merged[0].text, "msg 15");
  assert.equal(merged[9].text, "msg 24");
});
