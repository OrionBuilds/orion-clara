// Meeting prep documents (owner-comms overhaul, 2026-09-24).
//
// For every EXTERNAL meeting on today's calendar, Clara writes a one-page prep — Who / Why now /
// Last time / Open items / Three questions — as a Google Doc under Drive: Clara / Prep / <date>,
// mirrors the link into the vault, and remembers the event id in <dataDir>/meeting-prep-state.json
// so the 07:30 scheduler job and the OS `clara.meeting_prep` handler never double-produce. The
// brief and the 08:30 call read `prepForDate(date)` to say where each document is.
//
// Every gather is best-effort: a dead CRM or Gmail degrades a section, never the document. The
// cloud model only sees the gathered facts when the sensitivity gate says they are safe; otherwise
// the document is the raw facts, assembled deterministically.

import { promises as fs } from "node:fs";
import path from "node:path";
import { loadConfig } from "./config";
import { combinedUpcoming, type CalEvent } from "./ms-calendar";
import { listContacts } from "./contacts";
import { searchMessages, getThread } from "./ms-mail";
import { listOpen as listOpenTasks } from "./tasks";
import { listOpen as listOpenFollowups } from "./followups";
import { osClient, osEnabled } from "./osClient";
import { complete } from "./engines";
import { classify as classifySensitivity } from "./sensitivity";
import { ensureFolder, createFile } from "./ms-files";
import { append as ledgerAppend } from "./ledger";
import { slugify } from "./meetings/file";
import { BUSINESS_DOMAIN, OWNER_FIRST } from "./owner";
import { ymd, fmtTime } from "./briefModel";

export interface PrepRecord {
  eventId: string;
  date: string;
  meeting: string;
  start: string;
  fileId: string;
  link: string;
  docName: string;
  createdAt: string;
}

type State = Record<string, PrepRecord>; // key: eventId

