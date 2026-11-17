// Clara — proactive alerts: the things that should reach the owner without them asking.
//
// Why this file has its own dedupe store instead of leaning on notify.ts: notify's dedupe is a
// 90-second in-memory Map, sized for "don't double-send the same page in one burst". These scans
// re-run every 15–60 minutes and would re-detect the same calendar conflict every single pass, and
// the in-memory map is wiped on every restart. So alert suppression needs to be durable and
// measured in hours, keyed per finding. The same key is still passed to notifyOwner as a backstop.

import { promises as fs } from "node:fs";
import path from "node:path";
import { loadConfig } from "./config";
import { notifyOwner } from "./notify";
import { combinedUpcoming, type CalEvent } from "./ms-calendar";
import { listOpen as listOpenTasks } from "./tasks";
import { forecastDays, weatherAffectsDay, weatherConfigured } from "./weather";
import { mfetch } from "./ms-auth";
import { append as ledgerAppend } from "./ledger";

interface AlertState {
  [key: string]: { firstSeen: string; lastSent: string; cursor?: string };
}

async function stateFile(): Promise<string> {
  const cfg = await loadConfig();
  await fs.mkdir(cfg.dataDir, { recursive: true });
  return path.join(cfg.dataDir, "alert-state.json");
}

async function loadState(): Promise<AlertState> {
  try { return JSON.parse(await fs.readFile(await stateFile(), "utf8")) as AlertState; }
  catch { return {}; }
}

