// Tests for the cross-channel owner memory: the pure history builder and the owner-row filter.

import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildOwnerHistory, joinSeed } from "./ownerTurn";
import { filterOwnerRows, recentOwnerMessages, type StoredMessage } from "./messages";

const NOW = Date.parse("2026-09-24T18:00:00Z");
const row = (over: Partial<StoredMessage> & { role: StoredMessage["role"]; text: string; minsAgo: number }): StoredMessage => {
  const { minsAgo, ...rest } = over;
  return { id: crypto.randomUUID(), ts: new Date(NOW - minsAgo * 60_000).toISOString(), ...rest } as StoredMessage;
};

test("history is newest-last, drops anything older than 24h and any non-principal row", () => {
  const rows = [
    row({ role: "user", text: "old", minsAgo: 25 * 60, channel: "sms" }),
    row({ role: "user", text: "client said hi", minsAgo: 10, channel: "sms", principal: false }),
    row({ role: "user", text: "second", minsAgo: 5, channel: "web" }),
    row({ role: "clara", text: "reply two", minsAgo: 4 }),
    row({ role: "user", text: "first", minsAgo: 30, channel: "sms" }),
    row({ role: "clara", text: "reply one", minsAgo: 29, channel: "sms" }),
  ];
  const h = buildOwnerHistory(rows, NOW);
  assert.deepEqual(h.map((t) => t.role), ["user", "assistant", "user", "assistant"]);
  assert.match(h[0].content, /^\[sms \d\d:\d\d\] first$/);
  assert.match(h[2].content, /^\[web \d\d:\d\d\] second$/);
  assert.equal(h[1].content, "reply one");
  assert.ok(!h.some((t) => /client said hi|old/.test(t.content)));
});

test("tool turns collapse to what ran plus a short excerpt; assistant side never gets a prefix", () => {
  const long = "Done. " + "x".repeat(900);
  const rows = [
    row({ role: "user", text: "clear my inbox", minsAgo: 3, channel: "voice" }),
    row({ role: "clara", text: long, minsAgo: 2, channel: "voice", tools: ["sweep_inbox", "send_email!"] }),
  ];
  const h = buildOwnerHistory(rows, NOW);
  assert.equal(h[0].content.startsWith("[voice "), true);
  assert.equal(h[1].content.startsWith("(ran: sweep_inbox, send_email!) Done. "), true);
  assert.ok(h[1].content.length <= "(ran: sweep_inbox, send_email!) ".length + 300);
});

test("caps: at most maxTurns turns; over maxChars trims ground-truth blocks, then the oldest turns", () => {
  const rows: StoredMessage[] = [];
  for (let i = 0; i < 30; i++) {
    rows.push(row({ role: "user", text: `q${i}`, minsAgo: 60 - i * 2, channel: "sms" }));
    rows.push(row({ role: "clara", text: `a${i} headline\n\n${"detail ".repeat(120)}`, minsAgo: 59 - i * 2, channel: "sms" }));
  }
  const h = buildOwnerHistory(rows, NOW, { maxTurns: 20, maxChars: 6000 });
  assert.ok(h.length <= 20);
  assert.equal(h[0].role, "user");
  const chars = h.reduce((n, t) => n + t.content.length, 0);
  assert.ok(chars <= 6000, `${chars}`);
  assert.ok(h.filter((t) => t.role === "assistant").every((t) => !t.content.includes("detail detail")), "ground-truth blocks trimmed");
  assert.match(h[h.length - 1].content, /^a29 headline$/);
});

test("history always opens on a user turn", () => {
  const rows = [
    row({ role: "clara", text: "orphan assistant", minsAgo: 8 }),
    row({ role: "user", text: "hello", minsAgo: 7 }),
    row({ role: "clara", text: "hi", minsAgo: 6 }),
  ];
  const h = buildOwnerHistory(rows, NOW);
  assert.equal(h[0].role, "user");
  assert.equal(h.length, 2);
});

