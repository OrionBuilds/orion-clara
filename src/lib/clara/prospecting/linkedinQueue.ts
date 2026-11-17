// linkedinQueue.ts — the weekday LinkedIn queue (semi-manual; drafts only, NOTHING is sent).
//
// Each weekday morning: take promoted companies (highest fit first), find an owner/decision-maker
// with a LinkedIn profile (already on file, else one FRIDAY Agent-Reach lookup), draft a connection
// note (≤300 chars, LinkedIn's hard limit) and a follow-up DM grounded in the company's own facts,
// and email the owner one digest. The owner sends by hand from their own account. Clara never calls LinkedIn's
// connect/message tools.
//
// Caps: FRIDAY's Agent-Reach budget is 10 searches + 25 profile views a day, shared with FRIDAY's
// own work. One lookup = 1 search + ≤2 views, so this job uses at most 10 lookups (≤20 views) and
// stops the moment the returned budget says there isn't room for another full lookup, or the guard
// refuses/locks/needs a login.
//
// Gate: CLARA_LINKEDIN_QUEUE=off|shadow|active (default shadow). shadow builds the queue from
// profiles already on file and writes it locally, but makes no LinkedIn lookups and sends no digest.

import { promises as fs } from "node:fs";
import path from "node:path";
import type { ProspectLookupResponse } from "@autom8ionlab/agent-core";
import { BOOKING_URL, BUSINESS_NAME, BUSINESS_PITCH, OWNER_NAME } from "./branding";

export type LinkedinQueueMode = "off" | "shadow" | "active";
export function linkedinQueueMode(env: NodeJS.ProcessEnv = process.env): LinkedinQueueMode {
  const v = (env.CLARA_LINKEDIN_QUEUE ?? "shadow").trim().toLowerCase();
  return v === "off" || v === "active" ? v : "shadow";
}

export const NOTE_MAX = 300;
export const DAILY_TARGET = 20;
export const DAILY_MIN = 15;
export const MAX_LOOKUPS = 10;
const PROFILES_PER_LOOKUP = 2;
const DECISION_TITLES = ["Owner", "Founder", "President", "CEO", "General Manager", "Managing Partner", "Principal", "Operations Manager"];

export interface QueueCompany {
  id: string;
  name: string;
  city?: string;
  state?: string;
  website_url?: string;
  industry?: string;
  rating?: number;
  review_count?: number;
  fit_score?: number;
}
export interface QueuePerson { id?: string; full_name: string; title?: string; linkedin_url: string }
export interface QueueItem {
  company_id: string;
  company_name: string;
  person_id?: string;
  full_name: string;
  title?: string;
  linkedin_url: string;
  connect_note: string;
  follow_up_dm: string;
  evidence: string[];
}
export interface QueueResult {
  mode: LinkedinQueueMode;
  date: string;
  items: QueueItem[];
  lookups: number;
  delivered: boolean;
  notes: string[];
}

// ── Pure helpers ───────────────────────────────────────────────────────────────────────────────

/** 08:00–08:59 local, Monday–Friday. */
export function isQueueRunTime(now: Date): boolean {
  const d = now.getDay();
  return d >= 1 && d <= 5 && now.getHours() === 8;
}

export const firstName = (full: string) => full.trim().split(/\s+/)[0] ?? full;

/** Hard-clamps to LinkedIn's 300-char connection-note limit on a word boundary. */
export function clampNote(text: string, max = NOTE_MAX): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const sp = cut.lastIndexOf(" ");
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[,;:\-–—\s]+$/, "") + "…";
}

/** Facts we can say out loud — only what's on the company record, nothing inferred. */
export function evidenceFor(c: QueueCompany, ads: string[]): string[] {
  const ev: string[] = [];
  if (typeof c.rating === "number" && typeof c.review_count === "number" && c.review_count > 0) ev.push(`${c.rating.toFixed(1)}★ across ${c.review_count} Google reviews`);
  if (c.city) ev.push(`based in ${c.city}${c.state ? `, ${c.state}` : ""}`);
  for (const a of ads) ev.push(`running ${a}`);
  return ev;
}

