// The morning brief as DATA (owner-comms overhaul, 2026-09-24).
//
// composeExecutiveBrief used to build markdown inline. Splitting model from rendering lets the
// same facts drive three surfaces: the vault/text copy (renderBriefMarkdown), the HTML email
// (renderBriefHtml) and the 08:30 call's fallback script (renderBriefSpoken). The sections are the
// ones the owner asked for: meetings today (and tomorrow morning), emails that need them, prep
// documents and where they are, what the team did (with links to the Drive documents), questions
// for them in plain English — never an approval code — and the watch list.
//
// Pure renderers take a BriefModel and return strings; composeBriefModel is the only async part.

import { promises as fs } from "node:fs";
import path from "node:path";
import { loadConfig } from "./config";
import { combinedUpcoming, type CalEvent } from "./ms-calendar";
import { listUnreadInbox, type GmailMessage } from "./ms-mail";
import { classify as classifyMail } from "./triage";
import { listQueuedNotifications } from "./notify";
import { listPending as listPendingApprovals } from "./approvals";
import { listPendingDecisions, renderAsk } from "./decisions";
import { readAll as readLedger } from "./ledger";
import { connectedAccounts } from "./ms-auth";
import { twilioConfig } from "./channels";
import { OWNER_FIRST, BUSINESS_DOMAIN } from "./owner";
import { forecastDays, weatherAffectsDay, weatherConfigured } from "./weather";
import { fetchPeerSection, formatAge, type PeerFetch, type PeerLink } from "./briefPeers";
import type { StatusResponse } from "@autom8ionlab/agent-core";

export interface MeetingItem {
  id: string;
  start: string;
  end?: string;
  summary: string;
  attendees: string[];
  meetLink?: string;
  external: boolean;
  prepLink?: string;
}
export interface WaitingItem {
  agent: "clara" | "friday";
  id: string;
  /** Kept for later resolvers (voice/SMS); NEVER rendered to the owner. */
  code?: string;
  title: string;
  question: string;
  age?: string;
}
export interface TeamSection {
  actions: { text: string; link?: string }[];
  fromCache: boolean;
  fetchedAt?: string;
}
export interface BriefModel {
  date: string;
  now: string;
  meetings: { today: MeetingItem[]; tomorrowAm: MeetingItem[] };
  emails: { from: string; subject: string; why: string; link: string; threadId: string }[];
  prep: { meeting: string; start: string; docName: string; link: string }[];
  team: { friday: TeamSection };
  waiting: WaitingItem[];
  watch: string[];
  /** Read-before: open threads from Clara's vault memory — hand-offs, promises, where things were left. */
  stillOpen?: string[];
  /** The owner's work line (workLineLog.ts): last 24h of calls and texts Clara handled, and who they owe a callback. */
  callsAndTexts?: { lines: string[]; callbacks: string[] };
  /** Prospecting (PR 16): the one-line prospect_daily_stats summary — absent when the OS
   *  prospecting tables aren't live or the call fails, same "omit rather than show a broken
   *  section" convention as stillOpen/callsAndTexts above. */
  prospecting?: string;
  batched: string[];
  weather?: string;
  /** Queued-notification ids consumed by this compose, per source — acked only after delivery. */
  drain?: { friday: string[]; own: string[] };
  counts: { meetings: number; emails: number; decisions: number };
}

// ── Small pure helpers ────────────────────────────────────────────────────

const URL_RX = /https?:\/\/[^\s)<>"']+/g;
const EMOJI_RX = /[\p{Extended_Pictographic}️‍]/gu;

export function stripEmoji(s: string): string {
  return s.replace(EMOJI_RX, "").replace(/\s{2,}/g, " ").trim();
}

