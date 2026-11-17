// Clara — the owner's "always put through" list. 
//
// With the work phone forwarding every call to Clara (*72), a few key clients and partners must not
// have to explain themselves to reach the owner. Anyone on this list gets a short greeting and the warm
// transfer straight away — no questions, no triage. If the owner doesn't take it (press 1), the call comes
// back to Clara and she takes a message as usual.
//
// The owner controls it in plain words on any channel ("always put Taylor through, 813-555-0100",
// "take Mike off the put-through list") through the put_through_list tool. CLARA_PUT_THROUGH
// ("Name:+18135550100,Other:+1…") seeds it from env as well.
//
// Two tiers (2026-10-01, owner decision): "transfer" (default) gets the warm transfer described
// above, gated on the owner's calendar (workLine.ts/calendar.ts decide what happens when they're busy).
// "message_only" never rings the owner at all — Clara greets them by name and takes a message every
// time. A hardcoded seed (putThroughSeed.ts) ships the current list so a fresh deploy has it from
// day one; the owner can still add/demote people at runtime through the owner commands above, and a
// stored entry wins over a seeded one by NAME as well as by number, so the owner can demote a seeded VIP
// without needing to know which number they used to seed it.

import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { loadConfig } from "./config";
import { normalizeE164, samePhone } from "./ownerPhones";
import { PUT_THROUGH_SEED } from "./putThroughSeed";

export type PutThroughTier = "transfer" | "message_only";

export interface PutThroughEntry { name: string; phone: string; tier?: PutThroughTier }

/** Pure: the tier an entry is on — unset (old entries, env entries) defaults to "transfer". */
export function tierOf(entry: Pick<PutThroughEntry, "tier">): PutThroughTier {
  return entry.tier === "message_only" ? "message_only" : "transfer";
}

/** Pure: "Name:+1…,Other:+1…" → entries, dropping anything that isn't a dialable number. */
export function parsePutThroughEnv(raw: string | undefined): PutThroughEntry[] {
  return String(raw ?? "").split(",").flatMap((part) => {
    const i = part.lastIndexOf(":");
    const name = (i > 0 ? part.slice(0, i) : "").trim();
    const phone = normalizeE164(i > 0 ? part.slice(i + 1) : part);
    return phone ? [{ name: name || phone, phone }] : [];
  });
}

export function findPutThrough(list: PutThroughEntry[], from: string): PutThroughEntry | null {
  return list.find((e) => samePhone(e.phone, from)) ?? null;
}

/** Pure: add or replace by number. */
export function withEntry(list: PutThroughEntry[], entry: PutThroughEntry): PutThroughEntry[] {
  return [...list.filter((e) => !samePhone(e.phone, entry.phone)), entry];
}

/** Pure: remove by number or (case-insensitive) name. Returns the removed entries too. */
export function withoutEntry(list: PutThroughEntry[], who: string): { list: PutThroughEntry[]; removed: PutThroughEntry[] } {
  const q = who.trim().toLowerCase();
  const hit = (e: PutThroughEntry) => samePhone(e.phone, who) || e.name.toLowerCase() === q;
  return { list: list.filter((e) => !hit(e)), removed: list.filter(hit) };
}

/** True when two entries are "the same person" for merge purposes — same number, or same name. */
function sameEntry(a: PutThroughEntry, b: PutThroughEntry): boolean {
  return samePhone(a.phone, b.phone) || a.name.trim().toLowerCase() === b.name.trim().toLowerCase();
}

/**
 * Pure: fold `overrides` onto `base`, each override replacing any base entry that matches it by
 * number OR by name. Used to let a stored (owner-added) entry demote or replace a seeded one even
 * when the owner names it without quoting the exact seeded number.
 */
export function withOverrides(base: PutThroughEntry[], overrides: PutThroughEntry[]): PutThroughEntry[] {
  let list = base;
  for (const o of overrides) list = [...list.filter((e) => !sameEntry(e, o)), o];
  return list;
}

async function file(): Promise<string> {
  const cfg = await loadConfig();
  await fs.mkdir(cfg.dataDir, { recursive: true });
  return path.join(cfg.dataDir, "put-through.json");
}

async function readStored(): Promise<PutThroughEntry[]> {
  try { return JSON.parse(await fs.readFile(await file(), "utf8")) as PutThroughEntry[]; } catch { return []; }
}

async function writeStored(list: PutThroughEntry[]): Promise<void> {
  const f = await file();
  const tmp = `${f}.${randomUUID()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(list, null, 1), "utf8");
  await fs.rename(tmp, f);
}

// One change at a time: two channels editing the list together must not lose either change.
let chain: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn);
  chain = run.catch(() => {});
  return run;
}

/**
 * The whole list: the hardcoded seed, then the env seed, then what the owner has added — each layer
 * winning over the one before it on the same number. The stored (owner-added) layer also wins by
 * NAME, so the owner can demote or change a seeded VIP ("make Blake transfer again") without first
 * looking up which number seeded them.
 */
export async function putThroughList(): Promise<PutThroughEntry[]> {
  let list = withOverrides(PUT_THROUGH_SEED, parsePutThroughEnv(process.env.CLARA_PUT_THROUGH));
  list = withOverrides(list, await readStored());
  return list;
}

export async function putThroughFor(from: string): Promise<PutThroughEntry | null> {
  return findPutThrough(await putThroughList().catch(() => []), from);
}

export async function addPutThrough(name: string, phone: string): Promise<PutThroughEntry | null> {
  const p = normalizeE164(phone);
  if (!p) return null;
  const entry = { name: name.trim() || p, phone: p };
  await serial(async () => writeStored(withEntry(await readStored(), entry)));
  return entry;
}

/**
 * Removes from the owner's additions. Someone seeded by CLARA_PUT_THROUGH can only come off there — the
 * removal is refused (and nothing changes) rather than confirmed and silently re-added from env.
 */
export async function removePutThrough(who: string): Promise<{ removed: PutThroughEntry[]; seeded: PutThroughEntry[] }> {
  const seededAll = parsePutThroughEnv(process.env.CLARA_PUT_THROUGH);
  const seeded = withoutEntry(seededAll, who).removed;
  if (seeded.length) return { removed: [], seeded };
  return serial(async () => {
    const { list, removed } = withoutEntry(await readStored(), who);
    // Matched by a different label ("Jamie T" stored, "Jamie" seeded) — the number is what puts them
    // through, so a seeded number blocks the removal however it was named.
    const stillSeeded = seededAll.filter((e) => removed.some((r) => samePhone(r.phone, e.phone)));
    if (stillSeeded.length) return { removed: [], seeded: stillSeeded };
    if (removed.length) await writeStored(list);
    return { removed, seeded: [] };
  });
}
