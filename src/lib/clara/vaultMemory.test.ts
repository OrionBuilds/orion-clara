// Vault memory (contract v1): note format, append-only history with a rewritten "Where it stands",
// recall bounds and subject matching, and the delegation-transition write.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

process.env.CLARA_TZ = "America/New_York";
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "clara-mem-"));
process.env.CLARA_MEMORY_ROOT = tmp;

const { renderThreadNote, parseThread, renderIndex, scoreThread, localStamp, slugify, personSlug, recordOutcome, recallFor, memoryBlock, searchVaultMemory, delegationTransitionOutcome } = await import("./vaultMemory");

const AT1 = new Date("2026-09-25T13:05:00Z"); // 09:05 EDT
const AT2 = new Date("2026-09-25T18:30:00Z"); // 14:30 EDT

/** Each test that reads the Globex delegation seeds it itself, so tests run and fail independently. */
async function seedDelegation(): Promise<void> {
  const file = path.join(tmp, "threads", "delegation-abcdef12.md");
  if (await fs.stat(file).then(() => true, () => false)) return;
  await recordOutcome({ thread: "delegation-abcdef12", kind: "delegation", status: "open", title: "Handed to FRIDAY: fix the login page", subject: "Globex", done: "Queued as t1.", at: AT1 });
}

test("localStamp uses New York time", () => {
  assert.equal(localStamp(AT1), "2026-09-25 09:05");
});

test("personSlug keeps distinct people apart, including names that slugify to nothing", () => {
  assert.match(personSlug("Globex"), /^globex-[0-9a-f]{6}$/);
  assert.equal(personSlug("Globex"), personSlug("  globex "), "same person, same note");
  assert.notEqual(personSlug("José"), personSlug("Jose"));
  assert.notEqual(personSlug("王伟"), personSlug("李娜"));
});

test("slugify is filesystem-safe and bounded", () => {
  assert.equal(slugify("Globex: Q4 <budget> / plan!"), "globex-q4-budget-plan");
  assert.ok(slugify("a".repeat(200)).length <= 60);
});