export function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function fmtTime(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

function firstUrl(text: string): string | undefined {
  const m = text.match(URL_RX);
  return m?.[0];
}

function domainOf(email: string): string {
  const at = email.lastIndexOf("@");
  return at >= 0 ? email.slice(at + 1).toLowerCase() : "";
}

function isExternalMeeting(attendees: string[]): boolean {
  const home = BUSINESS_DOMAIN.toLowerCase();
  return attendees.some((a) => {
    const d = domainOf(a);
    return d && d !== home && !d.endsWith(`.${home}`);
  });
}

function fromName(from: string): string {
  return from.replace(/<.*>/, "").replace(/"/g, "").trim() || from;
}

function gmailLink(threadId: string): string {
  return `https://mail.google.com/mail/u/0/#inbox/${threadId}`;
}

// Plain-English question for a pending decision — deterministic templating so the same row always
// phrases the same way (later resolvers match replies against it). Never a code, never an emoji.
export function questionFor(w: { agent: string; title: string; kind?: string; facts?: unknown }): string {
  const title = stripEmoji(w.title).replace(/\s*\(#[0-9A-Z]{3,6}\)\s*/g, " ").replace(/\s+/g, " ").trim().replace(/[.?!]+$/, "");
  const agent = w.agent.toLowerCase();
  const q = (s: string) => s.replace(/\s+/g, " ").trim();
  if (agent === "clara") {
    switch (w.kind) {
      case "call.business": return q(`OK for me to make the call: ${title}?`);
      case "email.send": return q(`Send this email: ${title}?`);
      case "drive.modify": return q(`Go ahead and make this edit: ${title}?`);
      case "drive.trash": return q(`Move this to the Drive trash: ${title}?`);
      case "vendor.quote-req": return q(`Send the quote request: ${title}?`);
      case "scope.out-of-bounds": return q(`This is outside the agreed scope — do you want to take it on anyway: ${title}?`);
      default: return q(`Should I go ahead with this: ${title}?`);
    }
  }
  const who = agent === "friday" ? "FRIDAY" : agent.toUpperCase();
  const lower = title.charAt(0).toLowerCase() + title.slice(1);
  if (/^(send|email|publish|post|launch|enable|pause|raise|lower|increase|decrease|deploy|merge|ship|create|update|change|reply)\b/i.test(title)) {
    return q(`Do you want ${who} to ${lower}?`);
  }
  return q(`Do you want ${who} to go ahead with "${title}"?`);
}

export function briefSubject(m: BriefModel): string {
  const d = new Date(`${m.date}T12:00:00`);
  const day = Number.isNaN(d.getTime()) ? m.date : d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }).replace(",", "");
  const { meetings, emails, decisions } = m.counts;
  if (!meetings && !emails && !decisions) return `Morning brief — ${day}: quiet day`;
  const bits = [
    `${meetings} meeting${meetings === 1 ? "" : "s"}`,
    `${emails} email${emails === 1 ? "" : "s"} need${emails === 1 ? "s" : ""} you`,
    `${decisions} decision${decisions === 1 ? "" : "s"}`,
  ];
  return `Morning brief — ${day}: ${bits.join(", ")}`;
}

// ── Compose ───────────────────────────────────────────────────────────────

async function weatherLine(): Promise<string | undefined> {
  if (!(await weatherConfigured())) return undefined;
  const f = await forecastDays(1);
  if (!f.ok || !f.days.length) return undefined;
  const d = f.days[0];
  const v = weatherAffectsDay(d);
  const base = `${d.description || d.conditionCode.toLowerCase()}, high ${d.highF}° / low ${d.lowF}°, ${d.precipProbPct}% precip`;
  return v.affects ? `${base}. Worth planning around: ${v.reason}` : base;
}

function toMeeting(e: CalEvent, prepByEvent: Map<string, string>): MeetingItem {
  const attendees = e.attendees ?? [];
  return {
    id: e.id,
    start: e.start,
    end: e.end,
    summary: stripEmoji(e.summary || "(untitled)"),
    attendees,
    meetLink: e.hangoutLink,
    external: isExternalMeeting(attendees),
    prepLink: prepByEvent.get(e.id),
  };
}

function teamSection(pf: PeerFetch): TeamSection {
  if (!pf.section) return { actions: [], fromCache: true, fetchedAt: pf.fetchedAt ?? undefined };
  const seen = new Set<string>();
  const actions: { text: string; link?: string }[] = [];
  const push = (text: string, link?: string) => {
    // Peer lines carry internal prefixes ("run completed: Done — …") — drop them; the owner wants
    // the outcome, not the plumbing label.
    const t = stripEmoji(text)
      .replace(/\s*Full report in the app\.?/i, "")
      .replace(/^(run completed|task completed|completed)\s*:\s*/i, "")
      .replace(/^done\s*[.—–-]*\s*/i, "")
      .trim();
    if (!t || seen.has(t)) return;
    seen.add(t);
    actions.push({ text: t, ...(link ? { link } : {}) });
  };
  // Queued items are the team's finished work since the last brief — prefer the structured
  // headline + summary + Drive link the apps now attach; fall back to the plain text line.
  for (const q of pf.section.queued) {
    if (q.needsDecision) continue; // rendered under "Questions for you", not here
    const link = q.links?.[0]?.url ?? firstUrl(q.text);
    if (q.headline) push(q.summary ? `${q.headline} — ${q.summary}` : q.headline, link);
    else push(q.text.replace(URL_RX, "").trim(), link);
  }
  for (const a of pf.section.autonomousActions) {
    const link = a.link ?? a.links?.[0]?.url ?? firstUrl(a.text);
    push(a.text.replace(URL_RX, "").trim(), link);
  }
  return { actions: actions.slice(0, 12), fromCache: pf.fromCache, fetchedAt: pf.fetchedAt ?? undefined };
}

/**
 * "What the team did" from a bench's portfolio status (Phase 5): the same structured answer the
 * status tools use, so the brief and "how's X going?" never disagree. Falls back to the peer
 * brief-section items when the bench's status endpoint is unreachable.
 */
function teamFromStatus(sr: StatusResponse | undefined, fallback: TeamSection): TeamSection {
  if (!sr || !sr.recent.length) return fallback;
  const seen = new Set<string>();
  const actions: { text: string; link?: string }[] = [];
  for (const i of sr.recent) {
    const t = stripEmoji(i.headline).trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    actions.push({ text: t, ...(i.link ? { link: i.link } : {}) });
  }
  for (const i of sr.blocked) {
    const t = `Blocked: ${stripEmoji(i.headline).trim()}`;
    if (seen.has(t)) continue;
    seen.add(t);
    actions.push({ text: t, ...(i.link ? { link: i.link } : {}) });
  }
  // Anything the brief-section carried that the status roll-up didn't (e.g. a document link on a
  // queued item) still rides along, after the status items.
  for (const a of fallback.actions) {
    if (seen.has(a.text)) continue;
    seen.add(a.text);
    actions.push(a);
  }
  return { actions: actions.slice(0, 12), fromCache: false, fetchedAt: sr.asOf };
}

export async function composeBriefModel(now: Date = new Date()): Promise<BriefModel> {
  const date = ymd(now);
  const nowMs = now.getTime();
  const startOfDay = new Date(now); startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(now); endOfDay.setHours(23, 59, 59, 999);
  const tomorrowNoon = new Date(now); tomorrowNoon.setDate(tomorrowNoon.getDate() + 1); tomorrowNoon.setHours(12, 0, 0, 0);

  const sinceIso = new Date(nowMs - 24 * 3600_000).toISOString();
  const [upcoming, weather, ownPending, pendingDecisions, fridaySec, ledger, ownQueue, unreadRaw, preps, portfolio] = await Promise.all([
    combinedUpcoming(2).catch(() => [] as CalEvent[]),
    weatherLine().catch(() => undefined),
    listPendingApprovals().catch(() => []),
    listPendingDecisions().catch(() => null),
    fetchPeerSection("friday"),
    readLedger().catch(() => []),
    listQueuedNotifications().catch(() => []),
    listUnreadInbox(50).catch(() => [] as GmailMessage[]),
    import("./meetingPrep").then((m) => m.prepForDate(date)).catch(() => []),
    import("./teamStatus").then((m) => m.fetchStatuses({ type: "portfolio" }, sinceIso)).catch(() => null),
  ]);

  // MEETINGS — today, plus tomorrow before noon so they can prep the night before.
  const prepByEvent = new Map(preps.map((p) => [p.eventId, p.link] as const));
  const today: MeetingItem[] = [];
  const tomorrowAm: MeetingItem[] = [];
  for (const e of upcoming) {
    const t = new Date(e.start).getTime();
    if (Number.isNaN(t)) continue;
    if (t >= startOfDay.getTime() && t <= endOfDay.getTime()) today.push(toMeeting(e, prepByEvent));
    else if (t > endOfDay.getTime() && t <= tomorrowNoon.getTime()) tomorrowAm.push(toMeeting(e, prepByEvent));
  }

  // EMAILS — VIP-classified unread mail, top 5, each with a one-line "why" and a Gmail link.
  const emails: BriefModel["emails"] = [];
  for (const m of unreadRaw) {
    if (emails.length >= 5) break;
    const v = await classifyMail(m).catch(() => "escalate" as const);
    if (v !== "vip") continue;
    const snippet = stripEmoji(m.snippet ?? "").slice(0, 80);
    emails.push({
      from: fromName(m.from),
      subject: stripEmoji(m.subject || "(no subject)"),
      why: snippet ? `VIP — ${snippet}${(m.snippet ?? "").length > 80 ? "…" : ""}` : "VIP sender",
      link: gmailLink(m.threadId),
      threadId: m.threadId,
    });
  }

  // QUESTIONS FOR YOU — the unified decisions rail (decisions.ts): hers and FRIDAY's,
  // each phrased deterministically, money first. `id` is the composite decision id the resolvers
  // and deliverExecutiveBrief (markAsked) key on. Codes are never rendered.
  const waiting: WaitingItem[] = [];
  const watch: string[] = [];
  if (pendingDecisions) {
    for (const d of pendingDecisions.decisions) {
      waiting.push({
        agent: d.agent, id: d.id, title: d.title,
        question: renderAsk(d, "brief"),
        age: formatAge(d.requestedAt, nowMs),
      });
    }
    if (pendingDecisions.stale.friday) watch.push(`FRIDAY unreachable — approvals cached from ${fridaySec.fetchedAt ?? "unknown"}.`);

  } else {
    watch.push("Agent approvals unavailable this morning (proxy error).");
  }
  // Structured needsDecision items queued by the peers are only askable when they name a real
  // pending approval (then they are already in `waiting` via listPendingDecisions). One without a
  // resolvable approval would be asked and recorded, yet no reply could ever resolve it — so it
  // stays informational in "What the team did" instead of posing as a question.

  // WHAT THE TEAM DID — the benches' portfolio status roll-up (same answer as project_status),
  // with the structured brief-section items as the fallback and as extra document links.
  const okStatus = (r: unknown): StatusResponse | undefined => (r && typeof r === "object" && (r as { ok?: unknown }).ok === true ? (r as StatusResponse) : undefined);
  const team = {
    friday: teamFromStatus(okStatus(portfolio?.friday), teamSection(fridaySec)),

  };
  const ownActions = ledger
    .filter((l) => l.actor === "clara" && nowMs - Date.parse(l.ts) < 24 * 3600_000 && !/^email command REFUSED/i.test(l.what ?? ""))
    .slice(-8)
    .map((l) => stripEmoji(l.what));

  // WATCH — peer anomalies + Clara's own cheap health flags.
  for (const [label, pf] of [["FRIDAY", fridaySec]] as const) {
    if (pf.section) for (const an of pf.section.anomalies) watch.push(`${label}: ${stripEmoji(an.text)}`);
  }
  try {
    if (!connectedAccounts().some((a) => a.account === "work")) watch.push("CLARA: Google work account not connected — mail/calendar degraded.");
  } catch { /* auth store unreadable — the /system page owns deep diagnostics */ }
  if (!twilioConfig()) watch.push("CLARA: Twilio not configured — SMS and voice paths down.");
  const stale = ownPending.filter((a) => nowMs - Date.parse(a.createdAt) > 24 * 3600_000).length;
  if (stale) watch.push(`CLARA: ${stale} approval(s) pending more than 24h.`);

  // BATCHED — everything queued across both apps, coalesced; only LIVE-fetched ids drain.
  const batchedCounts = new Map<string, number>();
  const addBatched = (line: string) => batchedCounts.set(line, (batchedCounts.get(line) ?? 0) + 1);
  for (const q of ownQueue) addBatched(`[CLARA] ${stripEmoji(q.text)}`);
  for (const [label, pf] of [["FRIDAY", fridaySec]] as const) {
    if (pf.section) for (const q of pf.section.queued) addBatched(`[${label}]${pf.fromCache ? " (cached)" : ""} ${stripEmoji(q.headline ?? q.text)}`);
  }
  const batched = [...batchedCounts.entries()].map(([line, n]) => (n > 1 ? `${line} (×${n})` : line));
  const drain = {
    friday: fridaySec.fromCache ? [] : (fridaySec.section?.queued.map((q) => q.id) ?? []),

    own: ownQueue.map((q) => q.id).filter((id): id is string => Boolean(id)),
  };

  const stillOpen = await (async () => {
    const { recallFor } = await import("./vaultMemory");
    const r = await recallFor({}).catch(() => "");
    return r.split("\n").filter((l) => l.startsWith("- ")).map((l) => l.slice(2).replace(/\[\[[^|\]]*\|([^\]]*)\]\]/g, "$1").replace(/\[\[([^\]]*)\]\]/g, "$1")).slice(0, 8);
  })();
  const callsAndTexts = await (async () => {
    const configured = Boolean(process.env.CLARA_WORKLINE_NUMBER?.trim() || process.env.BLUEBUBBLES_URL?.trim());
    const { readWorkLine, callsAndTextsLines } = await import("./workLineLog");
    const entries = await readWorkLine(now.getTime() - 24 * 3_600_000).catch(() => []);
    return configured || entries.length ? callsAndTextsLines(entries) : null;
  })();
  const prospecting = await (async () => {
    const { prospectDailyStats } = await import("./prospecting/osBridge");
    const { composeWeeklySummaryLine } = await import("./prospecting/weeklyReport");
    const stats = await prospectDailyStats().catch(() => undefined);
    return stats ? composeWeeklySummaryLine(stats) : undefined;
  })();
  const model: BriefModel = {
    date,
    now: now.toISOString(),
    meetings: { today, tomorrowAm },
    emails,
    prep: preps.map((p) => ({ meeting: p.meeting, start: p.start, docName: p.docName, link: p.link })),
    team: {
      friday: team.friday,
    },
    waiting,
    watch,
    ...(stillOpen.length ? { stillOpen } : {}),
    ...(callsAndTexts ? { callsAndTexts } : {}),
    ...(prospecting ? { prospecting } : {}),
    batched,
    ...(weather ? { weather } : {}),
    drain,
    counts: { meetings: today.length, emails: emails.length, decisions: waiting.length },
  };
  // Clara's own actions are part of "what the team did" too — tucked onto the model via a stable
  // key the renderers know about (kept off the interface to avoid widening the peer shape).
  (model as BriefModel & { ownActions?: string[] }).ownActions = ownActions;
  return model;
}

