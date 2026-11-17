// Clara — morning / evening / weekly composers, plus the Wave-4 8am EXECUTIVE brief.
//
// W1: text-only, manual trigger.
// W2: pulls real calendar (work calendar only) and
//     unread VIP mail counts.
// W4 (this): the morning slot now composes the cross-agent executive brief — Today / Needs you
//            (her approvals merged with FRIDAY's) / Since yesterday (per-agent
//            autonomous actions) / Watch (anomalies) / Batched (both queues) — delivered by
//            email only (NO SMS headline), with a two-phase queue drain: peer + own queued items
//            are acked ONLY after the email actually sends. `composeMorningBrief` keeps its name
//            (the scheduler's morning job and /api/brief/morning import it) but now delegates to
//            `composeExecutiveBrief`; the pre-Wave-4 composer survives as
//            `composeClassicMorningBrief`.

import { promises as fs } from "node:fs";
import path from "node:path";
import { loadConfig } from "./config";
import { listOpen as listOpenTasks, isAgentTask, type Task } from "./tasks";
import { combinedUpcoming } from "./ms-calendar";
import { listUnreadInbox, sendMail, type GmailMessage } from "./ms-mail";
import { classify } from "./triage";
import { listOpen as listOpenFollowups } from "./followups";
import { researchTopic, generateAudioDigest } from "./research";
import { forecastDays, weatherAffectsDay, weatherConfigured } from "./weather";
import { listContacts } from "./contacts";
import { deliverToPrincipal } from "./deliver";
// Aliased — `classify` is already taken above by triage.ts's mail classifier.
import { classify as classifySensitivity } from "./sensitivity";
import { notifyOwner, removeQueued } from "./notify";
import { append as ledgerAppend } from "./ledger";
import { OWNER_FIRST } from "./owner";
import { ackPeerQueue } from "./briefPeers";
import { composeBriefModel, renderBriefMarkdown, renderBriefHtml, briefSubject, persistBriefModel, type BriefModel } from "./briefModel";
import { osClient, osEnabled } from "./osClient";

export type BriefKind = "morning" | "evening" | "weekly" | "executive";

export interface Brief {
  kind: BriefKind;
  date: string;
  markdown: string;
  vaultPath: string;
  // Executive brief only: the queued-notification ids this compose consumed, per source. The
  // two-phase drain acks these AFTER the email delivers — never on compose (the /brief page
  // re-composes on every view) and never on failed delivery (items must reappear next brief).
  drain?: { friday: string[]; own: string[] };
  // Executive brief only (2026-09-24): HTML alternative for the email, and the structured model
  // the 08:30 call and the /brief page read.
  html?: string;
  model?: BriefModel;
}

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function fmtTime(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}
function eventLine(e: { summary: string; start: string; end: string; attendees?: string[] }): string {
  const at = e.attendees?.length ? ` — with ${e.attendees.slice(0, 3).join(", ")}${e.attendees.length > 3 ? "…" : ""}` : "";
  return `- **${fmtTime(e.start)}–${fmtTime(e.end)}** ${e.summary}${at}`;
}

// Returns null when weather isn't configured, so the section is simply omitted rather than
// rendering an apology every morning.
async function weatherLine(): Promise<string | null> {
  if (!(await weatherConfigured())) return null;
  const f = await forecastDays(1);
  if (!f.ok || !f.days.length) return null;
  const d = f.days[0];
  const v = weatherAffectsDay(d);
  const base = `- ${d.description || d.conditionCode.toLowerCase()}, high ${d.highF}° / low ${d.lowF}°, ${d.precipProbPct}% precip`;
  return v.affects ? `${base}\n- **Worth planning around**: ${v.reason}` : base;
}

