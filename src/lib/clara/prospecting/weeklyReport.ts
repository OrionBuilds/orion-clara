// weeklyReport.ts — PR 16: the Monday 07:45 "Prospecting — week of …" Drive doc (plan §7/Part 6),
// emailed via deliverToPrincipal with a summary + link, same delivery shape as
// report/deliver.ts's per-job report and promote.ts's per-company research doc.

import { prospectDailyStats as prospectDailyStatsReal } from "./osBridge";
import { ensureFolder as ensureFolderReal, createFile as createFileReal } from "../ms-files";
import { deliverToPrincipal as deliverToPrincipalReal } from "../deliver";
import { loadConfig as loadConfigReal } from "../config";

/** Pure: the Monday of the week containing `now` (ISO date, local-agnostic — just calendar
 *  arithmetic), formatted for the doc title "Prospecting — week of {date}". */
export function weekOfMonday(now: Date): string {
  const d = new Date(now);
  const day = d.getDay(); // 0=Sun..6=Sat
  const diffToMonday = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diffToMonday);
  return d.toISOString().slice(0, 10);
}

export interface WeeklyReportStats {
  companies_total: number;
  match_icp: number;
  strong_signals_30d: number;
  new_companies: number;
  new_signals: number;
  sent: number;
  replies: number;
  replies_interested: number;
  booked: number;
  unsubscribed: number;
  bounced: number;
  active_enrollments: number;
  spend_since: number;
}

/** Pure. One compact summary line, same density as the plan's own worked example
 *  ("1,842 match ICP · 217 strong signals · 38 sent · 12 replies (4 interested) · 3 booked · ..."). */
export function composeWeeklySummaryLine(stats: WeeklyReportStats): string {
  return [
    `${stats.match_icp.toLocaleString()} match ICP`,
    `${stats.strong_signals_30d.toLocaleString()} strong signals`,
    `${stats.sent.toLocaleString()} sent`,
    `${stats.replies.toLocaleString()} replies (${stats.replies_interested} interested)`,
    `${stats.booked.toLocaleString()} booked`,
  ].join(" · ");
}

export function composeWeeklyReportBody(weekOf: string, stats: WeeklyReportStats): string {
  const lines = [
    `Prospecting — week of ${weekOf}`,
    "",
    composeWeeklySummaryLine(stats),
    "",
    `Companies tracked: ${stats.companies_total.toLocaleString()} (${stats.new_companies} new this week)`,
    `Signals: ${stats.new_signals} new this week`,
    `Outreach: ${stats.sent} sent, ${stats.replies} replies, ${stats.booked} booked, ${stats.unsubscribed} unsubscribed, ${stats.bounced} bounced`,
    `Active sequence enrollments: ${stats.active_enrollments}`,
    `Spend this week: $${stats.spend_since.toFixed(2)}`,
  ];
  return lines.join("\n");
}

export interface WeeklyReportDeps {
  prospectDailyStats: typeof prospectDailyStatsReal;
  ensureFolder: typeof ensureFolderReal;
  createFile: typeof createFileReal;
  deliverToPrincipal: typeof deliverToPrincipalReal;
  loadConfig: typeof loadConfigReal;
  now: () => Date;
}
export const defaultWeeklyReportDeps: WeeklyReportDeps = {
  prospectDailyStats: prospectDailyStatsReal,
  ensureFolder: ensureFolderReal,
  createFile: createFileReal,
  deliverToPrincipal: deliverToPrincipalReal,
  loadConfig: loadConfigReal,
  now: () => new Date(),
};

export interface WeeklyReportResult {
  ok: boolean;
  docUrl?: string;
  error?: string;
}

export async function deliverWeeklyProspectingReport(deps: WeeklyReportDeps = defaultWeeklyReportDeps): Promise<WeeklyReportResult> {
  const now = deps.now();
  const weekOf = weekOfMonday(now);
  const sinceIso = new Date(now.getTime() - 7 * 86_400_000).toISOString();

  const stats = await deps.prospectDailyStats(sinceIso).catch(() => undefined);
  if (!stats) return { ok: false, error: "prospect_daily_stats unavailable" };

  const body = composeWeeklyReportBody(weekOf, stats);
  const cfg = await deps.loadConfig();
  const folder = await deps.ensureFolder("Prospecting", cfg.claraDriveId || undefined);
  const doc = await deps.createFile({ name: `Prospecting — week of ${weekOf}`, content: body, as: "doc", folderId: folder?.id });

  const summaryLine = composeWeeklySummaryLine(stats);
  const emailBody = [body, "", doc.file?.webViewLink ? `Full report: ${doc.file.webViewLink}` : ""].filter(Boolean).join("\n");
  const headsUp = `Weekly prospecting report: ${summaryLine}`;
  const delivered = await deps.deliverToPrincipal("owner", `Prospecting — week of ${weekOf}`, emailBody, headsUp);

  return { ok: delivered.ok, docUrl: doc.file?.webViewLink, error: delivered.ok ? undefined : delivered.error };
}