async function stateFile(): Promise<string> {
  const cfg = await loadConfig();
  await fs.mkdir(cfg.dataDir, { recursive: true });
  return path.join(cfg.dataDir, "meeting-prep-state.json");
}
async function loadState(): Promise<State> {
  try { return JSON.parse(await fs.readFile(await stateFile(), "utf8")) as State; } catch { return {}; }
}
async function saveState(s: State): Promise<void> {
  const p = await stateFile();
  const tmp = `${p}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(s, null, 2), "utf8");
  await fs.rename(tmp, p);
}

export async function prepForDate(date: string): Promise<PrepRecord[]> {
  const s = await loadState();
  return Object.values(s).filter((r) => r.date === date).sort((a, b) => a.start.localeCompare(b.start));
}

// ── Candidate selection (pure, unit-tested) ────────────────────────────────

function domainOf(email: string): string {
  const at = email.lastIndexOf("@");
  return at >= 0 ? email.slice(at + 1).toLowerCase() : "";
}

export function externalAttendees(attendees: string[] | undefined, homeDomain: string = BUSINESS_DOMAIN): string[] {
  const home = homeDomain.toLowerCase();
  return (attendees ?? []).filter((a) => {
    const d = domainOf(a);
    return d && d !== home && !d.endsWith(`.${home}`);
  });
}

export function isAllDay(e: Pick<CalEvent, "start" | "end">): boolean {
  // Google returns all-day events as bare dates (no time component); also treat a ≥ 23h span as all-day.
  if (!/T/.test(e.start)) return true;
  const span = Date.parse(e.end) - Date.parse(e.start);
  return Number.isFinite(span) && span >= 23 * 3600_000;
}

export function selectCandidates(
  events: CalEvent[],
  opts: { date: string; alreadyPrepared: Set<string>; homeDomain?: string },
): CalEvent[] {
  return events.filter((e) => {
    if (!e.id || opts.alreadyPrepared.has(e.id)) return false;
    const t = new Date(e.start);
    if (Number.isNaN(t.getTime()) || ymd(t) !== opts.date) return false;
    if (isAllDay(e)) return false;
    return externalAttendees(e.attendees, opts.homeDomain).length > 0;
  });
}

// ── Gathering ─────────────────────────────────────────────────────────────

interface Gathered {
  event: CalEvent;
  externals: string[];
  contacts: { name: string; email?: string; relation?: string; notes?: string }[];
  crm: string[];
  notes: { file: string; excerpt: string }[];
  thread: { subject: string; from: string; at: string; text: string }[];
  openItems: string[];
  /** Read-before: what Clara's vault memory already holds about these people / this meeting. */
  memory?: string;
}

function unwrap(content: unknown): unknown {
  if (Array.isArray(content)) {
    const first = content.find((c) => c && typeof c === "object" && "text" in (c as object));
    if (first && typeof (first as { text?: unknown }).text === "string") {
      try { return JSON.parse((first as { text: string }).text); } catch { return (first as { text: string }).text; }
    }
  }
  return content;
}
function rows(v: unknown): Record<string, unknown>[] {
  if (Array.isArray(v)) return v as Record<string, unknown>[];
  if (v && typeof v === "object") {
    for (const k of ["data", "rows", "items", "results", "contacts", "opportunities"]) {
      const inner = (v as Record<string, unknown>)[k];
      if (Array.isArray(inner)) return inner as Record<string, unknown>[];
    }
  }
  return [];
}

const localPart = (email: string) => email.split("@")[0]?.replace(/[._-]+/g, " ") ?? email;

async function vaultNotesMentioning(terms: string[], max = 3): Promise<{ file: string; excerpt: string }[]> {
  const cfg = await loadConfig();
  const dir = path.join(cfg.vaultRoot, "meetings");
  let names: string[] = [];
  try { names = (await fs.readdir(dir)).filter((n) => n.endsWith(".md") && !n.endsWith("-prep.md")).sort().reverse(); } catch { return []; }
  const needles = terms.map((t) => t.toLowerCase()).filter((t) => t.length >= 3);
  if (!needles.length) return [];
  const out: { file: string; excerpt: string }[] = [];
  for (const n of names.slice(0, 120)) {
    if (out.length >= max) break;
    let body = "";
    try { body = await fs.readFile(path.join(dir, n), "utf8"); } catch { continue; }
    const hay = `${n}\n${body}`.toLowerCase();
    if (!needles.some((t) => hay.includes(t))) continue;
    out.push({ file: n, excerpt: body.replace(/\s+/g, " ").trim().slice(0, 700) });
  }
  return out;
}

async function gather(event: CalEvent, externals: string[]): Promise<Gathered> {
  const names = externals.map(localPart);
  const orgs = [...new Set(externals.map(domainOf).map((d) => d.split(".")[0]).filter(Boolean))];
  const terms = [...names, ...orgs, event.summary].map((s) => s.trim()).filter(Boolean);

  const [contacts, crm, notes, thread, tasks, followups] = await Promise.all([
    listContacts().then((cs) => cs.filter((c) => externals.some((e) => c.email?.toLowerCase() === e.toLowerCase()))).catch(() => []),
    (async () => {
      if (!osEnabled()) return [] as string[];
      const lines: string[] = [];
      for (const term of [...orgs, ...names].slice(0, 3)) {
        try {
          const cs = rows(unwrap(await osClient.callTool("contacts_list", { search: term, limit: 3 })));
          for (const c of cs) {
            const nm = String(c.name ?? [c.first_name, c.last_name].filter(Boolean).join(" ") ?? "").trim();
            const company = String(c.company ?? c.company_name ?? "").trim();
            const status = String(c.status ?? "").trim();
            if (nm || company) lines.push(`CRM contact: ${[nm, company, status].filter(Boolean).join(" · ")}`);
          }
        } catch { /* best-effort */ }
      }
      try {
        const opps = rows(unwrap(await osClient.callTool("opportunities_list", { status: "eq.open", limit: 50 })));
        for (const o of opps) {
          const hay = JSON.stringify(o).toLowerCase();
          if (![...orgs, ...names].some((t) => t && hay.includes(t.toLowerCase()))) continue;
          lines.push(`Open deal: ${String(o.name ?? o.title ?? "untitled")}${o.stage_name || o.stage ? ` — ${String(o.stage_name ?? o.stage)}` : ""}${o.value || o.amount ? ` — $${String(o.value ?? o.amount)}` : ""}`);
        }
      } catch { /* best-effort */ }
      return [...new Set(lines)].slice(0, 6);
    })(),
    vaultNotesMentioning(terms),
    (async () => {
      const q = externals.slice(0, 2).map((e) => `from:${e} OR to:${e}`).join(" OR ");
      if (!q) return [];
      const msgs = await searchMessages(`(${q}) newer_than:90d`, 3).catch(() => []);
      if (!msgs.length) return [];
      const latest = msgs[0];
      const t = await getThread(latest.threadId, "work", { max: 6 }).catch(() => []);
      return t.slice(-4).map((m) => ({ subject: latest.subject, from: m.from, at: m.at, text: m.text.replace(/\s+/g, " ").slice(0, 400) }));
    })(),
    listOpenTasks().catch(() => []),
    listOpenFollowups().catch(() => []),
  ]);

  const mention = (s: string) => terms.some((t) => t.length >= 3 && s.toLowerCase().includes(t.toLowerCase()));
  const openItems = [
    ...tasks.filter((t) => mention(`${t.title} ${t.detail ?? ""}`)).map((t) => `Task: ${t.title}`),
    ...followups.filter((f) => mention(`${f.what} ${f.contact.name} ${f.contact.email ?? ""}`)).map((f) => `Waiting on: ${f.what} (${f.contact.name}, nudged ${f.nudgeCount}x)`),
  ].slice(0, 8);

  const { recallFor } = await import("./vaultMemory");
  const subject = contacts[0]?.name ?? orgs[0] ?? names[0];
  const memory = await recallFor({ subject, query: event.summary, kinds: ["delegation", "meeting-prep", "decision", "call", "email", "escalation"], max: 1500, noFallback: true }).catch(() => "");
  return {
    event, externals,
    contacts: contacts.map((c) => ({ name: c.name, email: c.email, relation: c.relation, notes: c.notes })),
    crm, notes, thread, openItems, ...(memory ? { memory } : {}),
  };
}

// ── Composition ───────────────────────────────────────────────────────────

function factsBlock(g: Gathered): string {
  const e = g.event;
  return [
    `Meeting: ${e.summary}`,
    `When: ${e.start}${e.end ? ` – ${e.end}` : ""}`,
    `External attendees: ${g.externals.join(", ")}`,
    e.description ? `Calendar description: ${e.description.slice(0, 600)}` : "",
    g.contacts.length ? `Known contacts:\n${g.contacts.map((c) => `- ${c.name}${c.relation ? ` (${c.relation})` : ""}${c.notes ? ` — ${c.notes.slice(0, 200)}` : ""}`).join("\n")}` : "",
    g.crm.length ? `CRM:\n${g.crm.map((l) => `- ${l}`).join("\n")}` : "",
    g.notes.length ? `Previous meeting notes:\n${g.notes.map((n) => `- ${n.file}: ${n.excerpt}`).join("\n")}` : "",
    g.thread.length ? `Most recent email thread (${g.thread[0].subject}):\n${g.thread.map((m) => `- ${m.at} ${m.from}: ${m.text}`).join("\n")}` : "",
    g.openItems.length ? `Open items:\n${g.openItems.map((o) => `- ${o}`).join("\n")}` : "",
    g.memory ? `What I already know from memory (earlier threads, hand-offs, decisions):\n${g.memory}` : "",
  ].filter(Boolean).join("\n\n");
}

function deterministicDoc(g: Gathered): string {
  const e = g.event;
  const who = g.contacts.length
    ? g.contacts.map((c) => `${c.name}${c.relation ? ` — ${c.relation}` : ""}${c.notes ? `. ${c.notes.slice(0, 200)}` : ""}`).join("\n")
    : g.externals.map((x) => `${localPart(x)} (${x})`).join("\n");
  return [
    `Prep — ${e.summary} — ${ymd(new Date(e.start))}`,
    `${fmtTime(e.start)}${e.end ? `–${fmtTime(e.end)}` : ""}`,
    ``,
    `Who`, who,
    ``,
    `Why now`, e.description?.trim() || "No agenda on the invite. Confirm the purpose at the top of the call.",
    ``,
    `Last time`, g.notes.length ? g.notes.map((n) => `${n.file.replace(/\.md$/, "")}: ${n.excerpt.slice(0, 300)}`).join("\n") : (g.thread.length ? `Last email (${g.thread[0].subject}): ${g.thread[g.thread.length - 1].text.slice(0, 300)}` : "No prior notes or threads found."),
    ``,
    `Open items`, [...g.openItems, ...g.crm].length ? [...g.openItems, ...g.crm].join("\n") : "Nothing open on our side.",
    ``,
    `Three questions`,
    `1. What outcome would make this meeting a success for them?`,
    `2. What has changed since we last spoke?`,
    `3. What is the next concrete step, and who owns it?`,
  ].join("\n");
}

async function composeDoc(g: Gathered): Promise<{ content: string; via: "model" | "facts" }> {
  const facts = factsBlock(g);
  if (classifySensitivity({ text: facts }).sensitive) return { content: deterministicDoc(g), via: "facts" };
  try {
    const out = await complete({
      system:
        `You are CLARA, ${OWNER_FIRST}'s executive assistant, writing a one-page meeting prep they will skim on their phone five minutes before the call. ` +
        `Use ONLY the facts provided; never invent people, numbers or history. Plain prose and short bullets, no markdown headings syntax (write the section titles as plain lines), no emoji. ` +
        `Sections, in this order: Who / Why now / Last time / Open items / Three questions. Keep it under 350 words.`,
      prompt: `Facts:\n${facts}\n\nWrite the prep now.`,
      timeoutMs: 60_000,
      purpose: "brief",
    });
    const text = out.trim();
    if (text.length < 80 || !/Who/.test(text) || !/questions/i.test(text)) return { content: deterministicDoc(g), via: "facts" };
    return { content: `Prep — ${g.event.summary} — ${ymd(new Date(g.event.start))}\n${fmtTime(g.event.start)}\n\n${text}`, via: "model" };
  } catch {
    return { content: deterministicDoc(g), via: "facts" };
  }
}