// Birthdays / anniversaries falling within the next `days` days, ignoring the stored year so a
// recurring date matches regardless of which year is recorded.
async function upcomingOccasions(now: Date, days: number): Promise<string[]> {
  const contacts = await listContacts().catch(() => []);
  const out: { label: string; inDays: number }[] = [];

  for (const c of contacts) {
    for (const [field, kind] of [["birthday", "birthday"], ["anniversary", "anniversary"]] as const) {
      const raw = c[field];
      if (!raw) continue;
      const m = raw.match(/^\d{4}-(\d{2})-(\d{2})$/);
      if (!m) continue;
      const month = Number(m[1]) - 1, day = Number(m[2]);
      let next = new Date(now.getFullYear(), month, day);
      next.setHours(0, 0, 0, 0);
      const today = new Date(now); today.setHours(0, 0, 0, 0);
      if (next < today) next = new Date(now.getFullYear() + 1, month, day);
      const inDays = Math.round((next.getTime() - today.getTime()) / 86_400_000);
      if (inDays <= days) {
        out.push({ label: `- **${c.name}** — ${kind} ${inDays === 0 ? "today" : inDays === 1 ? "tomorrow" : `in ${inDays} days`}`, inDays });
      }
    }
  }
  return out.sort((a, b) => a.inDays - b.inDays).map((o) => o.label);
}

async function writeToVault(kind: BriefKind, date: string, md: string): Promise<string> {
  const cfg = await loadConfig();
  const dir = path.join(cfg.vaultRoot, "briefs");
  await fs.mkdir(dir, { recursive: true });
  const p = path.join(dir, `${date}-${kind}.md`);
  await fs.writeFile(p, md, "utf8");
  return p;
}

// ── Classic morning brief (pre-Wave-4) ───────────────────────────────────
// Kept intact and exported: the executive brief supersedes it in the morning slot, but this is
// still the single-app composer (tasks/followups/VIP mail) for manual use and comparison. No
// scheduled job calls it anymore.
export async function composeClassicMorningBrief(now: Date = new Date()): Promise<Brief> {
  const date = ymd(now);
  const startOfDay = new Date(now); startOfDay.setHours(0, 0, 0, 0);
  const endOfDay   = new Date(now); endOfDay.setHours(23, 59, 59, 999);

  const [tasks, todayEvents, unreadRaw, followups, weather] = await Promise.all([
    listOpenTasks(),
    combinedUpcoming(1).catch(() => []),
    listUnreadInbox(50).catch(() => [] as GmailMessage[]),
    listOpenFollowups().catch(() => []),
    weatherLine().catch(() => null),
  ]);

  const today = todayEvents.filter((e) => {
    const t = new Date(e.start).getTime();
    return t >= startOfDay.getTime() && t <= endOfDay.getTime();
  });

  const vipMsgs: typeof unreadRaw = [];
  for (const m of unreadRaw) {
    const v = await classify(m).catch(() => "escalate" as const);
    if (v === "vip") vipMsgs.push(m);
  }

  const top3 = tasks.filter((t) => !isAgentTask(t)).slice(0, 3);
  const md = [
    `# Morning brief — ${date}`,
    ``,
    `Good morning, ${OWNER_FIRST}.`,
    ``,
    `## Today (${today.length})`,
    today.length ? today.map(eventLine).join("\n") : "- Nothing on the calendar. Rare.",
    ``,
    ...(weather ? [`## Weather`, weather, ``] : []),
    `## Needs you`,
    vipMsgs.length ? vipMsgs.slice(0, 5).map((m) => `- **${m.from.replace(/<.*>/, "").trim()}** — ${m.subject}`).join("\n") : "- No VIP mail waiting.",
    ``,
    `## Top priorities`,
    top3.length ? top3.map((t) => `- ${t.title}`).join("\n") : "- Nothing on the list yet.",
    ...inFlightLine(tasks),
    ``,
    `## Waiting on others`,
    followups.length ? followups.slice(0, 5).map((f) => `- ${f.what} — ${f.contact.name} (day ${f.nudgeCount} of chase)`).join("\n") : "- Nothing outstanding.",
    ``,
    `---`,
    `_Composed ${now.toISOString()}._`,
  ].join("\n");

  const vaultPath = await writeToVault("morning", date, md);
  return { kind: "morning", date, markdown: md, vaultPath };
}