async function saveState(s: AlertState): Promise<void> {
  const f = await stateFile();
  const tmp = `${f}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(s, null, 2), "utf8").catch(() => {});
  await fs.rename(tmp, f).catch(() => {});
}

// Prunes anything untouched for a week so the file can't grow without bound.
function prune(s: AlertState): AlertState {
  const cutoff = Date.now() - 7 * 86_400_000;
  return Object.fromEntries(Object.entries(s).filter(([, v]) => new Date(v.lastSent).getTime() > cutoff));
}

// Rollup dedupe window: each scan sends at most one notify per run, keyed to the hour so a
// crashed-and-rerun scan can't double-send within the same pass.
const hourKey = (d: Date) => d.toISOString().slice(0, 13);

export async function shouldFire(key: string, ttlHours: number): Promise<boolean> {
  const s = await loadState();
  const prev = s[key];
  const now = Date.now();
  if (prev && now - new Date(prev.lastSent).getTime() < ttlHours * 3_600_000) return false;
  const iso = new Date(now).toISOString();
  s[key] = { firstSeen: prev?.firstSeen ?? iso, lastSent: iso, cursor: prev?.cursor };
  await saveState(prune(s));
  return true;
}

async function getCursor(key: string): Promise<string | undefined> {
  return (await loadState())[key]?.cursor;
}
async function setCursor(key: string, cursor: string): Promise<void> {
  const s = await loadState();
  const iso = new Date().toISOString();
  s[key] = { firstSeen: s[key]?.firstSeen ?? iso, lastSent: s[key]?.lastSent ?? iso, cursor };
  await saveState(s);
}

// ── 1. Calendar conflicts ────────────────────────────────────────────────
// Pure local logic over the work calendar — no extra API call.
function isAllDay(e: CalEvent): boolean {
  // CalEvent flattens Google's date/dateTime split; an all-day event has no time component.
  return !e.start.includes("T");
}

export async function scanCalendarConflicts(now: Date = new Date()): Promise<{ found: number; alerted: number }> {
  const events = (await combinedUpcoming(2).catch(() => [] as CalEvent[]))
    .filter((e) => !isAllDay(e))
    .sort((a, b) => a.start.localeCompare(b.start));

  let found = 0, alerted = 0;
  const rollup: string[] = [];
  for (let i = 0; i < events.length; i++) {
    for (let j = i + 1; j < events.length; j++) {
      const a = events[i], b = events[j];
      const aStart = new Date(a.start).getTime(), aEnd = new Date(a.end).getTime();
      const bStart = new Date(b.start).getTime(), bEnd = new Date(b.end).getTime();
      if (bStart >= aEnd) break;                 // sorted — nothing later can overlap a
      if (!(aStart < bEnd && aEnd > bStart)) continue;
      found++;

      const sameOwner = a.calendarOwner === b.calendarOwner;
      const minsAway = Math.round((Math.min(aStart, bStart) - now.getTime()) / 60_000);
      if (minsAway < -60) continue;              // already well underway; nothing to warn about

      const key = `conflict:${[a.id, b.id].sort().join("+")}`;
      if (!(await shouldFire(key, 24))) continue;

      const imminent = minsAway >= 0 && minsAway <= 60;
      const label = sameOwner ? "Double-booked" : "Calendar overlap";
      const text = `${label}: "${a.summary}" and "${b.summary}" overlap${imminent ? ` — starts in ${minsAway} min` : ""}.`;
      if (imminent) {
        // Genuinely time-critical — the only finding class that still pages individually.
        await notifyOwner({ kind: "calendar.conflict", priority: "critical", dedupeKey: key, text }).catch(() => {});
      } else {
        rollup.push(text);
      }
      alerted++;
    }
  }
  if (rollup.length) {
    await notifyOwner({
      kind: "calendar.conflict",
      priority: "normal",
      dedupeKey: `scan:conflicts:${hourKey(now)}`,
      text: rollup.length === 1 ? rollup[0] : `${rollup.length} calendar conflicts:\n` + rollup.map((t) => `- ${t}`).join("\n"),
    }).catch(() => {});
  }
  return { found, alerted };
}

// ── 2. Task deadlines ────────────────────────────────────────────────────
export async function scanTaskDeadlines(now: Date = new Date()): Promise<{ alerted: number }> {
  const tasks = await listOpenTasks().catch(() => []);
  let alerted = 0;
  const rollup: string[] = [];

  for (const t of tasks) {
    if (!t.dueAt) continue;
    const due = new Date(t.dueAt).getTime();
    if (Number.isNaN(due)) continue;
    const hoursOut = (due - now.getTime()) / 3_600_000;

    // One alert per bucket, so a task nags at most three times over its life.
    const bucket = hoursOut < 0 ? "overdue" : hoursOut <= 2 ? "2h" : hoursOut <= 24 ? "24h" : null;
    if (!bucket) continue;

    const key = `task-due:${t.id}:${bucket}`;
    if (!(await shouldFire(key, 24 * 30))) continue;

    const when = bucket === "overdue" ? "is overdue" : bucket === "2h" ? "is due within 2 hours" : "is due tomorrow";
    rollup.push(`"${t.title}" ${when}.`);
    alerted++;
  }
  if (rollup.length) {
    // One notify per run no matter how many deadlines hit — 40 overdue tasks is one SMS, not 40.
    // Never critical — a task shouldn't punch through quiet hours.
    await notifyOwner({
      kind: "task.deadline",
      priority: "normal",
      dedupeKey: `scan:task-deadlines:${hourKey(now)}`,
      text: rollup.length === 1 ? rollup[0] : `${rollup.length} task deadlines need you:\n` + rollup.map((t) => `- ${t}`).join("\n"),
    }).catch(() => {});
  }
  return { alerted };
}

// ── 3. Weather that actually changes the day ─────────────────────────────
// Bad weather only matters if the owner has to physically be somewhere. Gating on an in-person event
// is what keeps this from becoming a daily forecast nobody reads.
export async function scanWeather(now: Date = new Date()): Promise<{ alerted: number; skipped?: string }> {
  if (!(await weatherConfigured())) return { alerted: 0, skipped: "weather not configured" };

  const f = await forecastDays(1);
  if (!f.ok || !f.days.length) return { alerted: 0, skipped: f.error ?? "no forecast" };
  const today = f.days[0];
  const verdict = weatherAffectsDay(today);
  if (!verdict.affects) return { alerted: 0 };

  const startOfDay = new Date(now); startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(now); endOfDay.setHours(23, 59, 59, 999);
  const events = (await combinedUpcoming(1).catch(() => [] as CalEvent[])).filter((e) => {
    const t = new Date(e.start).getTime();
    return t >= startOfDay.getTime() && t <= endOfDay.getTime() && t >= now.getTime();
  });
  // A video call is unaffected by rain — only events with no Meet link mean leaving the house.
  const inPerson = events.filter((e) => !e.hangoutLink && !isAllDay(e));
  if (!inPerson.length) return { alerted: 0, skipped: "no in-person events left today" };

  const key = `weather:${today.date}:${today.conditionCode}`;
  if (!(await shouldFire(key, 12))) return { alerted: 0 };

  const next = inPerson[0];
  await notifyOwner({
    kind: "weather",
    priority: "normal",
    dedupeKey: key,
    text: `Heads up — ${verdict.reason}. You've got ${inPerson.length} in-person thing${inPerson.length > 1 ? "s" : ""} today, next is "${next.summary}".`,
  }).catch(() => {});
  return { alerted: 1 };
}