/** Persist the model next to the vault copy so the 08:30 call can read it without recomposing. */
export async function persistBriefModel(m: BriefModel): Promise<string> {
  const cfg = await loadConfig();
  await fs.mkdir(cfg.dataDir, { recursive: true });
  const p = path.join(cfg.dataDir, `brief-model-${m.date}.json`);
  const tmp = `${p}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(m, null, 2), "utf8");
  await fs.rename(tmp, p);
  return p;
}

export async function loadBriefModel(date: string): Promise<BriefModel | null> {
  const cfg = await loadConfig();
  try { return JSON.parse(await fs.readFile(path.join(cfg.dataDir, `brief-model-${date}.json`), "utf8")) as BriefModel; } catch { return null; }
}

// ── Renderers ─────────────────────────────────────────────────────────────

function ownActionsOf(m: BriefModel): string[] {
  return (m as BriefModel & { ownActions?: string[] }).ownActions ?? [];
}

function meetingLineMd(e: MeetingItem): string {
  const at = e.attendees.length ? ` — with ${e.attendees.slice(0, 3).join(", ")}${e.attendees.length > 3 ? "…" : ""}` : "";
  const prep = e.prepLink ? ` — [prep doc](${e.prepLink})` : "";
  const meet = e.meetLink ? ` — [join](${e.meetLink})` : "";
  return `- **${fmtTime(e.start)}${e.end ? `–${fmtTime(e.end)}` : ""}** ${e.summary}${at}${prep}${meet}`;
}

function teamLinesMd(label: string, t: TeamSection): string[] {
  const out: string[] = [`### ${label}`];
  if (t.fromCache && !t.actions.length && !t.fetchedAt) { out.push(`- ${label} unreachable — no activity report (no cached copy yet).`); return out; }
  if (t.fromCache) out.push(`- ${label} unreachable — showing what I had from ${t.fetchedAt ?? "unknown"}.`);
  out.push(...(t.actions.length ? t.actions.map((a) => `- ${a.text}${a.link ? ` — [open](${a.link})` : ""}`) : [`- Nothing new from ${label} since yesterday.`]));
  return out;
}