// ── Executive brief (Wave 4 → model-based, 2026-09-24) ──────────────────
// The ONE daily 8am look across both agents. Peer data (FRIDAY's GET /api/friday/brief-section)
// and the last-good cache live in briefPeers.ts; the facts are
// assembled by briefModel.composeBriefModel and rendered three ways (markdown for the vault and the
// text/plain part, HTML for the email, spoken prose for the 08:30 call). The drain — queued ids
// consumed by this compose — is acked ONLY after the email delivers.
export async function composeExecutiveBrief(now: Date = new Date()): Promise<Brief> {
  const model = await composeBriefModel(now);
  const md = renderBriefMarkdown(model);
  const html = renderBriefHtml(model);
  const vaultPath = await writeToVault("executive", model.date, md);
  await persistBriefModel(model).catch(() => {});
  return { kind: "executive", date: model.date, markdown: md, vaultPath, drain: model.drain, html, model };
}

// The symbol the SCHEDULER's morning-brief job (and /api/brief/morning, and the OS
// daily_owner_briefing handler) imports. Wave 4 re-points it at the executive brief so the 8am
// slot ships the cross-agent view without any scheduler change; delegation (rather than a rename)
// keeps every existing import site working.
export async function composeMorningBrief(now: Date = new Date()): Promise<Brief> {
  return composeExecutiveBrief(now);
}

// ── Evening wind-down ────────────────────────────────────────────────────
export async function composeEveningBrief(now: Date = new Date()): Promise<Brief> {
  const date = ymd(now);
  const tomorrow = new Date(now); tomorrow.setDate(tomorrow.getDate() + 1);
  const startTom = new Date(tomorrow); startTom.setHours(0, 0, 0, 0);
  const endTom   = new Date(tomorrow); endTom.setHours(23, 59, 59, 999);

  const [tasks, upcoming] = await Promise.all([
    listOpenTasks(),
    combinedUpcoming(2).catch(() => []),
  ]);
  const tomEvents = upcoming.filter((e) => {
    const t = new Date(e.start).getTime();
    return t >= startTom.getTime() && t <= endTom.getTime();
  });
  const unresolved = tasks.filter((t) => t.status !== "done" && t.status !== "cancelled" && !isAgentTask(t));

  const md = [
    `# Evening wind-down — ${date}`,
    ``,
    `Winding down, ${OWNER_FIRST}.`,
    ``,
    `## Tomorrow (${tomEvents.length})`,
    tomEvents.length ? tomEvents.map(eventLine).join("\n") : "- Nothing scheduled.",
    ``,
    `## Unresolved from today`,
    unresolved.length ? unresolved.slice(0, 7).map((t) => `- ${t.title}`).join("\n") : "- Clean plate. Well done.",
    ...inFlightLine(tasks),
    ``,
    `---`,
    `_Composed ${now.toISOString()}._`,
  ].join("\n");
  const vaultPath = await writeToVault("evening", date, md);
  return { kind: "evening", date, markdown: md, vaultPath };
}

