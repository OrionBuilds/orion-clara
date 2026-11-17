// The persisted owner-call session store: survives a fresh process (cache miss → file), turns append,
// finalize is claimed exactly once, todaysSession ignores dry runs and other days.

import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clara-owner-calls-"));
process.env.CLARA_OWNER_CALLS_DIR = dir;

const mod = await import("./owner-call-sessions");

test("create → persist → reload from disk when the cache is cold", async () => {
  const s = await mod.createOwnerSession({ date: "2026-09-24", purpose: "morning-brief", to: "+17275551234", script: ["hi"], briefSummary: "1 meeting", counts: { meetings: 1, emails: 0, decisions: 0 } });
  const raw = JSON.parse(await fs.readFile(path.join(dir, `${s.sessionId}.json`), "utf8"));
  assert.equal(raw.status, "placing");
  // Cold cache: drop the global map and read again.
  (globalThis as unknown as Record<string, unknown>)["__clara_owner_call_sessions__"] = new Map();
  const back = await mod.getOwnerSession(s.sessionId);
  assert.equal(back?.to, "+17275551234");
  assert.equal(await mod.getOwnerSession("not-a-real-id"), null);
});

test("turns append and count only user turns", async () => {
  const s = await mod.createOwnerSession({ date: "2026-09-24", purpose: "dry-run", to: "+17275551234", script: [], briefSummary: "", counts: { meetings: 0, emails: 0, decisions: 0 } });
  await mod.appendOwnerTurn(s.sessionId, { role: "user", text: "what's on today" });
  await mod.appendOwnerTurn(s.sessionId, { role: "clara", text: "two meetings" });
  const back = await mod.getOwnerSession(s.sessionId);
  assert.equal(back?.turns.length, 2);
  assert.equal(back?.turnCount, 1);
});

test("finalize is claimed exactly once", async () => {
  const s = await mod.createOwnerSession({ date: "2026-09-24", purpose: "dry-run", to: "+17275551234", script: [], briefSummary: "", counts: { meetings: 0, emails: 0, decisions: 0 } });
  const first = await mod.claimOwnerFinalize(s.sessionId, "completed");
  const second = await mod.claimOwnerFinalize(s.sessionId, "status callback");
  assert.ok(first);
  assert.equal(second, null);
  assert.equal((await mod.getOwnerSession(s.sessionId))?.endReason, "completed");
});

test("todaysSession returns the newest real session for the date and ignores dry runs", async () => {
  const a = await mod.createOwnerSession({ date: "2026-09-25", purpose: "morning-brief", to: "+17275551234", script: [], briefSummary: "", counts: { meetings: 0, emails: 0, decisions: 0 } });
  await new Promise((r) => setTimeout(r, 5));
  await mod.createOwnerSession({ date: "2026-09-25", purpose: "dry-run", to: "+17275551234", script: [], briefSummary: "", counts: { meetings: 0, emails: 0, decisions: 0 } });
  const t = await mod.todaysSession("2026-09-25");
  assert.equal(t?.sessionId, a.sessionId);
  assert.equal(await mod.todaysSession("2026-01-01"), null);
});
