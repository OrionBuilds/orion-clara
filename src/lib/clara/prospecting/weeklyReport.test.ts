import { test } from "node:test";
import assert from "node:assert/strict";
import {
  weekOfMonday, composeWeeklySummaryLine, composeWeeklyReportBody, deliverWeeklyProspectingReport,
  type WeeklyReportStats, type WeeklyReportDeps,
} from "./weeklyReport";

function stats(overrides: Partial<WeeklyReportStats> = {}): WeeklyReportStats {
  return {
    companies_total: 1842, match_icp: 1842, strong_signals_30d: 217, new_companies: 40, new_signals: 60,
    sent: 38, replies: 12, replies_interested: 4, booked: 3, unsubscribed: 1, bounced: 2, active_enrollments: 55, spend_since: 23.5,
    ...overrides,
  };
}

test("weekOfMonday: a Wednesday resolves to the preceding Monday", () => {
  assert.equal(weekOfMonday(new Date("2026-01-07T15:00:00Z")), "2026-01-05"); // Wed Jan 7 -> Mon Jan 5
});
test("weekOfMonday: a Monday resolves to itself", () => {
  assert.equal(weekOfMonday(new Date("2026-01-05T07:45:00Z")), "2026-01-05");
});
test("weekOfMonday: a Sunday resolves to the Monday 6 days earlier (end of that week)", () => {
  assert.equal(weekOfMonday(new Date("2026-01-11T12:00:00Z")), "2026-01-05");
});

test("composeWeeklySummaryLine: matches the plan's own worked-example density/format", () => {
  const line = composeWeeklySummaryLine(stats());
  assert.equal(line, "1,842 match ICP · 217 strong signals · 38 sent · 12 replies (4 interested) · 3 booked");
});

test("composeWeeklyReportBody: includes the title, summary line, and every stat", () => {
  const body = composeWeeklyReportBody("2026-01-05", stats());
  assert.match(body, /^Prospecting — week of 2026-01-05/);
  assert.match(body, /1,842 match ICP/);
  assert.match(body, /40 new this week/);
  assert.match(body, /\$23\.50/);
  assert.match(body, /55/);
});

function deps(overrides: Partial<WeeklyReportDeps> = {}): WeeklyReportDeps {
  return {
    prospectDailyStats: async () => stats() as never,
    ensureFolder: async (name) => ({ id: `folder_${name}`, name, mimeType: "application/vnd.google-apps.folder" } as never),
    createFile: async () => ({ ok: true, file: { id: "f1", name: "doc", webViewLink: "https://drive.google.com/doc/weekly", mimeType: "application/vnd.google-apps.document" } } as never),
    deliverToPrincipal: async () => ({ ok: true }),
    loadConfig: async () => ({ claraDriveId: "root" } as never),
    now: () => new Date("2026-01-07T07:45:00Z"),
    ...overrides,
  };
}

test("deliverWeeklyProspectingReport: creates the Drive doc named 'Prospecting — week of {Monday}' and emails it", async () => {
  let createArgs: { name: string } | undefined;
  let emailSubject = "";
  const d = deps({
    createFile: async (input) => { createArgs = input; return { ok: true, file: { id: "f1", name: "doc", webViewLink: "https://x/doc", mimeType: "application/vnd.google-apps.document" } } as never; },
    deliverToPrincipal: async (_p, subject) => { emailSubject = subject; return { ok: true }; },
  });
  const r = await deliverWeeklyProspectingReport(d);
  assert.equal(r.ok, true);
  assert.equal(createArgs?.name, "Prospecting — week of 2026-01-05");
  assert.equal(emailSubject, "Prospecting — week of 2026-01-05");
  assert.equal(r.docUrl, "https://x/doc");
});

test("deliverWeeklyProspectingReport: prospect_daily_stats unavailable fails cleanly without touching Drive/email", async () => {
  let driveCalled = false;
  const d = deps({ prospectDailyStats: async () => undefined, createFile: async () => { driveCalled = true; return { ok: true } as never; } });
  const r = await deliverWeeklyProspectingReport(d);
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /unavailable/);
  assert.equal(driveCalled, false);
});

test("deliverWeeklyProspectingReport: a failed email delivery is reported, even though the doc itself was created", async () => {
  const d = deps({ deliverToPrincipal: async () => ({ ok: false, error: "smtp down" }) });
  const r = await deliverWeeklyProspectingReport(d);
  assert.equal(r.ok, false);
  assert.equal(r.error, "smtp down");
  assert.ok(r.docUrl); // the doc still got created and is reported back even though email failed
});