/** Template drafts used when the model is unavailable or returns something unusable. */
export function fallbackDrafts(p: QueuePerson, c: QueueCompany, evidence: string[]): { connect_note: string; follow_up_dm: string } {
  const hook = evidence[0] ? ` — ${evidence[0]} is impressive` : "";
  const connect_note = clampNote(`Hi ${firstName(p.full_name)}, I came across ${c.name}${hook}. I run ${BUSINESS_NAME}, building ${BUSINESS_PITCH}. Would be glad to connect.`);
  const follow_up_dm = `Thanks for connecting, ${firstName(p.full_name)}. Quick question: when a call or web lead comes in after hours at ${c.name}, how fast does someone get back to them? We build AI that answers and follows up in seconds, books the job, and hands it to your team, plus the ads and follow-up systems around it. If it's worth a look, here's a 30-minute slot: ${BOOKING_URL}`;
  return { connect_note, follow_up_dm };
}

export function draftPrompt(p: QueuePerson, c: QueueCompany, evidence: string[]): string {
  return [
    `Write two LinkedIn messages from ${OWNER_NAME}, founder of ${BUSINESS_NAME}, to ${p.full_name}${p.title ? ` (${p.title})` : ""} at ${c.name}${c.industry ? `, a ${c.industry} business` : ""}.`,
    `What ${BUSINESS_NAME} does for businesses like theirs: ${BUSINESS_PITCH}.`,
    `Facts you may use (use at most one, and nothing else about them): ${evidence.length ? evidence.join("; ") : "none"}.`,
    `Rules: never invent results, clients, numbers or facts; no hype; plain and human; no emojis; no links in the connection note.`,
    `1) connect_note: ≤ 280 characters, friendly, mentions one fact if given, no pitch beyond one clause.`,
    `2) follow_up_dm: 60–110 words, asks one question about how fast they respond to new leads, one sentence on what we build, ends with an easy ask and this link: ${BOOKING_URL}`,
    `Reply with ONLY strict JSON: {"connect_note": "...", "follow_up_dm": "..."}`,
  ].join("\n");
}

export function parseDrafts(text: string | undefined): { connect_note: string; follow_up_dm: string } | null {
  if (!text) return null;
  try {
    const m = text.match(/\{[\s\S]*\}/);
    const j = JSON.parse(m ? m[0] : text) as { connect_note?: unknown; follow_up_dm?: unknown };
    if (typeof j.connect_note !== "string" || typeof j.follow_up_dm !== "string") return null;
    if (j.connect_note.trim().length < 20 || j.follow_up_dm.trim().length < 40) return null;
    return { connect_note: clampNote(j.connect_note), follow_up_dm: j.follow_up_dm.trim() };
  } catch {
    return null;
  }
}

export function digestText(items: QueueItem[], date: string, notes: string[]): string {
  const lines = [
    `LinkedIn queue for ${date}: ${items.length} people. Send from your own LinkedIn; nothing has been sent.`,
    `Connect today with the note; send the DM a day or two after they accept.`,
    "",
  ];
  items.forEach((it, i) => {
    lines.push(`${i + 1}. ${it.full_name}${it.title ? `, ${it.title}` : ""} at ${it.company_name}`);
    lines.push(`   ${it.linkedin_url}`);
    lines.push(`   Connect note (${it.connect_note.length}/300): ${it.connect_note}`);
    lines.push(`   Follow-up DM: ${it.follow_up_dm}`);
    if (it.evidence.length) lines.push(`   Based on: ${it.evidence.join("; ")}`);
    lines.push("");
  });
  if (notes.length) lines.push(`Notes: ${notes.join(" | ")}`);
  return lines.join("\n");
}

// ── Orchestration ─────────────────────────────────────────────────────────────────────────────

export interface LinkedinQueueDeps {
  now: () => Date;
  promotedCompanies: () => Promise<QueueCompany[]>;
  peopleFor: (companyId: string) => Promise<QueuePerson[]>;
  adsFor: (companyId: string) => Promise<string[]>;
  lookup: (c: QueueCompany) => Promise<ProspectLookupResponse>;
  savePerson: (companyId: string, p: QueuePerson) => Promise<string | undefined>;
  draft: (prompt: string) => Promise<string | undefined>;
  alreadyQueued: () => Promise<Set<string>>;
  store: (date: string, items: QueueItem[]) => Promise<void>;
  deliver: (subject: string, body: string) => Promise<boolean>;
}

const dateKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export async function buildLinkedinQueue(deps: LinkedinQueueDeps, mode: LinkedinQueueMode = linkedinQueueMode()): Promise<QueueResult> {
  const date = dateKey(deps.now());
  const res: QueueResult = { mode, date, items: [], lookups: 0, delivered: false, notes: [] };
  if (mode === "off") return res;

  const seen = await deps.alreadyQueued();
  const companies = (await deps.promotedCompanies()).filter((c) => !/roof/i.test(`${c.industry ?? ""} ${c.name}`));
  if (!companies.length) res.notes.push("no promoted companies yet — run a research job and promote the best fits first");
  let lookupsOpen = mode === "active";

  for (const c of companies) {
    if (res.items.length >= DAILY_TARGET) break;
    let people = (await deps.peopleFor(c.id)).filter((p) => p.linkedin_url && !seen.has(p.linkedin_url));
    if (!people.length && lookupsOpen && res.lookups < MAX_LOOKUPS) {
      const r = await deps.lookup(c);
      res.lookups++;
      if (!r.ok) {
        res.notes.push(`LinkedIn lookup for ${c.name}: ${r.error}`);
        if (r.refused || r.locked || r.not_logged_in) lookupsOpen = false;
      } else if (r.kind === "prospect.linkedin_lookup") {
        for (const hit of r.people) {
          if (seen.has(hit.linkedin_url)) continue;
          const p: QueuePerson = { full_name: hit.full_name, title: hit.title, linkedin_url: hit.linkedin_url };
          p.id = await deps.savePerson(c.id, p).catch(() => undefined);
          people.push(p);
        }
        const left = r.budget.remaining_today;
        if (left.searches < 1 || left.views < PROFILES_PER_LOOKUP) {
          lookupsOpen = false;
          res.notes.push(`LinkedIn budget reached (${left.searches} searches / ${left.views} views left today)`);
        }
      }
    }
    // One decision-maker per company: the first hit is already the best persona match.
    people = people.slice(0, 1);
    for (const p of people) {
      const evidence = evidenceFor(c, await deps.adsFor(c.id).catch(() => []));
      const drafted = parseDrafts(await deps.draft(draftPrompt(p, c, evidence)).catch(() => undefined)) ?? fallbackDrafts(p, c, evidence);
      res.items.push({ company_id: c.id, company_name: c.name, person_id: p.id, full_name: p.full_name, title: p.title, linkedin_url: p.linkedin_url, ...drafted, evidence });
      seen.add(p.linkedin_url);
    }
  }

  if (res.items.length && res.items.length < DAILY_MIN) res.notes.push(`only ${res.items.length} people today (target ${DAILY_MIN}–${DAILY_TARGET})`);
  await deps.store(date, res.items);
  if (mode === "active" && res.items.length) {
    res.delivered = await deps.deliver(`LinkedIn queue — ${res.items.length} people (${date})`, digestText(res.items, date, res.notes));
  }
  return res;
}

// ── Real deps ─────────────────────────────────────────────────────────────────────────────────

