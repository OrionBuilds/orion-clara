import { test } from "node:test";
import assert from "node:assert/strict";
import { buildLinkedinQueue, clampNote, fallbackDrafts, isQueueRunTime, parseDrafts, digestText, NOTE_MAX, MAX_LOOKUPS, type LinkedinQueueDeps, type QueueCompany, type QueueItem } from "./linkedinQueue";
import type { ProspectLookupResponse } from "@autom8ionlab/agent-core";

const budget = (searches: number, views: number) => ({ searches_used: 10 - searches, views_used: 25 - views, remaining_today: { searches, views } });
const hit = (n: number) => ({ full_name: `Owner ${n}`, title: "Owner", linkedin_url: `https://linkedin.com/in/owner-${n}`, confidence: 0.8, source_url: "x", observed_at: "t" });

function deps(companies: QueueCompany[], over: Partial<LinkedinQueueDeps> = {}): LinkedinQueueDeps & { sent: string[]; stored: QueueItem[] } {
  const d = {
    sent: [] as string[], stored: [] as QueueItem[],
    now: () => new Date(2026, 9, 7, 8, 0),
    promotedCompanies: async () => companies,
    peopleFor: async () => [],
    adsFor: async () => ["Google Ads"],
    lookup: async (c: QueueCompany): Promise<ProspectLookupResponse> => ({ ok: true, kind: "prospect.linkedin_lookup", people: [hit(Number(c.id))], budget: budget(5, 15), raw_excerpts: [], observed_at: "t" } as never),
    savePerson: async () => "p1",
    draft: async () => JSON.stringify({ connect_note: "Hi Owner, saw your 4.8 rating across 210 reviews in Tampa. Would love to connect.", follow_up_dm: "Thanks for connecting. How fast does your team get back to after-hours leads today? We build AI lead response that books jobs. Worth a look? example.com/schedule-consultation" }),
    alreadyQueued: async () => new Set<string>(),
    store: async (_d: string, items: QueueItem[]) => { d.stored = items; },
    deliver: async (_s: string, body: string) => { d.sent.push(body); return true; },
    ...over,
  };
  return d;
}
const co = (i: number, extra: Partial<QueueCompany> = {}): QueueCompany => ({ id: String(i), name: `Cool Air ${i}`, city: "Tampa", state: "FL", rating: 4.8, review_count: 210, industry: "HVAC", ...extra });

test("clampNote enforces LinkedIn's 300-char limit", () => {
  assert.ok(clampNote("word ".repeat(200)).length <= NOTE_MAX);
  assert.equal(clampNote("short note"), "short note");
});

test("fallback drafts fit the limit and never claim results", () => {
  const f = fallbackDrafts({ full_name: "Maria Lopez", linkedin_url: "u" }, co(1), ["4.8★ across 210 Google reviews"]);
  assert.ok(f.connect_note.length <= NOTE_MAX);
  assert.match(f.connect_note, /^Hi Maria/);
  assert.doesNotMatch(f.follow_up_dm + f.connect_note, /\d+%|\$\d/);
});

test("parseDrafts rejects junk and clamps the note", () => {
  assert.equal(parseDrafts("nope"), null);
  const p = parseDrafts(JSON.stringify({ connect_note: "x".repeat(400), follow_up_dm: "y".repeat(80) }));
  assert.ok(p && p.connect_note.length <= NOTE_MAX);
});

test("runs weekdays at 8 only", () => {
  assert.equal(isQueueRunTime(new Date(2026, 9, 7, 8, 15)), true); // Wed
  assert.equal(isQueueRunTime(new Date(2026, 9, 10, 8, 15)), false); // Sat
  assert.equal(isQueueRunTime(new Date(2026, 9, 7, 9, 0)), false);
});

test("active: looks up, drafts, emails one digest; stops at the lookup cap", async () => {
  const d = deps(Array.from({ length: 30 }, (_, i) => co(i + 1)));
  const r = await buildLinkedinQueue(d, "active");
  assert.equal(r.lookups, MAX_LOOKUPS);
  assert.equal(r.items.length, MAX_LOOKUPS);
  assert.equal(d.sent.length, 1);
  assert.match(d.sent[0], /nothing has been sent/);
  assert.ok(r.items.every((i) => i.connect_note.length <= NOTE_MAX));
});

test("stops looking up when FRIDAY's budget runs low or the guard refuses", async () => {
  const low = deps([co(1), co(2), co(3)], { lookup: async (c) => ({ ok: true, kind: "prospect.linkedin_lookup", people: [hit(Number(c.id))], budget: budget(0, 3), raw_excerpts: [], observed_at: "t" } as never) });
  assert.equal((await buildLinkedinQueue(low, "active")).lookups, 1);
  const refused = deps([co(1), co(2)], { lookup: async () => ({ ok: false, kind: "prospect.linkedin_lookup", error: "cap", refused: true }) });
  assert.equal((await buildLinkedinQueue(refused, "active")).lookups, 1);
});

test("shadow: no lookups, no digest; uses profiles already on file; skips roofers and repeats", async () => {
  const d = deps([co(1), co(2, { industry: "Roofing" }), co(3)], {
    peopleFor: async (id) => [{ full_name: `P ${id}`, linkedin_url: `u${id}` }],
    alreadyQueued: async () => new Set(["u3"]),
  });
  const r = await buildLinkedinQueue(d, "shadow");
  assert.equal(r.lookups, 0);
  assert.equal(d.sent.length, 0);
  assert.deepEqual(r.items.map((i) => i.linkedin_url), ["u1"]);
});

test("digest lists every person with note length", () => {
  const t = digestText([{ company_id: "1", company_name: "Cool Air", full_name: "Maria", linkedin_url: "u", connect_note: "hi", follow_up_dm: "dm", evidence: [] }], "2026-10-07", []);
  assert.match(t, /1\. Maria at Cool Air/);
  assert.match(t, /\(2\/300\)/);
});

test("linkedin_task step files a CRM task with the rendered note, never sends", async () => {
  const { processLinkedinStep } = await import("./sequenceRunner");
  const tasks: { title: string; description?: string }[] = [];
  const e = { contact_id: "c1", company_name: "Cool Air", person_name: "Maria Lopez", person_first_name: "Maria", template: { body: "Hi {{contact.first_name}}, saw {{company.name}}.", task_title: "LinkedIn connect: {{contact.first_name}}" } } as never;
  const deps = { createContactTask: async (a: { title: string; description?: string }) => { tasks.push(a); return { ok: true }; } } as never;
  assert.deepEqual(await processLinkedinStep(e, deps, "active"), { kind: "task_created" });
  assert.equal(tasks[0].title, "LinkedIn connect: Maria");
  assert.equal(tasks[0].description, "Hi Maria, saw Cool Air.");
  assert.equal((await processLinkedinStep(e, deps, "shadow")).kind, "skipped");
});