// ── Drive + vault ─────────────────────────────────────────────────────────

async function prepFolderFor(date: string): Promise<string | undefined> {
  const clara = await ensureFolder("Clara");
  if (!clara) return undefined;
  const prep = await ensureFolder("Prep", clara.id);
  if (!prep) return undefined;
  const day = await ensureFolder(date, prep.id);
  return day?.id;
}

async function mirrorToVault(date: string, e: CalEvent, rec: PrepRecord, content: string): Promise<void> {
  const cfg = await loadConfig();
  const dir = path.join(cfg.vaultRoot, "meetings");
  await fs.mkdir(dir, { recursive: true });
  const p = path.join(dir, `${date}-${slugify(e.summary || "meeting")}-prep.md`);
  const md = [
    `---`, `title: "Prep — ${e.summary.replace(/"/g, "'")}"`, `date: ${date}`, `event_id: ${e.id}`, `drive: ${rec.link}`, `---`, ``,
    `Google Doc: ${rec.link}`, ``, content,
  ].join("\n");
  await fs.writeFile(p, md, "utf8");
}

// ── Job ───────────────────────────────────────────────────────────────────

// The 07:30 job, the morning-brief prerequisite and the OS handler can overlap; one run at a time.
let prepLock: Promise<unknown> = Promise.resolve();

