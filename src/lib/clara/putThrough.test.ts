// The owner's always-put-through list (putThrough.ts).

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// config.ts fixes its file path at import time, so the isolated data dir is set before loading.
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "clara-pt-"));
process.env.CLARA_CONFIG = path.join(tmp, "clara.config.json");
await fs.writeFile(process.env.CLARA_CONFIG, JSON.stringify({ dataDir: tmp, vaultRoot: tmp }), "utf8");

const { parsePutThroughEnv, findPutThrough, withEntry, withoutEntry, removePutThrough, withOverrides, tierOf, putThroughList, putThroughFor } = await import("./putThrough");
const { PUT_THROUGH_SEED } = await import("./putThroughSeed");

test("the env seed parses names and numbers and drops junk", () => {
  assert.deepEqual(parsePutThroughEnv("Jamie:(813) 555-0111, Jackson:+18135550100, Bad:123, +18135550122"), [
    { name: "Jamie", phone: "+18135550111" },
    { name: "Jackson", phone: "+18135550100" },
    { name: "+18135550122", phone: "+18135550122" },
  ]);
  assert.deepEqual(parsePutThroughEnv(undefined), []);
});

test("callers match by complete number, not by suffix", () => {
  const list = [{ name: "Jamie", phone: "+18135550111" }];
  assert.equal(findPutThrough(list, "8135550111")?.name, "Jamie");
  assert.equal(findPutThrough(list, "+448135550111"), null);
  assert.equal(findPutThrough(list, "+18135550999"), null);
});

test("adding the same number replaces; removing works by name or number", () => {
  let list = withEntry([], { name: "Mike", phone: "+18135550100" });
  list = withEntry(list, { name: "Mike R", phone: "8135550100" });
  assert.deepEqual(list, [{ name: "Mike R", phone: "8135550100" }]);
  list = withEntry(list, { name: "Jamie", phone: "+18135550111" });
  const byName = withoutEntry(list, "jamie");
  assert.deepEqual(byName.removed.map((e) => e.name), ["Jamie"]);
  const byNumber = withoutEntry(list, "(813) 555-0100");
  assert.deepEqual(byNumber.list.map((e) => e.name), ["Jamie"]);
});

test("someone seeded from CLARA_PUT_THROUGH can't be 'removed' only to come back", async () => {
  const prev = process.env.CLARA_PUT_THROUGH;
  process.env.CLARA_PUT_THROUGH = "Jamie:+18135550111";
  try {
    const r = await removePutThrough("jamie");
    assert.deepEqual(r.removed, []);
    assert.deepEqual(r.seeded, [{ name: "Jamie", phone: "+18135550111" }]);
  } finally {
    if (prev === undefined) delete process.env.CLARA_PUT_THROUGH; else process.env.CLARA_PUT_THROUGH = prev;
  }
});

test("a stored entry whose number is seeded under another name can't be removed either", async () => {
  await fs.writeFile(path.join(tmp, "put-through.json"), JSON.stringify([{ name: "Jamie T", phone: "+18135550111" }]), "utf8");
  const prev = process.env.CLARA_PUT_THROUGH;
  process.env.CLARA_PUT_THROUGH = "Jamie:+18135550111";
  try {
    const r = await removePutThrough("jamie t");
    assert.deepEqual(r.removed, []);
    assert.deepEqual(r.seeded.map((e) => e.phone), ["+18135550111"]);
    assert.match(await fs.readFile(path.join(tmp, "put-through.json"), "utf8"), /Jamie T/);
  } finally {
    if (prev === undefined) delete process.env.CLARA_PUT_THROUGH; else process.env.CLARA_PUT_THROUGH = prev;
  }
});

test("an entry that isn't seeded is removed from the stored list", async () => {
  await fs.writeFile(path.join(tmp, "put-through.json"), JSON.stringify([{ name: "Mike", phone: "+18135550100" }]), "utf8");
  const r = await removePutThrough("Mike");
  assert.deepEqual(r.removed.map((e) => e.name), ["Mike"]);
  assert.equal(await fs.readFile(path.join(tmp, "put-through.json"), "utf8"), "[]");
});

// ── Tiers (2026-10-01) ──────────────────────────────────────────────────────────────────────────

test("an entry with no tier defaults to transfer — old entries stay backward compatible", () => {
  assert.equal(tierOf({ tier: undefined }), "transfer");
  assert.equal(tierOf({}), "transfer");
  assert.equal(tierOf({ tier: "transfer" }), "transfer");
  assert.equal(tierOf({ tier: "message_only" }), "message_only");
});

test("the env seed still parses with no tier field at all", () => {
  const [entry] = parsePutThroughEnv("Jackson:+18135550100");
  assert.equal(entry.tier, undefined);
  assert.equal(tierOf(entry), "transfer");
});

test("withOverrides replaces a base entry by phone OR by (case-insensitive) name", () => {
  const base = [{ name: "Casey Contractor (Initech)", phone: "+15550100105", tier: "message_only" as const }];
  // Same name, different number — still the same person as far as the merge is concerned.
  const byName = withOverrides(base, [{ name: "casey contractor (initech)", phone: "+15550100198", tier: "transfer" as const }]);
  assert.deepEqual(byName, [{ name: "casey contractor (initech)", phone: "+15550100198", tier: "transfer" }]);
  // Same number, different name — still replaces.
  const byPhone = withOverrides(base, [{ name: "Casey", phone: "+15550100105", tier: "transfer" as const }]);
  assert.deepEqual(byPhone, [{ name: "Casey", phone: "+15550100105", tier: "transfer" }]);
  // Neither matches — both entries survive.
  const neither = withOverrides(base, [{ name: "Someone Else", phone: "+15550100197" }]);
  assert.equal(neither.length, 2);
});

test("the seed ships 5 rows — 4 transfer, 1 message-only, Morgan on two numbers", () => {
  assert.equal(PUT_THROUGH_SEED.length, 5);
  assert.equal(PUT_THROUGH_SEED.filter((e) => tierOf(e) === "transfer").length, 4);
  assert.equal(PUT_THROUGH_SEED.filter((e) => tierOf(e) === "message_only").length, 1);
  const morgan = PUT_THROUGH_SEED.filter((e) => e.name.includes("Morgan Vendor"));
  assert.equal(morgan.length, 2);
  assert.deepEqual(morgan.map((e) => e.phone).sort(), ["+15550100103", "+15550100104"]);
  assert.ok(PUT_THROUGH_SEED.some((e) => e.name.includes("Casey Contractor") && tierOf(e) === "message_only"));
});

test("a fresh deploy (no env, no stored file) already has the seeded VIPs", async () => {
  const list = await putThroughList();
  assert.ok(list.some((e) => e.name.includes("Taylor Client")));
  const taylor = await putThroughFor("+15550100101");
  assert.equal(taylor?.name, "Taylor Client (Acme Co)");
  assert.equal(tierOf(taylor!), "transfer");
  const casey = await putThroughFor("+15550100105");
  assert.equal(tierOf(casey!), "message_only");
});

test("a stored entry demotes a seeded VIP by name, without needing the seeded number", async () => {
  await fs.writeFile(path.join(tmp, "put-through.json"), JSON.stringify([
    { name: "Taylor Client (Acme Co)", phone: "+15550100199", tier: "message_only" },
  ]), "utf8");
  const taylor = await putThroughFor("+15550100199");
  assert.equal(taylor?.name, "Taylor Client (Acme Co)");
  assert.equal(tierOf(taylor!), "message_only");
  // The old seeded number no longer matches them — the stored entry fully replaced it.
  assert.equal(await putThroughFor("+15550100101"), null);
});
