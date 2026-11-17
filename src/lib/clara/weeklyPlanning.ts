// Clara — Wave 5 Sunday weekly PLANNING session (OS schedule `clara.weekly_planning`, Sun 18:30,
// shipped mode=off).
//
// A SUPERSET of composeWeeklyReview: the base review (week-ahead events, occasions, follow-ups)
// is composed by briefs.ts's own composer — called, not forked — and this module appends two
// planning sections:
//   1. Conflicts to resolve — the same pairwise-overlap rule alerts.ts's scanCalendarConflicts
//      applies, over the same work-calendar fetch (combinedUpcoming — work-only, business tasks
//      only), pointed at the coming 7 days. REPORT-ONLY: pre-flagged in the document, never paged
//      (the 30-min conflict scan owns notification).
//   2. Proposed priorities — open tasks ranked by due date (soonest first), then age (oldest
//      first) for the undated tail.
//
// SINGLE-OWNER RULE: the local Sunday 18:00 weekly-review job and the OS Sunday 18:30
// clara.weekly_planning schedule would otherwise both email the owner. CLARA_WEEKLY_OWNER (local|os,
// default local) picks exactly one: the OS handler no-ops when set to local; the local
// scheduler job stands down when set to os (one guard in its run function).

import { promises as fs } from "node:fs";
import path from "node:path";
import { loadConfig } from "./config";
import { composeWeeklyReview, type Brief } from "./briefs";
import { combinedUpcoming, type CalEvent } from "./ms-calendar";
import { listOpen as listOpenTasks, type Task } from "./tasks";

export type WeeklyOwner = "local" | "os";

/** Who delivers on Sundays: "local" (default) = the scheduler's weekly-review job;
 *  "os" = the OS clara.weekly_planning handler. Exactly one — never both. */
export function claraWeeklyOwner(): WeeklyOwner {
  return (process.env.CLARA_WEEKLY_OWNER ?? "local").trim().toLowerCase() === "os" ? "os" : "local";
}

/** Who delivers the DAILY morning brief: "local" (default) = the scheduler's morning-brief job
 *  (emails the owner); "os" = the OS clara.daily_owner_briefing handler (posts to the OS channel).
 *  Exactly one — never both. Set CLARA_DAILY_OWNER=os once the OS briefing schedule is active to
 *  stop the local email brief double-delivering. */
export function claraDailyOwner(): WeeklyOwner {
  return (process.env.CLARA_DAILY_OWNER ?? "local").trim().toLowerCase() === "os" ? "os" : "local";
}

export interface WeeklyPlanning {
  title: string;
  text: string; // full markdown: the weekly review + the three planning sections
  sections: {
    weekAheadEvents: number;    // event count in the base review's 7-day window
    conflicts: string[];        // pre-flagged overlap lines
    priorities: string[];       // ranked open-task lines
  };
  vaultPath: string;
  /** Brief-shaped for briefs.ts's exported deliverBrief (kind "weekly" — email via
   *  deliverToPrincipal, same formatting as the local Sunday review). */
  brief: Brief;
}

function isAllDay(e: CalEvent): boolean {
  return !e.start.includes("T"); // CalEvent flattens Google's date/dateTime split
}

function fmtWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

// The exact overlap rule scanCalendarConflicts uses (sorted timed events, pairwise sweep with
// early break), returned as lines instead of notifications.
export function findConflicts(events: CalEvent[]): string[] {
  const timed = events.filter((e) => !isAllDay(e)).sort((a, b) => a.start.localeCompare(b.start));
  const out: string[] = [];
  for (let i = 0; i < timed.length; i++) {
    for (let j = i + 1; j < timed.length; j++) {
      const a = timed[i], b = timed[j];
      const aStart = new Date(a.start).getTime(), aEnd = new Date(a.end).getTime();
      const bStart = new Date(b.start).getTime(), bEnd = new Date(b.end).getTime();
      if (bStart >= aEnd) break;                 // sorted — nothing later can overlap a
      if (!(aStart < bEnd && aEnd > bStart)) continue;
      out.push(`- ⚠️ **Double-booked** ${fmtWhen(a.start)}: "${a.summary}" ↔ "${b.summary}"`);
    }
  }
  return out;
}

// Due date first (soonest), undated after; ties and the undated tail by age (oldest open first).
export function rankTasks(tasks: Task[]): Task[] {
  return [...tasks].sort((a, b) => {
    if (a.dueAt && b.dueAt) return a.dueAt.localeCompare(b.dueAt) || a.createdAt.localeCompare(b.createdAt);
    if (a.dueAt) return -1;
    if (b.dueAt) return 1;
    return a.createdAt.localeCompare(b.createdAt);
  });
}

export async function composeWeeklyPlanning(now: Date = new Date()): Promise<WeeklyPlanning> {
  // Base review first — same composer the local Sunday job uses, reused wholesale.
  const base = await composeWeeklyReview(now);

  const [events, tasks] = await Promise.all([
    combinedUpcoming(7).catch(() => [] as CalEvent[]),  // same work-calendar fetch as the conflict scan, 7-day window
    listOpenTasks().catch(() => [] as Task[]),
  ]);

  const conflicts = findConflicts(events);
  const ranked = rankTasks(tasks);
  const nowMs = now.getTime();
  const priorities = ranked.slice(0, 10).map((t, i) => {
    const ageD = Math.max(0, Math.floor((nowMs - Date.parse(t.createdAt)) / 86_400_000));
    const due = t.dueAt ? `due ${new Date(t.dueAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}` : "no due date";
    return `${i + 1}. **${t.title}** — ${due} · open ${ageD}d${t.assignee && t.assignee !== "clara" ? ` · ${t.assignee}` : ""}`;
  });

  // Splice the planning sections in ahead of the base review's `---` footer.
  const footerIdx = base.markdown.lastIndexOf("\n---\n");
  const body = footerIdx > 0 ? base.markdown.slice(0, footerIdx) : base.markdown;
  const footer = footerIdx > 0 ? base.markdown.slice(footerIdx) : `\n---\n_Composed ${now.toISOString()}._`;

  const text = [
    body,
    ``,
    `## Conflicts to resolve this week (${conflicts.length})`,
    conflicts.length ? conflicts.join("\n") : "- No overlaps in the next 7 days.",
    ``,
    `## Proposed priorities (${Math.min(ranked.length, 10)} of ${ranked.length} open)`,
    priorities.length ? priorities.join("\n") : "- Nothing open. Enjoy it.",
    footer,
  ].join("\n");

  const cfg = await loadConfig();
  const dir = path.join(cfg.vaultRoot, "briefs");
  await fs.mkdir(dir, { recursive: true });
  const vaultPath = path.join(dir, `${base.date}-weekly-planning.md`);
  await fs.writeFile(vaultPath, text, "utf8");

  return {
    title: `Weekly planning — week of ${base.date}`,
    text,
    sections: {
      weekAheadEvents: events.length,
      conflicts,
      priorities,
    },
    vaultPath,
    brief: { kind: "weekly", date: base.date, markdown: text, vaultPath },
  };
}