test("thread note format: frontmatter, standing, history entry with omitted empty fields", () => {
  const md = renderThreadNote(null, { thread: "delegation-abc", kind: "delegation", title: "Handed to FRIDAY: fix login", subject: "Globex", status: "open", done: "Queued as t1.", next: "Wait." }, AT1);
  assert.match(md, /^---\nthread: "delegation-abc"\nkind: "delegation"\nsubject: "Globex"\nstatus: open\nupdated: 2026-09-25 09:05\nlinks: \[\]\n---\n# Handed to FRIDAY: fix login\n/);
  assert.match(md, /## Where it stands\n\*\*open\*\* — Next: Wait\./);
  assert.match(md, /### 2026-09-25 09:05 — delegation: Handed to FRIDAY: fix login\nWhat was done: Queued as t1\.\nNext: Wait\./);
  assert.doesNotMatch(md, /Outcome:|Left off:|Links:/);
});

test("second outcome appends history and rewrites standing without double status prefix", () => {
  const first = renderThreadNote(null, { thread: "t", kind: "delegation", title: "Handed to FRIDAY: fix login", status: "open", outcome: "Queued." }, AT1);
  const second = renderThreadNote(first, { thread: "t", kind: "delegation", title: "FRIDAY done: fix login", status: "done", outcome: "Login fixed and deployed.", links: [{ label: "PR", url: "https://github.com/x/y/pull/1" }] }, AT2);
  const p = parseThread(second);
  assert.equal(p.meta.status, "done");
  assert.equal(p.meta.title, "Handed to FRIDAY: fix login"); // title stays the thread's original
  assert.equal(p.standing, "**done** — Login fixed and deployed.");
  assert.equal((p.history.match(/^### /gm) ?? []).length, 2);
  assert.ok(p.history.indexOf("09:05") < p.history.indexOf("14:30"), "history is oldest-first, append-only");
  assert.deepEqual(p.meta.links, ["https://github.com/x/y/pull/1"]);
  // A status-only update keeps the previous standing text but not its old prefix.
  const third = renderThreadNote(second, { thread: "t", kind: "delegation", title: "closed", status: "closed" }, AT2);
  assert.equal(parseThread(third).standing, "**closed** — Login fixed and deployed.");
});

test("index lists open threads under Where things stand and keeps 30 recent events", () => {
  const recent = Array.from({ length: 40 }, (_, i) => ({ at: "2026-09-25 09:00", kind: "k", title: `e${i}`, thread: "t", status: "open" as const }));
  const md = renderIndex([
    { thread: "a", kind: "delegation", subject: "Globex", status: "open", updated: "2026-09-25 09:00", links: [], standing: "Waiting on FRIDAY", title: "Fix login" },
    { thread: "b", kind: "brief", subject: "", status: "done", updated: "2026-09-25 08:00", links: [], standing: "Sent", title: "Brief" },
  ], recent);
  const stand = md.match(/## Where things stand\n([\s\S]*?)\n## /)?.[1] ?? "";
  assert.match(stand, /\[\[threads\/a\|Fix login\]\]/);
  assert.doesNotMatch(stand, /Brief/);
  assert.equal((md.split("## Recent")[1].match(/^- /gm) ?? []).length, 30);
});

test("scoreThread matches on subject far above an unrelated thread", () => {
  const roof = { slug: "delegation-1", meta: { subject: "Globex", title: "Fix login", kind: "delegation" }, standing: "open", history: "" };
  const other = { slug: "brief-1", meta: { subject: "", title: "Morning brief", kind: "brief" }, standing: "done", history: "" };
  assert.ok(scoreThread(roof, "Globex") >= 3);
  assert.ok(scoreThread(other, "Globex") < 3);
});

test("store: delegation created then done transition writes one thread with both entries", async () => {
  const row = { id: "abcdef1234567890", bench: "friday", summary: "fix the login page", client: { name: "Globex" } };
  await recordOutcome({ thread: "delegation-abcdef12", kind: "delegation", status: "open", title: "Handed to FRIDAY: fix the login page", subject: "Globex", done: "Queued as t1.", at: AT1 });
  await recordOutcome({ ...delegationTransitionOutcome(row, "done", { clientText: "Login now works on mobile; live on main." }), at: AT2 });
  const note = await fs.readFile(path.join(tmp, "threads", "delegation-abcdef12.md"), "utf8");
  assert.match(note, /status: done/);
  assert.match(note, /### 2026-09-25 09:05 — delegation: Handed to FRIDAY/);
  assert.match(note, /### 2026-09-25 14:30 — delegation: FRIDAY done: fix the login page\nOutcome: Login now works on mobile; live on main\./);
  const person = await fs.readFile(path.join(tmp, "people", `${personSlug("Globex")}.md`), "utf8");
  assert.match(person, /\[\[threads\/delegation-abcdef12\|thread\]\]/);
  const index = await fs.readFile(path.join(tmp, "memory.md"), "utf8");
  assert.match(index, /## Recent/);
});

test("delegation transition outcomes carry left-off / next for non-done states", () => {
  const row = { id: "x".repeat(16), bench: "friday", summary: "ad copy" };
  const failed = delegationTransitionOutcome(row, "failed", { internal: "API 500" });
  assert.equal(failed.outcome, "API 500");
  assert.ok(failed.leftOff && failed.next);
  assert.match(delegationTransitionOutcome(row, "stale", {}).outcome ?? "", /6 hours/);
});

test("recall: subject match, bounds, kinds filter, fallback", async () => {
  await seedDelegation();
  await recordOutcome({ thread: "owner-2026-09-25-icp", kind: "owner-request", status: "done", title: "Update the ICP doc", outcome: "x".repeat(8000), at: AT2 });
  const bySubject = await recallFor({ subject: "Globex" });
  assert.match(bySubject, /fix the login page/);
  assert.doesNotMatch(bySubject, /Update the ICP doc/);
  const bounded = await recallFor({ query: "update the ICP doc", max: 500 });
  assert.ok(bounded.length <= 500, `len ${bounded.length}`);
  assert.ok((await recallFor({ query: "ICP doc update" })).length <= 5000);
  const onlyDeleg = await recallFor({ query: "update the ICP doc", kinds: ["delegation"], noFallback: true });
  assert.equal(onlyDeleg, "");
  assert.match(await memoryBlock({ subject: "Globex" }), /^What I already know/);
  assert.equal(await recallFor({ subject: "Nobody Inc", noFallback: true }), "");
});

test("keyword search over vault memory for the empty-index fallback", async () => {
  await seedDelegation();
  const hits = await searchVaultMemory("login page", 3);
  assert.ok(hits.length >= 1);
  assert.equal(hits[0].relPath, "Memory/threads/delegation-abcdef12.md");
  assert.match(hits[0].snippet, /^\[vault memory\]/);
});

test.after(async () => { await fs.rm(tmp, { recursive: true, force: true }); });
