// "How would you like me to respond?" (workTextAsk.ts): one ask per thread, handles when several
// are open, the owner's answer relayed in his words, "I'll handle it" closing quietly, quiet hours,
// the reminder and expiry, a failed relay reported back, and ordinary owner texts left alone.

import { test, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "clara-workask-"));
process.env.CLARA_CONFIG = path.join(tmp, "clara.config.json");
await fs.writeFile(process.env.CLARA_CONFIG, JSON.stringify({ dataDir: tmp, vaultRoot: tmp }), "utf8");
process.env.CLARA_MEMORY_ROOT = path.join(tmp, "Memory");

// The module drops closed asks older than a week by the wall clock, and these tests use fixed
// September dates: pin "now" to that week so they don't rot as real time moves on.
mock.timers.enable({ apis: ["Date"], now: Date.UTC(2026, 8, 28, 15) });

const ask = await import("./workTextAsk");
const { OWNER_FIRST } = await import("./owner");

// Mon 2026-09-28, America/New_York (EDT, UTC-4).
const et = (day: number, h: number, m = 0) => Date.UTC(2026, 8, day, h + 4, m);

type Sent = { owner: string[]; relayed: Array<{ chatGuid: string; text: string }>; logged: Array<{ did: string; callback: boolean; resolved?: boolean }> };
function fakeDeps(opts: { relayOk?: boolean; recordOk?: boolean } = {}): { sent: Sent; deps: Partial<import("./workTextAsk").AskDeps> } {
  const sent: Sent = { owner: [], relayed: [], logged: [] };
  return {
    sent,
    deps: {
      textOwner: async (t) => { sent.owner.push(t); return true; },
      relay: async (chatGuid, text) => {
        sent.relayed.push({ chatGuid, text });
        return opts.relayOk === false ? { ok: false, error: "relay send 400: chat not found" } : { ok: true };
      },
      record: async (_a, did, o) => { sent.logged.push({ did, callback: o.callback, resolved: o.resolved }); return opts.recordOk !== false; },
    },
  };
}

async function reset() {
  await fs.rm(path.join(tmp, "workline-asks.json"), { force: true });
}

test("one ask per thread: a second text is appended, not asked again", () => {
  const base: import("./workTextAsk").AskState = { asks: [] };
  const a = ask.upsertAsk(base, { chatGuid: "c1", address: "+18135550100", who: "Jackson (Acme Co)", text: "what would a new page cost?", urgent: false, now: 1, id: "a1" });
  assert.equal(a.isNew, true);
  assert.equal(a.ask.handle, "Jackson");
  const b = ask.upsertAsk(a.state, { chatGuid: "c1", address: "+18135550100", who: "Jackson (Acme Co)", text: "also need it by Friday", urgent: true, now: 2, id: "a2" });
  assert.equal(b.isNew, false);
  assert.equal(b.state.asks.length, 1);
  assert.deepEqual(b.ask.texts, ["what would a new page cost?", "also need it by Friday"]);
  assert.equal(b.ask.urgent, true);
});

test("with others waiting, the ask says how to point the answer", () => {
  const a: import("./workTextAsk").WorkAsk = { id: "x", handle: "Maria", chatGuid: "c", address: "+1", who: "Maria", texts: ["is Friday ok?"], urgent: false, createdAt: 1, status: "open" };
  assert.match(ask.askText(a, { othersOpen: 1 }), /\(re: Maria — 1 other is waiting too, so start with "Maria:" to answer this one\.\)$/);
});

test("handles are first names, else the last four digits, and unique among open asks", () => {
  assert.equal(ask.makeHandle("Jackson (Acme Co)", "+18135550100", []), "Jackson");
  assert.equal(ask.makeHandle("+18135550100", "+18135550100", []), "0100");
  assert.equal(ask.makeHandle("Jackson Smith", "+18135550111", ["Jackson"]), "Jackson2");
});

test("a named reply picks that ask; a plain reply goes to the one he was asked about last", () => {
  const now = et(28, 10);
  const s: import("./workTextAsk").AskState = {
    asks: [
      { id: "j", handle: "Jackson", chatGuid: "cj", address: "+1", who: "Jackson", texts: ["x"], urgent: false, createdAt: now - 60_000, askedAt: now - 60_000, status: "open" },
      { id: "m", handle: "Maria", chatGuid: "cm", address: "+2", who: "Maria", texts: ["y"], urgent: false, createdAt: now - 30_000, askedAt: now - 30_000, status: "open" },
    ],
    lastPrompt: { id: "m", at: now - 30_000 },
  };
  assert.equal(ask.pickAsk(s, "Jackson: yes, Thursday works", now)?.ask.id, "j");
  assert.equal(ask.pickAsk(s, "Jackson: yes, Thursday works", now)?.body, "yes, Thursday works");
  assert.equal(ask.pickAsk(s, "re Jackson - no", now)?.ask.id, "j");
  const told = ask.pickAsk(s, "tell Jackson the site is back up", now);
  assert.equal(told?.ask.id, "j");
  assert.equal(told?.body, "tell them the site is back up");
  const plain = ask.pickAsk(s, "sounds good, see you then", now);
  assert.equal(plain?.ask.id, "m");
  assert.equal(plain?.named, false);
  assert.equal(ask.pickAsk(s, "sounds good", now + ask.PLAIN_REPLY_WINDOW_MS + 1), null);
});