async function queueDir(): Promise<string> {
  const { loadConfig } = await import("../config");
  const dir = path.join((await loadConfig()).dataDir, "linkedin-queue");
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/** Every queued day, newest first — the Office view and the API route read this. */
export async function readQueue(limitDays = 5): Promise<{ date: string; items: QueueItem[] }[]> {
  const dir = await queueDir();
  const files = (await fs.readdir(dir).catch(() => [] as string[])).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().reverse().slice(0, limitDays);
  const out: { date: string; items: QueueItem[] }[] = [];
  for (const f of files) {
    try { out.push({ date: f.slice(0, 10), items: JSON.parse(await fs.readFile(path.join(dir, f), "utf8")) as QueueItem[] }); } catch { /* skip */ }
  }
  return out;
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const numOrU = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

export const defaultLinkedinQueueDeps: LinkedinQueueDeps = {
  now: () => new Date(),
  promotedCompanies: async () => {
    const { companiesSearch } = await import("./osBridge");
    const raw = await companiesSearch({ promoted: true, order: "fit_score.desc", limit: 60 });
    const rows = Array.isArray(raw) ? raw : raw && typeof raw === "object" && Array.isArray((raw as { rows?: unknown }).rows) ? (raw as { rows: unknown[] }).rows : [];
    return (rows as Record<string, unknown>[]).flatMap((r) => {
      const id = str(r.id), name = str(r.name);
      if (!id || !name) return [];
      const industry = Array.isArray(r.industry) ? (r.industry as unknown[]).filter((x) => typeof x === "string").join(", ") : str(r.industry);
      return [{ id, name, city: str(r.city), state: str(r.state), website_url: str(r.website_url), industry, rating: numOrU(r.rating), review_count: numOrU(r.review_count), fit_score: numOrU(r.fit_score) }];
    });
  },
  peopleFor: async (companyId) => {
    const { companyPeopleList } = await import("./osBridge");
    const rows = await companyPeopleList({ company_id: companyId });
    return rows
      .filter((r) => r.linkedin_url && (r.is_decision_maker || r.role_type === "owner" || r.role_type === "ceo" || r.role_type === "gm" || !r.role_type))
      .sort((a, b) => Number(!!b.is_decision_maker) - Number(!!a.is_decision_maker) || (b.confidence ?? 0) - (a.confidence ?? 0))
      .map((r) => ({ id: r.id, full_name: r.full_name, title: r.title, linkedin_url: r.linkedin_url! }));
  },
  adsFor: async (companyId) => {
    const { companyTechnologiesList } = await import("./osBridge");
    const rows = (await companyTechnologiesList(companyId).catch(() => [])) as unknown as { name?: string; technology?: string; category?: string }[];
    return (Array.isArray(rows) ? rows : [])
      .filter((t) => (t.category ?? "").toLowerCase() === "ads")
      .map((t) => t.name ?? t.technology ?? "")
      .filter((n) => /google ads|meta|facebook/i.test(n))
      .map((n) => (/google/i.test(n) ? "Google Ads" : "Meta ads"))
      .filter((v, i, a) => a.indexOf(v) === i);
  },
  lookup: async (c) => {
    const { postProspectLookup } = await import("@autom8ionlab/agent-core");
    const { loadConfig } = await import("../config");
    const cfg = await loadConfig();
    const domain = c.website_url ? c.website_url.replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0] : undefined;
    return postProspectLookup(cfg.fridayBaseUrl, {
      from: "clara",
      kind: "prospect.linkedin_lookup",
      ref: `linkedin-queue:${c.id}`,
      input: { company: { name: c.name, domain, city: c.city, state: c.state }, personas: DECISION_TITLES.slice(0, 5), max_profiles: PROFILES_PER_LOOKUP },
    });
  },
  savePerson: async (companyId, p) => {
    const { companyPeopleUpsert } = await import("./osBridge");
    const r = await companyPeopleUpsert({ company_id: companyId, full_name: p.full_name, title: p.title, linkedin_url: p.linkedin_url, is_decision_maker: true, source: "linkedin", source_url: p.linkedin_url });
    return r.person?.id;
  },
  draft: async (prompt) => {
    const { runTier } = await import("./llm");
    const r = await runTier(2, prompt, { purpose: "prospect:linkedin_draft", json: true, maxTokens: 500 });
    return r.ok ? r.text : undefined;
  },
  alreadyQueued: async () => {
    const days = await readQueue(60);
    return new Set(days.flatMap((d) => d.items.map((i) => i.linkedin_url)));
  },
  store: async (date, items) => {
    const dir = await queueDir();
    await fs.writeFile(path.join(dir, `${date}.json`), JSON.stringify(items, null, 2), "utf8");
  },
  deliver: async (subject, body) => {
    const { loadConfig } = await import("../config");
    const { sendMail } = await import("../ms-mail");
    const to = (await loadConfig()).principals.owner.emails[0];
    if (!to) return false;
    const r = await sendMail({ to, subject: `Clara: ${subject}`, body, headers: { "X-Clara-Notify": "1" } } as never).catch(() => ({ ok: false }));
    return !!(r as { ok?: boolean }).ok;
  },
};

let running = false;
/** Scheduler entry: weekdays 08:00 local, once per day (the stored file is the once-a-day guard). */
export async function linkedinQueueTick(deps: LinkedinQueueDeps = defaultLinkedinQueueDeps): Promise<QueueResult | null> {
  const mode = linkedinQueueMode();
  if (mode === "off" || running) return null;
  const now = deps.now();
  if (!isQueueRunTime(now)) return null;
  const today = dateKey(now);
  if ((await readQueue(1)).some((d) => d.date === today)) return null;
  running = true;
  try {
    return await buildLinkedinQueue(deps, mode);
  } finally {
    running = false;
  }
}