export function renderBriefMarkdown(m: BriefModel): string {
  const own = ownActionsOf(m);
  return [
    `# Executive brief — ${m.date}`,
    ``,
    `Good morning, ${OWNER_FIRST}. One look at everything across CLARA and FRIDAY.`,
    ``,
    `## Meetings today (${m.meetings.today.length})`,
    m.meetings.today.length ? m.meetings.today.map(meetingLineMd).join("\n") : "- Nothing on the calendar today.",
    ``,
    `## Tomorrow morning (${m.meetings.tomorrowAm.length})`,
    m.meetings.tomorrowAm.length ? m.meetings.tomorrowAm.map(meetingLineMd).join("\n") : "- Nothing before noon tomorrow.",
    ``,
    ...(m.weather ? [`## Weather`, `- ${m.weather}`, ``] : []),
    `## Emails that need you (${m.emails.length})`,
    m.emails.length ? m.emails.map((e) => `- **${e.from}** — ${e.subject} — ${e.why} — [open](${e.link})`).join("\n") : "- Nothing waiting from a VIP.",
    ``,
    ...(m.callsAndTexts ? [
      `## Calls & texts (${m.callsAndTexts.lines.length})`,
      m.callsAndTexts.lines.length ? m.callsAndTexts.lines.map((l) => `- ${l}`).join("\n") : "- Nobody called or texted your work phone.",
      ...(m.callsAndTexts.callbacks.length ? [``, `**Call back:**`, m.callsAndTexts.callbacks.map((c) => `- ${c}`).join("\n")] : []),
      ``,
    ] : []),
    `## Prep for today (${m.prep.length})`,
    m.prep.length ? m.prep.map((p) => `- **${fmtTime(p.start)}** ${p.meeting} — [${p.docName}](${p.link})`).join("\n") : "- No prep documents needed today.",
    ``,
    `## What the team did`,
    ...teamLinesMd("FRIDAY", m.team.friday),
    `### CLARA`,
    ...(own.length ? own.map((a) => `- ${a}`) : ["- No autonomous actions in the last 24h."]),
    ``,
    `## Questions for you (${m.waiting.length})`,
    m.waiting.length
      ? [...m.waiting.map((w) => `- ${w.question}${w.age ? ` (waiting ${w.age})` : ""}`), `- Reply to this email in plain words — for example "yes to the first one, hold the second".`].join("\n")
      : "- Nothing needs your decision.",
    ``,
    ...(m.stillOpen?.length ? [`## Still open (from memory)`, m.stillOpen.map((w) => `- ${w}`).join("\n"), ``] : []),
    ...(m.prospecting ? [`## Prospecting`, m.prospecting, ``] : []),
    `## Watch`,
    m.watch.length ? m.watch.map((w) => `- ${w}`).join("\n") : "- Nothing on the watch list.",
    ``,
    `## Batched (${m.batched.length})`,
    m.batched.length ? m.batched.map((b) => `- ${b}`).join("\n") : "- Queue is clear.",
    ``,
    `---`,
    `_Composed ${m.now}._`,
  ].join("\n");
}