// ── Sunday weekly review ─────────────────────────────────────────────────
// Wave 6: the review carries the weekly AUTONOMY report — what each agent auto-executed, what
// shadow would have run, format grants/revokes, guardrail trips — composed by autonomyReport.ts
// (peer fetches degrade to "unreachable — skipped" lines; the section always renders). Appended
// HERE only: composeWeeklyPlanning() calls this composer and splices its planning sections ahead
// of the footer, so the autonomy section flows into the Sunday planning document automatically.
export async function composeWeeklyReview(now: Date = new Date()): Promise<Brief> {
  const date = ymd(now);
  const in7 = new Date(now.getTime() + 7 * 86_400_000);
  const [upcoming, followups, occasions, autonomySection] = await Promise.all([
    combinedUpcoming(7).catch(() => []),
    listOpenFollowups().catch(() => []),
    upcomingOccasions(now, 7).catch(() => [] as string[]),
    import("./autonomyReport")
      .then((m) => m.composeAutonomyReport(now))
      .catch(() => "## Autonomy report (last 7 days)\n- Report unavailable this week — skipped."),
  ]);

  const md = [
    `# Weekly review — week of ${date}`,
    ``,
    `Good evening, ${OWNER_FIRST}. Let's set up the week.`,
    ``,
    `## The week ahead (${upcoming.length} events)`,
    upcoming.slice(0, 20).map(eventLine).join("\n") || "- Nothing on the calendar.",
    ``,
    `## Birthdays & anniversaries this week`,
    occasions.length ? occasions.join("\n") : "- None this week.",
    ``,
    `## Still waiting on`,
    followups.length ? followups.map((f) => `- ${f.what} — ${f.contact.name} (nudge ${f.nudgeCount})`).join("\n") : "- Nothing outstanding.",
    ``,
    autonomySection,
    ``,
    `---`,
    `_Composed ${now.toISOString()}. Next review Sunday ${ymd(in7)}._`,
  ].join("\n");
  const vaultPath = await writeToVault("weekly", date, md);
  return { kind: "weekly", date, markdown: md, vaultPath };
}

