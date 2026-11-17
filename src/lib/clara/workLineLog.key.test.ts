// recordWorkLine idempotency: a keyed entry is written once, and success is reported.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "clara-worklog-key-"));
process.env.CLARA_CONFIG = path.join(tmp, "clara.config.json");
await fs.writeFile(process.env.CLARA_CONFIG, JSON.stringify({ dataDir: tmp, vaultRoot: tmp }), "utf8");
process.env.CLARA_MEMORY_ROOT = path.join(tmp, "Memory");

const { recordWorkLine, readWorkLine } = await import("./workLineLog");

test("a keyed record is written once however often it is retried", async () => {
  const entry = { at: new Date().toISOString(), channel: "text" as const, from: "+18135550100", who: "Jackson", did: "left it for you", callback: true, key: "ask-expired:abc" };
  assert.equal(await recordWorkLine(entry), true);
  assert.equal(await recordWorkLine(entry), true);
  assert.equal((await readWorkLine(0)).filter((e) => e.key === "ask-expired:abc").length, 1);
});

test("concurrent records with the same key still write once", async () => {
  const entry = { at: new Date().toISOString(), channel: "text" as const, from: "+18135550199", who: "Kim", did: "left it", callback: true, key: "ask-expired:race" };
  const results = await Promise.all([recordWorkLine(entry), recordWorkLine(entry), recordWorkLine(entry)]);
  assert.deepEqual(results, [true, true, true]);
  assert.equal((await readWorkLine(0)).filter((e) => e.key === "ask-expired:race").length, 1);
});