export function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const H2 = 'style="font-size:16px;margin:22px 0 8px;color:#1a1a1a;border-bottom:1px solid #e5e5e5;padding-bottom:4px"';
const H3 = 'style="font-size:13px;margin:12px 0 4px;color:#555;text-transform:uppercase;letter-spacing:.04em"';
const UL = 'style="margin:0 0 8px 0;padding-left:20px"';
const LI = 'style="margin:0 0 6px 0"';
const A = 'style="color:#0b57d0;text-decoration:none"';
const MUTED = 'style="color:#777"';

function a(href: string, text: string): string {
  return `<a ${A} href="${escHtml(href)}">${escHtml(text)}</a>`;
}
function ul(items: string[], empty: string): string {
  if (!items.length) return `<p ${MUTED}>${escHtml(empty)}</p>`;
  return `<ul ${UL}>${items.map((i) => `<li ${LI}>${i}</li>`).join("")}</ul>`;
}
function meetingLiHtml(e: MeetingItem): string {
  const time = `<strong>${escHtml(fmtTime(e.start))}${e.end ? `–${escHtml(fmtTime(e.end))}` : ""}</strong>`;
  const with_ = e.attendees.length ? ` <span ${MUTED}>with ${escHtml(e.attendees.slice(0, 3).join(", "))}${e.attendees.length > 3 ? "…" : ""}</span>` : "";
  const links = [e.prepLink ? a(e.prepLink, "prep doc") : "", e.meetLink ? a(e.meetLink, "join") : ""].filter(Boolean).join(" · ");
  return `${time} ${escHtml(e.summary)}${with_}${links ? ` — ${links}` : ""}`;
}
function teamHtml(label: string, t: TeamSection): string {
  const head = `<h3 ${H3}>${label}</h3>`;
  if (t.fromCache && !t.actions.length && !t.fetchedAt) return `${head}<p ${MUTED}>${label} unreachable — no activity report yet.</p>`;
  const stale = t.fromCache ? `<p ${MUTED}>${label} unreachable — showing what I had from ${escHtml(t.fetchedAt ?? "unknown")}.</p>` : "";
  return head + stale + ul(t.actions.map((x) => `${escHtml(x.text)}${x.link ? ` — ${a(x.link, "open")}` : ""}`), `Nothing new from ${label} since yesterday.`);
}