test("filterOwnerRows keeps principals across channels within the window, honours the limit", () => {
  const rows = [
    row({ role: "user", text: "a", minsAgo: 30 * 60, channel: "email" }),
    row({ role: "user", text: "b", minsAgo: 50, channel: "email" }),
    row({ role: "user", text: "c", minsAgo: 40, channel: "sms", principal: false }),
    row({ role: "user", text: "d", minsAgo: 30 }),
    row({ role: "clara", text: "e", minsAgo: 20, channel: "voice" }),
  ];
  assert.deepEqual(filterOwnerRows(rows, {}, NOW).map((m) => m.text), ["b", "d", "e"]);
  assert.deepEqual(filterOwnerRows(rows, { limit: 2 }, NOW).map((m) => m.text), ["d", "e"]);
  assert.deepEqual(filterOwnerRows(rows, { hours: 48 }, NOW).map((m) => m.text), ["a", "b", "d", "e"]);
});

test("recentOwnerMessages reads a messages.jsonl tail and skips malformed lines", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clara-msgs-"));
  const file = path.join(dir, "messages.jsonl");
  const lines = [
    JSON.stringify({ id: "1", ts: new Date().toISOString(), role: "user", text: "from sms", channel: "sms", from: "+15550001111" }),
    "{not json",
    JSON.stringify({ id: "2", ts: new Date().toISOString(), role: "user", text: "stranger", channel: "sms", principal: false }),
    JSON.stringify({ id: "3", ts: new Date().toISOString(), role: "clara", text: "from web" }),
  ];
  await fs.writeFile(file, lines.join("\n") + "\n", "utf8");
  const rows = await recentOwnerMessages({ file });
  assert.deepEqual(rows.map((m) => m.text), ["from sms", "from web"]);
  assert.deepEqual(await recentOwnerMessages({ file: path.join(dir, "missing.jsonl") }), []);
});

test("joinSeed never produces two assistant turns in a row", () => {
  const seed = [{ role: "user" as const, content: "(context) m" }, { role: "assistant" as const, content: "Understood — I'll use that." }];
  assert.deepEqual(joinSeed([], [{ role: "user", content: "hi" }]), [{ role: "user", content: "hi" }]);
  assert.deepEqual(joinSeed(seed, [{ role: "user", content: "hi" }]).map((t) => t.role), ["user", "assistant", "user"]);
  assert.deepEqual(joinSeed(seed, [{ role: "assistant", content: "earlier" }, { role: "user", content: "hi" }]).map((t) => t.role), ["user", "assistant", "user"]);
  assert.deepEqual(joinSeed(seed, []).map((t) => t.role), ["user", "assistant"]);
});

test("memory outcome keeps Clara's answer and drops the raw tool output appended after it", async () => {
  const { memoryOutcome } = await import("./ownerTurn");
  const tool = "Calendar (6):\n5o8m8lpisk_20260925T193000Z · 2026-09-25T00:00:00-04:00 · Out of office";
  const out = memoryOutcome(`Tomorrow you have a standup at 11:31.\n\n${tool}`, [{ resultLine: tool }]);
  assert.equal(out, "Tomorrow you have a standup at 11:31.");
});

test("memory outcome drops short tool result paragraphs too", async () => {
  const { memoryOutcome } = await import("./ownerTurn");
  assert.equal(memoryOutcome("Done — added it.\n\nTask added.", [{ resultLine: "Task added." }]), "Done — added it.");
  assert.equal(memoryOutcome("Nothing ran.", []), "Nothing ran.");
});

test("memory outcome keeps an answer that merely starts like a tool result", async () => {
  const { memoryOutcome } = await import("./ownerTurn");
  assert.equal(memoryOutcome("Task added. You can edit it later.\n\nTask added.", [{ resultLine: "Task added." }]), "Task added. You can edit it later.");
  const multi = "Calendar (2):\n\nA · 11:00\n\nB · 15:30";
  assert.equal(memoryOutcome(`Two meetings tomorrow.\n\n${multi}`, [{ resultLine: multi }]), "Two meetings tomorrow.");
});

test("memory outcome removes the longest matching tool result first", async () => {
  const { memoryOutcome } = await import("./ownerTurn");
  const short = "Event ID: 123";
  const long = "Calendar:\nEvent ID: 123";
  assert.equal(memoryOutcome(`Booked it.\n\n${long}`, [{ resultLine: short }, { resultLine: long }]), "Booked it.");
});