// ── Delivery ─────────────────────────────────────────────────────────────
// Composing a brief used to be the whole job: it wrote markdown to the vault and told nobody, so
// the 07:00 scheduled brief landed silently and the owner only saw it if they happened to open the file.
//
// Called from the SCHEDULER, never from inside the composers — the /brief page re-composes on
// every view, and delivery-on-compose would email them a copy each time they looked at it.
function mdToPlain(md: string): string {
  return md
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/_(.+?)_/g, "$1")
    .replace(/^---$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// A one-line SMS pointer, counted straight off the composed markdown so it can't drift from it.
function headline(b: Brief): string {
  const count = (heading: string): number => {
    const m = b.markdown.match(new RegExp(`^## ${heading}[^\\n]*\\n([\\s\\S]*?)(?=\\n## |\\n---|$)`, "m"));
    if (!m) return 0;
    const lines = m[1].split("\n").filter((l) => l.trim().startsWith("- "));
    if (lines.length === 1 && /Nothing|None|No VIP|Clean plate/i.test(lines[0])) return 0;
    return lines.length;
  };
  const label = b.kind === "morning" ? "Morning brief" : b.kind === "evening" ? "Evening wind-down" : "Weekly review";
  const bits = b.kind === "morning"
    ? [`${count("Today")} event(s)`, `${count("Needs you")} needing you`, `${count("Top priorities")} priorities`]
    : b.kind === "evening"
      ? [`${count("Tomorrow")} tomorrow`, `${count("Unresolved from today")} unresolved`]
      : [`${count("The week ahead")} events`, `${count("Birthdays & anniversaries this week")} occasions`];
  return `${label}: ${bits.join(", ")}. Full copy in your inbox.`;
}

export async function deliverBrief(b: Brief): Promise<{ ok: boolean; error?: string }> {
  // Wave 4: the executive brief is email-only — NO SMS headline (the whole point of the 8am model
  // is one artifact, zero phone buzzes) — and delivery success is what authorizes the queue drain.
  if (b.kind === "executive") return deliverExecutiveBrief(b);
  const title = b.kind === "morning" ? `Morning brief — ${b.date}`
    : b.kind === "evening" ? `Evening wind-down — ${b.date}`
    : `Weekly review — week of ${b.date}`;
  return deliverToPrincipal("owner", title, mdToPlain(b.markdown), headline(b));
}

// Executive delivery: email the full brief, then — ONLY on a successful send — run the two-phase
// drain (ack each peer's consumed queue ids + clear her own) so a failed delivery leaves every
// queue intact and the items reappear in the next brief. In-app needs no delivery step: the
// /brief page re-composes on view.
async function deliverExecutiveBrief(b: Brief): Promise<{ ok: boolean; error?: string }> {
  const cfg = await loadConfig();
  const email = cfg.principals.owner.emails[0];
  if (!email) return { ok: false, error: "no email on file for the owner" };
  const subject = b.model ? briefSubject(b.model) : `Your 8am brief — ${b.date}`;
  const r = await sendMail({ to: email, subject, body: mdToPlain(b.markdown), ...(b.html ? { html: b.html } : {}) })
    .catch((e) => ({ ok: false as const, error: String(e) }));
  if (!r.ok) return { ok: false, error: ("error" in r && r.error) || "email send failed" };

  // Delivery succeeded — drain. Each leg is best-effort and independent: a peer that died between
  // compose and ack keeps its items (they re-render next brief; its own 24h digest is the backstop).
  const ackF = await ackPeerQueue("friday", b.drain?.friday);

  const fmtAck = (a: { sent: number; removed: number | null; ok: boolean }) =>
    a.sent === 0 ? "0" : a.ok ? `${a.removed ?? "?"}/${a.sent}` : `FAILED (${a.sent} left queued)`;
  console.log(`[clara/briefs] acked FRIDAY ${fmtAck(ackF)}`);
  if (b.drain?.own.length) await removeQueued(b.drain.own).catch(() => {});

  // The brief's "Questions for you" are now ASKED (decisions.ts): each gets a brief-channel ask
  // record so a reply to this email, or "yes" on the 08:30 call, resolves against it.
  if (b.model?.waiting.length) {
    const { markAsked } = await import("./decisions");
    for (const w of b.model.waiting) await markAsked(w.id, "brief", `brief:${b.date}`, { pointer: false, question: w.question }).catch(() => {});
    // The single most urgent one is the open question on email — the reply channel for a brief.
    await markAsked(b.model.waiting[0].id, "email", `brief:${b.date}`, { question: b.model.waiting[0].question }).catch(() => {});
  }

  // orion surface: one "daily_brief" bell row for the owner (notifications_create is allowlisted for
  // CLARA since 2026-09-24). Best-effort — the email is the delivery; this is a pointer.
  if (osEnabled()) {
    try {
      const who = await osClient.callTool("agent_whoami", {});
      const first = Array.isArray(who) ? who.find((c) => c && typeof c === "object" && "text" in (c as object)) as { text?: string } | undefined : undefined;
      const parsed = first?.text ? (JSON.parse(first.text) as { user_id?: string }) : (who as { user_id?: string });
      if (parsed?.user_id) {
        await osClient.callTool("notifications_create", {
          user_id: parsed.user_id,
          type: "daily_brief",
          title: `Your morning brief is ready — ${b.date}`,
          body: subject,
          link: `${process.env.OFFICE_PUBLIC_URL ?? "https://office.example.com"}/brief-full`,
          metadata: { date: b.date, counts: b.model?.counts ?? null },
        });
      }
    } catch (e) {
      console.log(`[clara/briefs] orion daily_brief notification skipped — ${String((e as Error).message ?? e).slice(0, 120)}`);
    }
  }

  await ledgerAppend({
    kind: "action",
    actor: "clara",
    what: `delivered executive brief ${b.date} (email only, no SMS; drained ${b.drain?.own.length ?? 0} own + ${b.drain?.friday.length ?? 0} FRIDAY queued item(s))`,
    meta: { brief: b.date, drain: b.drain },
  }).catch(() => {});
  {
    const { recordOutcome } = await import("./vaultMemory");
    await recordOutcome({ thread: `brief-${b.date}`, kind: "brief", status: "done", title: `Morning brief ${b.date}`,
      done: `Emailed: ${subject}`, links: b.vaultPath ? [b.vaultPath] : [] }).catch(() => {});
  }
  return { ok: true };
}

// A brief is not uniformly safe to ship to a cloud service: it stitches together calendar entries,
// task titles, and VIP mail subjects, any one of which can be a lab result, a legal matter, or a
// cap-table line. Every other cloud path in Clara runs through the sensitivity gate; this one used
// to upload the whole document unclassified. Split on the `## ` section headings the composers
// already emit (the same shape headline() parses), classify each, and drop the sensitive ones.
//
// Section-level rather than whole-document because whole-document is all-or-nothing: one medical
// appointment would otherwise kill the entire digest.
export function gateBriefForCloud(markdown: string): { text: string; withheld: string[]; keptSections: number } {
  const parts = markdown.split(/\n(?=## )/);
  const kept: string[] = [];
  const withheld: string[] = [];
  let keptSections = 0;
  for (const part of parts) {
    // The leading chunk is the `# Title` / date preamble — no content of its own, always keep it.
    if (!part.startsWith("## ")) { kept.push(part); continue; }
    const heading = part.slice(3).split("\n", 1)[0].trim();
    if (classifySensitivity({ text: part }).sensitive) withheld.push(heading);
    else { kept.push(part); keptSections++; }
  }
  return { text: kept.join("\n"), withheld, keptSections };
}

// Spoken version of the weekly review: the brief is rewritten into a narration script by
// synthesized from the week's brief, parallel to the plain ElevenLabs read-aloud used elsewhere.
// Clara's own brain, then narrated with ElevenLabs. No external session to keep alive.
export async function composeWeeklyAudioDigest(
  brief: Brief,
): Promise<{ ok: boolean; path?: string; error?: string; withheld?: string[] }> {
  const { text, withheld, keptSections } = gateBriefForCloud(brief.markdown);

  if (keptSections === 0) {
    const reason = withheld.length
      ? `every section classified as sensitive (${withheld.join(", ")})`
      : "the brief had no content sections";
    await notifyOwner({
      kind: "briefs.audio",
      priority: "low",
      text: `Skipped this week's audio digest — ${reason}, so there was nothing safe to narrate.`,
      dedupeKey: `briefs:audio:skipped:${brief.date}`,
    }).catch(() => {});
    return { ok: false, error: `audio digest skipped — ${reason}`, withheld };
  }

  // Telling the narration what's missing is the point: a digest that's quietly short reads as
  // "nothing happened this week", which is worse than saying a section was held back.
  const source = withheld.length
    ? `${text}\n\n## Withheld from this digest\nThese sections were deliberately withheld for privacy and are NOT included above: ${withheld.join(", ")}. Note briefly that they were withheld; do not speculate about their contents.`
    : text;

  const research = await researchTopic({
    title: `Weekly review — ${brief.date}`,
    sources: [source],
    question: withheld.length
      ? "Rewrite this as a brief, upbeat spoken overview of my week ahead — what's coming up, what's outstanding, and what I should be thinking about. Mention in one sentence that some sections were withheld for privacy. Plain prose only: no markdown, headings or bullets, because this is read aloud."
      : "Rewrite this as a brief, upbeat spoken overview of my week ahead — what's coming up, what's outstanding, and what I should be thinking about. Plain prose only: no markdown, headings or bullets, because this is read aloud.",
  });
  // The answer IS the narration script now. NotebookLM used to take the sources and generate
  // a two-host audio overview from them; ElevenLabs reads exactly what it is given, so the
  // spoken-friendly rewrite has to happen here rather than inside the audio step.
  if (!research.ok || !research.answer) {
    return { ok: false, error: research.error ?? "could not compose the narration script", withheld };
  }

  const cfg = await loadConfig();
  const outPath = path.join(cfg.vaultRoot, "briefs", `${brief.date}-weekly.mp3`);
  const audio = await generateAudioDigest({
    prompt: research.answer,
    format: "brief",
    outPath,
  });
  return { ...audio, withheld };
}

// Work Clara handed to FRIDAY (from meeting digests) — tracked on her book, not the owner's list.
function inFlightLine(tasks: Task[]): string[] {
  const f = tasks.filter((t) => t.assignee === "friday").length;
  return f ? [`- _In flight with FRIDAY: ${f}_`] : [];
}