export async function runMeetingPrep(opts: { now?: Date; dryRun?: boolean; log?: (m: string) => void } = {}): Promise<{ prepared: PrepRecord[]; skipped: number; failed: string[] }> {
  const run = prepLock.then(() => runMeetingPrepInner(opts), () => runMeetingPrepInner(opts));
  prepLock = run.catch(() => undefined);
  return run;
}

async function runMeetingPrepInner(opts: { now?: Date; dryRun?: boolean; log?: (m: string) => void }): Promise<{ prepared: PrepRecord[]; skipped: number; failed: string[] }> {
  const now = opts.now ?? new Date();
  const date = ymd(now);
  const log = opts.log ?? ((m: string) => console.log(`[clara/meeting-prep] ${m}`));
  const state = await loadState();
  const events = await combinedUpcoming(1).catch(() => [] as CalEvent[]);
  // Dedupe by event AND date: a meeting rescheduled to another day gets a fresh prep doc.
  const alreadyPrepared = new Set(Object.values(state).filter((r) => r.date === date).map((r) => r.eventId));
  const candidates = selectCandidates(events, { date, alreadyPrepared });
  const skipped = events.length - candidates.length;
  const prepared: PrepRecord[] = [];
  const failed: string[] = [];
  if (!candidates.length) { log(`no external meetings to prep for ${date} (${events.length} event(s) seen)`); return { prepared, skipped, failed }; }

  let folderId: string | undefined;
  for (const e of candidates) {
    try {
      const g = await gather(e, externalAttendees(e.attendees));
      const doc = await composeDoc(g);
      const docName = `Prep — ${e.summary} — ${date}`;
      if (opts.dryRun) {
        log(`dry-run: would create "${docName}" (${doc.via}, ${doc.content.length} chars)`);
        prepared.push({ eventId: e.id, date, meeting: e.summary, start: e.start, fileId: "", link: "", docName, createdAt: now.toISOString() });
        continue;
      }
      folderId = folderId ?? (await prepFolderFor(date));
      if (!folderId) { failed.push(`${e.summary}: Drive folder Clara/Prep/${date} unavailable — not filed, will retry`); continue; }
      const r = await createFile({ name: docName, content: doc.content, as: "doc", folderId, requestor: "owner" });
      if (!r.ok || !r.file) { failed.push(`${e.summary}: ${r.error ?? "create failed"}`); continue; }
      const rec: PrepRecord = { eventId: e.id, date, meeting: e.summary, start: e.start, fileId: r.file.id, link: r.file.webViewLink ?? `https://docs.google.com/document/d/${r.file.id}/edit`, docName, createdAt: now.toISOString() };
      state[`${e.id}:${date}`] = rec;
      await saveState(state);
      await mirrorToVault(date, e, rec, doc.content).catch(() => {});
      await ledgerAppend({ kind: "document", actor: "clara", what: `prepared meeting doc "${docName}" (${doc.via})`, ref: rec.fileId, meta: { link: rec.link, eventId: e.id } }).catch(() => {});
      {
        const { recordOutcome } = await import("./vaultMemory");
        await recordOutcome({ thread: `meeting-${date}-${e.summary}`, kind: "meeting-prep", status: "done",
          title: `Prep doc for ${e.summary}`, subject: g.contacts[0]?.name, people: g.externals.slice(0, 3),
          done: `Prepared the meeting doc (${doc.via}) for ${e.start}.`, links: [{ label: "Prep doc", url: rec.link }] }).catch(() => {});
      }
      prepared.push(rec);
      log(`prepared "${docName}" → ${rec.link}`);
    } catch (err) {
      failed.push(`${e.summary}: ${String((err as Error).message ?? err).slice(0, 160)}`);
    }
  }
  // Prune records older than 7 days so the state file stays small.
  const cutoff = ymd(new Date(now.getTime() - 7 * 86_400_000));
  for (const [k, v] of Object.entries(state)) if (v.date < cutoff) delete state[k];
  if (!opts.dryRun) await saveState(state).catch(() => {});
  return { prepared, skipped, failed };
}

export function meetingPrepEnabled(): boolean {
  return (process.env.CLARA_MEETING_PREP ?? "on").trim().toLowerCase() !== "off";
}