// ── 4. SharePoint drive activity ────────────────────────────────────────
//
// GRAPH REWRITE, not a mechanical port — Google's Drive Activity API (`activity:query`, a single
// drive-wide, time-filtered, typed activity log) has no Graph equivalent. Graph instead splits
// this into two primitives: delta query (which items changed, via an opaque cursor token — not a
// timestamp) and per-item activity records (who did what to one specific item). This rebuilds the
// same external behavior — the owner gets alerted about comments/shares/edits that aren't their own —
// by chaining them: delta finds WHAT changed, then one activities call per changed item finds WHO
// changed it and HOW.
//
// Known differences from the Google version, stated plainly:
//  - The cursor is now an opaque Graph delta token/link, not an ISO timestamp — `since` semantics
//    (24h-ago default) don't apply. On the very FIRST run (no stored cursor), delta returns the
//    entire drive as "changed" — alerting on all of it would be noise, not news — so the first
//    run silently establishes a baseline (stores the resulting deltaLink, alerts on nothing) and
//    only the runs after that report real changes. This is an intentional, one-time behavior
//    difference, not a bug.
//  - "isSelf" now compares against the Microsoft identity this token belongs to (resolved once via
//    /me), same mechanism as the Google version's `isCurrentUser` (which was never actually
//    The owner's identity either — Drive access here has always run through Clara's own connected
//    account, not the owner's).
//  - Capped to the first 50 changed, non-folder items per run (matching the old pageSize:50) to
//    bound the extra per-item /activities calls delta's drive-wide nature can otherwise trigger.
interface GraphActivity {
  activityDateTime?: string;
  actor?: { user?: { id?: string; displayName?: string } };
  action?: { comment?: unknown; share?: unknown; edit?: unknown; create?: unknown; rename?: unknown; move?: unknown; version?: unknown; restore?: unknown };
}

function actionLabel(action?: GraphActivity["action"]): "comment" | "edit" | "permission" | null {
  if (!action) return null;
  if ("comment" in action) return "comment";
  if ("share" in action) return "permission";
  if ("edit" in action || "create" in action || "rename" in action || "move" in action || "version" in action || "restore" in action) return "edit";
  return null;
}

let selfUserId: string | null = null;
async function resolveSelfUserId(): Promise<string | null> {
  if (selfUserId) return selfUserId;
  try {
    const r = await mfetch("https://graph.microsoft.com/v1.0/me?$select=id", {}, "work");
    if (!r.ok) return null;
    selfUserId = ((await r.json()) as { id?: string }).id ?? null;
    return selfUserId;
  } catch { return null; }
}