test("\"I'll handle it\" and \"ignore\" close without sending; anything else is relayed", () => {
  for (const t of ["I'll handle it", "ill handle it.", "I'll call him", "ignore", "leave it", "don't reply"]) assert.equal(ask.classifyOwnerReply(t), "handle", t);
  for (const t of ["tell him yes", "Thursday 2pm works", "no, not this week"]) assert.equal(ask.classifyOwnerReply(t), "relay", t);
});

test("his words in her voice, with times, prices and yes/no kept exactly", () => {
  assert.equal(ask.relayWording("tell him yes, Thursday 2pm works"), `${OWNER_FIRST} says yes, Thursday 2pm works.`);
  const price = ask.relayWording("let them know the price is $1,250 and I'll send the invoice Friday");
  assert.match(price, /\$1,250/);
  assert.match(price, /they'll send the invoice Friday\.$/);
  assert.doesNotMatch(price, /\bI'll\b/);
  assert.equal(ask.relayWording("No, not until October 3."), `${OWNER_FIRST} says no, not until October 3.`);
  assert.equal(ask.relayWording("tell them"), "");
});

test("quiet hours hold an ask until 7am unless it's urgent", () => {
  const held: import("./workTextAsk").WorkAsk = { id: "q", handle: "Q", chatGuid: "c", address: "+1", who: "Q", texts: ["t"], urgent: false, createdAt: et(28, 23), status: "open" };
  assert.equal(ask.dueAction(held, et(28, 23, 30)), null);
  assert.equal(ask.dueAction({ ...held, urgent: true }, et(28, 23, 30)), "ask");
  assert.equal(ask.dueAction(held, et(29, 7, 5)), "ask");
});

test("one reminder after 4 business hours, expiry after 24 hours", () => {
  const a: import("./workTextAsk").WorkAsk = { id: "r", handle: "R", chatGuid: "c", address: "+1", who: "R", texts: ["t"], urgent: false, createdAt: et(28, 9), askedAt: et(28, 9), status: "open" };
  assert.equal(ask.dueAction(a, et(28, 12, 55)), null);
  assert.equal(ask.dueAction(a, et(28, 13, 5)), "remind");
  assert.equal(ask.dueAction({ ...a, remindedAt: et(28, 13, 5) }, et(28, 17)), null);
  // Friday 4pm ask: the weekend doesn't count toward the four business hours...
  const fri = { ...a, createdAt: Date.UTC(2026, 9, 2, 20), askedAt: Date.UTC(2026, 9, 2, 20) };
  assert.equal(ask.businessMsBetween(fri.askedAt!, Date.UTC(2026, 9, 3, 18)), 2 * 3_600_000);
  // ...but expiry is wall-clock.
  assert.equal(ask.dueAction(fri, fri.askedAt! + ask.EXPIRE_AFTER_MS), "expire");
});

test("end to end: the owner is asked, his answer is relayed from the work number, he gets a one-line confirmation", async () => {
  await reset();
  const { sent, deps } = fakeDeps();
  const r = await ask.askOwnerAbout({ chatGuid: "chat-j", address: "+18135550100", who: "Jackson (Acme Co)", text: "How much to add a gallery page?", urgent: false }, { now: et(28, 10), deps });
  assert.equal(r, "asked");
  assert.equal(sent.owner.length, 1);
  assert.match(sent.owner[0], /^Jackson \(Acme Co\) texted your work phone: "How much to add a gallery page\?"\. How would you like me to respond\?/);
  assert.match(sent.owner[0], /\(re: Jackson\)$/);

  // More from the same person while it's open: appended, the owner isn't texted again.
  assert.equal(await ask.askOwnerAbout({ chatGuid: "chat-j", address: "+18135550100", who: "Jackson (Acme Co)", text: "no rush", urgent: false }, { now: et(28, 10, 5), deps }), "appended");
  assert.equal(sent.owner.length, 1);

  const reply = await ask.tryHandleWorkAskReply("tell him $400, and I can start Monday", { now: et(28, 10, 20), deps });
  assert.equal(sent.relayed.length, 1);
  assert.equal(sent.relayed[0].chatGuid, "chat-j");
  assert.equal(sent.relayed[0].text, `${OWNER_FIRST} says $400, and they can start Monday.`);
  assert.equal(reply, `Sent to Jackson: "${OWNER_FIRST} says $400, and they can start Monday."`);
  assert.equal(sent.logged.at(-1)?.resolved, true);
  assert.equal((await ask.readAsks()).asks[0].status, "relayed");
  // Closed: the next plain text from the owner is his own business again.
  assert.equal(await ask.tryHandleWorkAskReply("ok thanks", { now: et(28, 10, 25), deps }), null);
});

test("\"I'll handle it\" closes the ask and sends them nothing", async () => {
  await reset();
  const { sent, deps } = fakeDeps();
  await ask.askOwnerAbout({ chatGuid: "chat-k", address: "+18135550122", who: "+18135550122", text: "call me back re the contract", urgent: false }, { now: et(28, 11), deps });
  const reply = await ask.tryHandleWorkAskReply("I'll handle it", { now: et(28, 11, 10), deps });
  assert.match(reply ?? "", /leave 0122 to you/);
  assert.equal(sent.relayed.length, 0);
  assert.equal((await ask.readAsks()).asks[0].status, "handled");
});

test("a failed relay is reported to the owner and the ask stays open", async () => {
  await reset();
  const { sent, deps } = fakeDeps({ relayOk: false });
  await ask.askOwnerAbout({ chatGuid: "chat-f", address: "+18135550133", who: "Dana", text: "can we move Thursday?", urgent: false }, { now: et(28, 14), deps });
  const reply = await ask.tryHandleWorkAskReply("yes, Friday 10am", { now: et(28, 14, 5), deps });
  assert.match(reply ?? "", /didn't go through to Dana/);
  assert.equal(sent.relayed.length, 1);
  assert.equal((await ask.readAsks()).asks[0].status, "open");
});

test("the owner's ordinary texts still go to the owner path while an ask is open", async () => {
  await reset();
  const { sent, deps } = fakeDeps();
  await ask.askOwnerAbout({ chatGuid: "chat-o", address: "+18135550144", who: "Omar", text: "what's the invoice total?", urgent: false }, { now: et(28, 15), deps });
  assert.equal(await ask.tryHandleWorkAskReply("what's on my calendar tomorrow?", { now: et(28, 15, 5), deps }), null);
  assert.equal(await ask.tryHandleWorkAskReply("Clara, clear my inbox", { now: et(28, 15, 5), deps }), null);
  // A decision asked after the work-text question owns the plain reply; a named one still lands here.
  assert.equal(await ask.tryHandleWorkAskReply("yes", { now: et(28, 15, 6), deps, lastDecisionAskAt: et(28, 15, 3) }), null);
  assert.match(await ask.tryHandleWorkAskReply("Omar: it's $2,100", { now: et(28, 15, 7), deps, lastDecisionAskAt: et(28, 15, 3) }) ?? "", /^Sent to Omar/);
  assert.equal(sent.relayed[0].text, `${OWNER_FIRST} says it's $2,100.`);
  // No ask open at all: nothing is intercepted.
  await reset();
  assert.equal(await ask.tryHandleWorkAskReply("yes", { now: et(28, 16), deps }), null);
});

test("the tick sends held asks at 7am, reminds once, then expires to the callback list", async () => {
  await reset();
  const { sent, deps } = fakeDeps();
  assert.equal(await ask.askOwnerAbout({ chatGuid: "chat-n", address: "+18135550155", who: "Nia", text: "can you confirm tomorrow?", urgent: false }, { now: et(28, 22), deps }), "held");
  assert.equal(sent.owner.length, 0);
  assert.equal(await ask.workAskTick({ now: et(28, 23), deps }), "nothing due");
  assert.equal(await ask.workAskTick({ now: et(29, 7, 4), deps }), "ask Nia");
  assert.equal(sent.owner.length, 1);
  assert.equal(await ask.workAskTick({ now: et(29, 13, 10), deps }), "remind Nia");
  assert.match(sent.owner[1], /^Still need your answer for Nia/);
  assert.equal(await ask.workAskTick({ now: et(29, 15), deps }), "nothing due");
  assert.equal(await ask.workAskTick({ now: et(30, 7, 5), deps }), "expired Nia");
  assert.equal(sent.logged.at(-1)?.callback, true);
  assert.equal((await ask.readAsks()).asks[0].status, "expired");
});

test("two callers racing to send the same ask text the owner once", async () => {
  await reset();
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const texts: string[] = [];
  const deps = { textOwner: async (t: string) => { texts.push(t); await gate; return true; } };
  assert.equal(await ask.askOwnerAbout({ chatGuid: "chat-r", address: "+18135550166", who: "Rae", text: "call me?", urgent: false }, { now: et(28, 22), deps }), "held");
  const a = ask.workAskTick({ now: et(29, 7, 4), deps });
  const b = ask.workAskTick({ now: et(29, 7, 4), deps });
  await new Promise((r) => setTimeout(r, 50));
  release();
  await Promise.all([a, b]);
  assert.equal(texts.length, 1);
});

test("an expiry whose callback line didn't save is retried, and never recorded twice", async () => {
  await reset();
  const failing = fakeDeps({ recordOk: false });
  await ask.askOwnerAbout({ chatGuid: "chat-e", address: "+18135550177", who: "Eve", text: "ping", urgent: false }, { now: et(28, 10), deps: failing.deps });
  assert.match(await ask.workAskTick({ now: et(29, 10, 5), deps: failing.deps }), /not recorded/);
  assert.equal((await ask.readAsks()).asks[0].status, "open");
  const ok = fakeDeps();
  assert.equal(await ask.workAskTick({ now: et(29, 10, 10), deps: ok.deps }), "expired Eve");
  assert.equal((await ask.readAsks()).asks[0].status, "expired");
});