export function renderBriefHtml(m: BriefModel): string {
  const own = ownActionsOf(m);
  const body = [
    `<p style="margin:0 0 12px 0">Good morning, ${escHtml(OWNER_FIRST)}. One look at everything across CLARA and FRIDAY.</p>`,
    `<h2 ${H2}>Meetings today (${m.meetings.today.length})</h2>`,
    ul(m.meetings.today.map(meetingLiHtml), "Nothing on the calendar today."),
    `<h2 ${H2}>Tomorrow morning (${m.meetings.tomorrowAm.length})</h2>`,
    ul(m.meetings.tomorrowAm.map(meetingLiHtml), "Nothing before noon tomorrow."),
    ...(m.weather ? [`<h2 ${H2}>Weather</h2>`, `<p style="margin:0 0 8px 0">${escHtml(m.weather)}</p>`] : []),
    `<h2 ${H2}>Emails that need you (${m.emails.length})</h2>`,
    ul(m.emails.map((e) => `<strong>${escHtml(e.from)}</strong> — ${escHtml(e.subject)} <span ${MUTED}>— ${escHtml(e.why)}</span> — ${a(e.link, "open")}`), "Nothing waiting from a VIP."),
    ...(m.callsAndTexts ? [
      `<h2 ${H2}>Calls &amp; texts (${m.callsAndTexts.lines.length})</h2>`,
      ul(m.callsAndTexts.lines.map(escHtml), "Nobody called or texted your work phone."),
      ...(m.callsAndTexts.callbacks.length ? [`<h3 ${H3}>Call back</h3>`, ul(m.callsAndTexts.callbacks.map(escHtml), "")] : []),
    ] : []),
    `<h2 ${H2}>Prep for today (${m.prep.length})</h2>`,
    ul(m.prep.map((p) => `<strong>${escHtml(fmtTime(p.start))}</strong> ${escHtml(p.meeting)} — ${a(p.link, p.docName)}`), "No prep documents needed today."),
    `<h2 ${H2}>What the team did</h2>`,
    teamHtml("FRIDAY", m.team.friday),
    `<h3 ${H3}>CLARA</h3>`,
    ul(own.map(escHtml), "No autonomous actions in the last 24h."),
    `<h2 ${H2}>Questions for you (${m.waiting.length})</h2>`,
    m.waiting.length
      ? ul(m.waiting.map((w) => `${escHtml(w.question)}${w.age ? ` <span ${MUTED}>(waiting ${escHtml(w.age)})</span>` : ""}`), "") +
        `<p ${MUTED}>Reply to this email in plain words — for example "yes to the first one, hold the second".</p>`
      : `<p ${MUTED}>Nothing needs your decision.</p>`,
    ...(m.stillOpen?.length ? [`<h2 ${H2}>Still open (from memory)</h2>`, ul(m.stillOpen.map(escHtml), "")] : []),
    ...(m.prospecting ? [`<h2 ${H2}>Prospecting</h2>`, `<p>${escHtml(m.prospecting)}</p>`] : []),
    `<h2 ${H2}>Watch</h2>`,
    ul(m.watch.map(escHtml), "Nothing on the watch list."),
    `<h2 ${H2}>Batched (${m.batched.length})</h2>`,
    ul(m.batched.map(escHtml), "Queue is clear."),
    `<p ${MUTED}>Composed ${escHtml(m.now)}.</p>`,
  ].join("\n");
  return [
    `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escHtml(briefSubject(m))}</title></head>`,
    `<body style="margin:0;padding:16px;background:#ffffff;color:#1a1a1a;font-family:-apple-system,'Segoe UI',Roboto,sans-serif;font-size:15px;line-height:1.5">`,
    `<div style="max-width:640px;margin:0 auto">`,
    `<h1 style="font-size:20px;margin:0 0 4px 0">Morning brief — ${escHtml(m.date)}</h1>`,
    body,
    `</div></body></html>`,
  ].join("\n");
}

