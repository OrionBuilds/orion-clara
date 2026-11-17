import { test } from "node:test";
import assert from "node:assert/strict";
import { checkSignalBudget, type SignalBudgetDeps } from "./budget";
import type { ProspectSettings } from "../osBridge";

const NOW = new Date("2026-10-01T12:00:00Z");

function settings(overrides: Partial<ProspectSettings> = {}): ProspectSettings {
  return {
    org_id: "org_1",
    crm_threshold: 75,
    auto_approve_usd: 25,
    global_email_per_day: 50,
    global_sms_per_day: 20,
    signal_budget_cents_per_company: 15,
    prospect_day_max_usd: 40,
    clara_calls_enabled: false,
    default_pipeline_name: "Sales / Prospecting",
    ...overrides,
  };
}

function deps(overrides: Partial<SignalBudgetDeps> = {}): SignalBudgetDeps {
  return {
    prospectSettingsGet: async () => settings(),
    spendThisMonthForCompany: async () => 0,
    spendTodayGlobal: async () => 0,
    now: () => NOW,
    ...overrides,
  };
}

test("both budgets have headroom — ok, no reason", async () => {
  const r = await checkSignalBudget("co_1", 0.5, deps());
  assert.equal(r.ok, true);
  assert.equal(r.reason, undefined);
  assert.equal(r.capCentsPerCompany, 15);
  assert.equal(r.dailyCapUsd, 40);
});

test("estCostCents<=0 (website/tech-change under $0 crawl rates) always passes, even already over cap", async () => {
  const r = await checkSignalBudget("co_1", 0, deps({ spendThisMonthForCompany: async () => 999, spendTodayGlobal: async () => 999 }));
  assert.equal(r.ok, true);
});

test("per-company monthly cap: spend + estimate crosses the cap -> stop", async () => {
  // 15 cents cap, already spent 14.6, next call estimated 0.5 -> 15.1 > 15 -> blocked.
  const r = await checkSignalBudget("co_1", 0.5, deps({ spendThisMonthForCompany: async () => 14.6 }));
  assert.equal(r.ok, false);
  assert.equal(r.reason, "per_company_monthly_cap");
  assert.equal(r.spentThisMonthCents, 14.6);
});

test("per-company monthly cap: spend + estimate landing EXACTLY on the cap is allowed (not >)", async () => {
  const r = await checkSignalBudget("co_1", 0.5, deps({ spendThisMonthForCompany: async () => 14.5 }));
  assert.equal(r.ok, true);
});

test("per-company monthly cap respects a custom signal_budget_cents_per_company from prospect_settings", async () => {
  const d = deps({
    prospectSettingsGet: async () => settings({ signal_budget_cents_per_company: 5 }),
    spendThisMonthForCompany: async () => 4.8,
  });
  const r = await checkSignalBudget("co_1", 0.5, d);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "per_company_monthly_cap");
  assert.equal(r.capCentsPerCompany, 5);
});

test("global daily cap: today's total prospecting spend + estimate crosses prospect_day_max_usd -> stop", async () => {
  // $40 cap, already spent $39.998 today, next call estimated 0.5 cents ($0.005) -> $40.003 > $40.
  const r = await checkSignalBudget("co_1", 0.5, deps({ spendTodayGlobal: async () => 39.998 }));
  assert.equal(r.ok, false);
  assert.equal(r.reason, "global_daily_cap");
});

test("global daily cap is checked even when the per-company cap has plenty of headroom", async () => {
  const d = deps({ spendThisMonthForCompany: async () => 0, spendTodayGlobal: async () => 50 });
  const r = await checkSignalBudget("co_1", 0.5, d);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "global_daily_cap");
});

test("per-company cap is checked before the global cap when both would block (deterministic reason)", async () => {
  const d = deps({ spendThisMonthForCompany: async () => 14.6, spendTodayGlobal: async () => 50 });
  const r = await checkSignalBudget("co_1", 0.5, d);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "per_company_monthly_cap");
});

test("missing prospect_settings row falls back to the documented defaults (15 cents / $40)", async () => {
  const d = deps({ prospectSettingsGet: async () => undefined, spendThisMonthForCompany: async () => 14.6 });
  const r = await checkSignalBudget("co_1", 0.5, d);
  assert.equal(r.capCentsPerCompany, 15);
  assert.equal(r.dailyCapUsd, 40);
  assert.equal(r.ok, false);
});