export async function scanDriveActivity(): Promise<{ alerted: number; skipped?: string }> {
  const cursorKey = "drive-activity:cursor";
  const cursor = await getCursor(cursorKey);
  const { driveBase } = await import("./ms-files");

  let base: string;
  try { base = await driveBase("work"); } catch (e) { return { alerted: 0, skipped: String((e as Error).message ?? e) }; }

  type Changed = { id: string; name: string; folder?: unknown; deleted?: unknown };
  const changed: Changed[] = [];
  let deltaLink: string | undefined;
  try {
    let url: string | null = cursor ?? `${base}/root/delta?$select=id,name,folder,deleted`;
    while (url) {
      const r = await mfetch(url, {}, "work");
      if (!r.ok) return { alerted: 0, skipped: `delta ${r.status}` };
      const j = await r.json() as { value?: Changed[]; "@odata.nextLink"?: string; "@odata.deltaLink"?: string };
      changed.push(...(j.value ?? []));
      url = j["@odata.nextLink"] ?? null;
      if (j["@odata.deltaLink"]) deltaLink = j["@odata.deltaLink"];
    }
  } catch (e) {
    return { alerted: 0, skipped: String((e as Error).message ?? e) };
  }

  // First run ever (no stored cursor): delta just enumerated the WHOLE drive as "changed", which
  // is a baseline, not news. Store the cursor and stop — real detection starts next run.
  if (!cursor) {
    if (deltaLink) await setCursor(cursorKey, deltaLink);
    return { alerted: 0, skipped: "baseline established" };
  }

  const self = await resolveSelfUserId();
  let alerted = 0;
  const rollup: { text: string; kind: "comment" | "edit" | "permission" }[] = [];
  const candidates = changed.filter((c) => !c.folder && !c.deleted).slice(0, 50);

  for (const item of candidates) {
    let activities: GraphActivity[];
    try {
      const r = await mfetch(`${base}/items/${encodeURIComponent(item.id)}/activities?$top=1`, {}, "work");
      if (!r.ok) continue;
      activities = ((await r.json()) as { value?: GraphActivity[] }).value ?? [];
    } catch { continue; }
    const a = activities[0];
    if (!a) continue;

    if (self && a.actor?.user?.id === self) continue; // Clara's own change — not news
    const kind = actionLabel(a.action);
    if (!kind) continue;

    const name = item.name || "a file";
    const key = `drive-act:${a.activityDateTime ?? ""}:${item.id}`;
    if (!(await shouldFire(key, 24))) continue;

    const text = kind === "comment" ? `New comment on "${name}".`
      : kind === "permission" ? `Sharing changed on "${name}".`
      : `Someone edited "${name}".`;
    rollup.push({ text, kind });
    alerted++;
  }
  if (rollup.length) {
    // One notify per run. Plain edits batch into the 08:00 digest; a batch containing any
    // comment or share change wants attention sooner — same split as the old per-item sends.
    await notifyOwner({
      kind: "drive.activity",
      priority: rollup.every((r) => r.kind === "edit") ? "low" : "normal",
      dedupeKey: `scan:drive:${hourKey(new Date())}`,
      text: rollup.length === 1 ? rollup[0].text : `${rollup.length} Drive updates:\n` + rollup.map((r) => `- ${r.text}`).join("\n"),
    }).catch(() => {});
  }

  if (deltaLink) await setCursor(cursorKey, deltaLink);
  return { alerted };
}

// Runner used by the scheduler — one job, all four scans, each isolated so one failure can't
// take the others down with it.
export async function runAlertScans(now: Date = new Date()): Promise<Record<string, unknown>> {
  const [conflicts, deadlines, weather, drive] = await Promise.all([
    scanCalendarConflicts(now).catch((e) => ({ error: String((e as Error).message ?? e) })),
    scanTaskDeadlines(now).catch((e) => ({ error: String((e as Error).message ?? e) })),
    scanWeather(now).catch((e) => ({ error: String((e as Error).message ?? e) })),
    scanDriveActivity().catch((e) => ({ error: String((e as Error).message ?? e) })),
  ]);
  const summary = { conflicts, deadlines, weather, drive };
  await ledgerAppend({ kind: "action", actor: "clara", what: "alert scan", meta: summary }).catch(() => {});
  return summary;
}