// Deterministic spoken fallback for the 08:30 call (the live script is an LLM rewrite of the
// markdown; this is what plays when the model is down). Plain prose, no markdown, no emoji, no
// codes, the owner's name at most once.
export function renderBriefSpoken(m: BriefModel): string {
  const parts: string[] = [];
  const list = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
  parts.push(`Good morning, ${OWNER_FIRST}. Here's your brief for ${new Date(`${m.date}T12:00:00`).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}.`);
  const today = m.meetings.today;
  if (!today.length) parts.push("Nothing on the calendar today.");
  else {
    parts.push(`You have ${today.length} meeting${today.length === 1 ? "" : "s"} today: ${list(today.slice(0, 4).map((e) => `${e.summary} at ${fmtTime(e.start)}`))}.`);
  }
  if (m.meetings.tomorrowAm.length) parts.push(`Tomorrow morning: ${list(m.meetings.tomorrowAm.slice(0, 3).map((e) => `${e.summary} at ${fmtTime(e.start)}`))}.`);
  if (m.weather) parts.push(`Weather: ${m.weather}.`);
  if (m.emails.length) parts.push(`${m.emails.length} email${m.emails.length === 1 ? " needs" : "s need"} your attention, from ${list(m.emails.slice(0, 3).map((e) => e.from))}.`);
  else parts.push("Nothing urgent in your inbox.");
  if (m.callsAndTexts) {
    const c = m.callsAndTexts;
    if (!c.lines.length) parts.push("Nobody called or texted your work phone.");
    else parts.push(`On your work phone, ${c.lines.length === 1 ? "one person" : `${c.lines.length} people`} called or texted.${c.callbacks.length ? ` You owe ${c.callbacks.length === 1 ? "a callback" : `${c.callbacks.length} callbacks`}, starting with ${c.callbacks[0].split(" — ")[0].split(":")[0]}.` : " Nothing needs a callback."}`);
  }
  if (m.prep.length) parts.push(`I prepared ${m.prep.length === 1 ? "a document" : `${m.prep.length} documents`} for ${list(m.prep.slice(0, 3).map((p) => p.meeting))}. ${m.prep.length === 1 ? "It's" : "They're"} in Google Drive under Clara, Prep, and linked in your email.`);
  const teamBits: string[] = [];
  for (const [label, t] of [["FRIDAY", m.team.friday]] as const) {
    if (t.actions.length) teamBits.push(`${label} ${t.actions.length === 1 ? "finished one thing" : `finished ${t.actions.length} things`}, including ${t.actions[0].text.split(" — ")[0].replace(/[.:;,\s]+$/, "")}`);
  }
  parts.push(teamBits.length ? `${list(teamBits)}.` : "Nothing new from FRIDAY overnight.");
  if (m.prospecting) parts.push(`Prospecting: ${m.prospecting}.`);
  if (m.waiting.length) parts.push(`${m.waiting.length === 1 ? "One thing needs" : `${m.waiting.length} things need`} your decision. First: ${m.waiting[0].question}`);
  else parts.push("Nothing needs your decision.");
  parts.push("What do you need from me?");
  return stripEmoji(parts.join(" ").replace(/\s+/g, " ").trim());
}
