import { test } from "node:test";
import assert from "node:assert/strict";
import { signalRefreshTick, type RefreshDeps } from "./refresh";
import { hashContent } from "./diff";
import type { CompanyFactRow } from "../osBridge";
import type { SignalRunDeps } from "./types";
import type { CrawlPageResult } from "../crawler/waterfall";
import type { SignalBudgetCheck } from "./budget";

const NOW = new Date("2026-10-01T12:00:00Z");

const HTML_WITH_HUBSPOT = `<html><head><script src="https://js.hs-scripts.com/1.js"></script></head><body>x</body></html>`;

function crawlPageFixture(opts: { homeText: string; homeHtml?: string }): SignalRunDeps["crawlPage"] {
  return (async (url: string) => {
    const path = new URL(url).pathname;
    if (path === "/") {
      const evidence: CrawlPageResult["evidence"] = { sha: "s", companyId: "co", url, sourceType: "homepage", txtPath: "/x/home.txt", htmlPath: opts.homeHtml ? "/x/home.html" : undefined };
      return { ok: true, url, method: "http", costUsd: 0, evidence };
    }
    const key = path.includes("services") ? "services" : "financing";
    return { ok: true, url, method: "http", costUsd: 0, evidence: { sha: "s", companyId: "co", url, sourceType: "other", txtPath: `/x/${key}.txt` } };
  }) as SignalRunDeps["crawlPage"];
}

function readFileFixture(texts: Record<string, string>): SignalRunDeps["readFile"] {
  return async (p: string) => {
    if (!(p in texts)) throw new Error(`no fixture for ${p}`);
    return texts[p];
  };
}

interface Harness {
  deps: RefreshDeps;
  signals: { companyId: string; signalType: string }[];
  writes: { companyId: string; fieldName: string }[];
  crawlCalls: number;
  placeCalls: number;
}

function harness(opts: {
  companies: Array<{ id: string; website_url?: string; google_place_id?: string }>;
  factsByCompany?: Record<string, CompanyFactRow[]>;
  homeText?: string;
  homeChangedText?: string; // if set, differs from what's "on file" for website_hash
  budgetOk?: (companyId: string, estCostCents: number) => boolean;
}): Harness {
  const signals: { companyId: string; signalType: string }[] = [];
  const writes: { companyId: string; fieldName: string }[] = [];
  let crawlCalls = 0;
  let placeCalls = 0;

  const homeText = opts.homeChangedText ?? opts.homeText ?? "home text";
  const crawlPage: SignalRunDeps["crawlPage"] = (async (url: string, ctx: { companyId?: string }) => {
    crawlCalls++;
    const r = await crawlPageFixture({ homeText, homeHtml: HTML_WITH_HUBSPOT })(url, ctx);
    return r;
  }) as SignalRunDeps["crawlPage"];

  const texts: Record<string, string> = { "/x/home.txt": homeText, "/x/home.html": HTML_WITH_HUBSPOT, "/x/services.txt": "services text", "/x/financing.txt": "financing text" };

  const signalRunDeps: SignalRunDeps = {
    now: () => NOW,
    factsList: async ({ subject_id, field_name }) => {
      const rows = opts.factsByCompany?.[subject_id] ?? [];
      return field_name ? rows.filter((r) => r.field_name === field_name) : rows;
    },
    writeLastCheckedFact: async (input) => {
      writes.push({ companyId: input.companyId, fieldName: input.fieldName });
    },
    fireSignal: async (input) => {
      signals.push({ companyId: input.companyId, signalType: input.signalType as string });
      return { signal: {} };
    },
    crawlPage,
    readFile: readFileFixture(texts),
    cachedCall: (async (args: { allowLive: boolean; fn: () => Promise<unknown>; companyId?: string }) => {
      placeCalls++;
      if (!args.allowLive) return { cached: false, skipped: true, costUsd: 0 };
      const value = await args.fn();
      return { value, cached: false, costUsd: 0.005 };
    }) as SignalRunDeps["cachedCall"],
    getPlaceDetails: async () => ({ ok: true, rating: 4.5, userRatingCount: 120 }),
    // PR 18 — the 5 new independent signals' deps. None of this file's fixture companies carry a
    // `name` or `city`, so hiring/ad_activity/new_location/permit_growth all self-skip immediately
    // (see each check's own "no company name"/"not in a jurisdiction" early-return) and never touch
    // these fakes. leadership_change only needs `website_url` (present on every fixture company
    // here), so IT does run every tick below — see the "PR 18" comments on the crawlCalls
    // assertions this affects.
    webSearch: async () => ({ ok: false, results: [], error: "not used in this test" }),
    findBusiness: async () => ({ ok: false, candidates: [], error: "not used in this test" }),
    lookupHillsboroughPermits: async () => [],
    lookupPinellasPermits: async () => [],
    runTier: async () => ({ ok: false, engine: "lmstudio", error: "not used in this test" }),
    allowLive: true,
  };

  const deps: RefreshDeps = {
    companiesSearch: async () => ({ rows: opts.companies, total: opts.companies.length }),
    checkSignalBudget: async (companyId, estCostCents): Promise<SignalBudgetCheck> => {
      const ok = opts.budgetOk ? opts.budgetOk(companyId, estCostCents) : true;
      return { ok, reason: ok ? undefined : "per_company_monthly_cap", spentThisMonthCents: 0, capCentsPerCompany: 15, spentTodayUsd: 0, dailyCapUsd: 40 };
    },
    signalRunDeps,
    now: () => NOW,
  };

  return { deps, signals, writes, get crawlCalls() { return crawlCalls; }, get placeCalls() { return placeCalls; } };
}

test("off mode: a no-op tick, nothing scanned", async () => {
  const prev = process.env.CLARA_PROSPECTING;
  process.env.CLARA_PROSPECTING = "off";
  try {
    const h = harness({ companies: [{ id: "co_1", website_url: "https://acme.com" }] });
    const r = await signalRefreshTick(h.deps);
    assert.equal(r.scanned, 0);
    assert.equal(r.signals_fired, 0);
    assert.equal(r.budget_stopped, 0);
    assert.ok(r.notes.some((n) => n.includes("off")));
  } finally {
    if (prev === undefined) delete process.env.CLARA_PROSPECTING;
    else process.env.CLARA_PROSPECTING = prev;
  }
});

test("tick summary shape: scanned/signals_fired/budget_stopped/notes always present with correct types", async () => {
  const prev = process.env.CLARA_PROSPECTING;
  process.env.CLARA_PROSPECTING = "active";
  try {
    const h = harness({ companies: [{ id: "co_1", website_url: "https://acme.com", google_place_id: "p_1" }] });
    const r = await signalRefreshTick(h.deps);
    assert.equal(typeof r.scanned, "number");
    assert.equal(typeof r.signals_fired, "number");
    assert.equal(typeof r.budget_stopped, "number");
    assert.ok(Array.isArray(r.notes));
    assert.equal(r.scanned, 1);
  } finally {
    if (prev === undefined) delete process.env.CLARA_PROSPECTING; else process.env.CLARA_PROSPECTING = prev;
  }
});

test("cadence gating: a company checked moments ago (website_hash observed_at=now) is NOT due — website-change never crawls", async () => {
  const prev = process.env.CLARA_PROSPECTING;
  process.env.CLARA_PROSPECTING = "active";
  try {
    const facts: CompanyFactRow[] = [
      { id: "f1", field_name: "website_hash", value: "somehash", observed_at: NOW.toISOString(), source_type: "website_page" },
      // PR 18's leadership_change also crawls (its own cadence gate, on "leadership_names_hash")
      // when due — marking it not-due too keeps this test's "nothing crawls this tick" intent
      // intact rather than just asserting about website-change specifically.
      { id: "f2", field_name: "leadership_names_hash", value: "somehash2", observed_at: NOW.toISOString(), source_type: "website_page" },
    ];
    const h = harness({ companies: [{ id: "co_1", website_url: "https://acme.com" }], factsByCompany: { co_1: facts } });
    const r = await signalRefreshTick(h.deps);
    assert.equal(r.scanned, 1);
    assert.equal(h.crawlCalls, 0, "website-change and leadership_change should never have crawled — neither is due yet");
  } finally {
    if (prev === undefined) delete process.env.CLARA_PROSPECTING; else process.env.CLARA_PROSPECTING = prev;
  }
});

test("cadence gating: a company never checked before (no facts) IS due — website-change runs", async () => {
  const prev = process.env.CLARA_PROSPECTING;
  process.env.CLARA_PROSPECTING = "active";
  try {
    const h = harness({ companies: [{ id: "co_1", website_url: "https://acme.com" }], factsByCompany: {} });
    await signalRefreshTick(h.deps);
    assert.ok(h.crawlCalls >= 3, "website-change should have crawled home+services+financing");
  } finally {
    if (prev === undefined) delete process.env.CLARA_PROSPECTING; else process.env.CLARA_PROSPECTING = prev;
  }
});

test("sequencing: homepage UNCHANGED this tick -> tech-change does not run (no tech_added/tech_removed signal)", async () => {
  const prev = process.env.CLARA_PROSPECTING;
  process.env.CLARA_PROSPECTING = "active";
  try {
    const sameHomeText = "unchanged home text";
    const facts: CompanyFactRow[] = [
      // Prior website_hash matches what this tick will (re)compute -> no change.
      { id: "f1", field_name: "website_hash", value: hashContent(sameHomeText), source_type: "website_page" },
    ];
    const h = harness({ companies: [{ id: "co_1", website_url: "https://acme.com" }], factsByCompany: { co_1: facts }, homeText: sameHomeText });
    const r = await signalRefreshTick(h.deps);
    assert.ok(!h.signals.some((s) => s.signalType === "tech_added" || s.signalType === "tech_removed"), "tech-change must not fire when the homepage didn't change");
    assert.equal(r.scanned, 1);
  } finally {
    if (prev === undefined) delete process.env.CLARA_PROSPECTING; else process.env.CLARA_PROSPECTING = prev;
  }
});

test("sequencing: homepage CHANGED this tick -> tech-change DOES run this tick (reusing the same crawl, no extra fetch of the homepage)", async () => {
  const prev = process.env.CLARA_PROSPECTING;
  process.env.CLARA_PROSPECTING = "active";
  try {
    const facts: CompanyFactRow[] = [
      { id: "f1", field_name: "website_hash", value: "a-completely-different-old-hash", source_type: "website_page" },
    ];
    const h = harness({ companies: [{ id: "co_1", website_url: "https://acme.com" }], factsByCompany: { co_1: facts }, homeChangedText: "brand new home text" });
    await signalRefreshTick(h.deps);
    // website-change fetched home+services+financing (3 crawlPage calls); tech-change reused
    // website-change's own homepage HTML rather than issuing an extra crawl call. PR 18's
    // leadership_change (independent, no `name` on this fixture so hiring/ad_activity/new_location/
    // permit_growth all self-skip — see harness's own doc comment) DOES also crawl (/team, website_url
    // is the only thing it needs) — 1 more call, hence 4 not 3.
    assert.equal(h.crawlCalls, 4, "tech-change must not re-crawl the homepage this tick (website 3 + leadership_change's own /team crawl)");
    assert.ok(h.writes.some((w) => w.companyId === "co_1" && w.fieldName === "tech_scan_hash"), "tech-change should have run and written its own last-checked fact");
  } finally {
    if (prev === undefined) delete process.env.CLARA_PROSPECTING; else process.env.CLARA_PROSPECTING = prev;
  }
});

test("budget stop: review_velocity (the only non-$0 signal) is skipped for a company over its cap; website/tech-change ($0) still run", async () => {
  const prev = process.env.CLARA_PROSPECTING;
  process.env.CLARA_PROSPECTING = "active";
  try {
    const h = harness({
      companies: [{ id: "co_1", website_url: "https://acme.com", google_place_id: "p_1" }],
      factsByCompany: {},
      budgetOk: (_companyId, estCostCents) => estCostCents <= 0, // only the $0 signals clear the gate
    });
    const r = await signalRefreshTick(h.deps);
    assert.ok(r.budget_stopped >= 1, "review_velocity should have been counted as budget-stopped");
    assert.equal(h.placeCalls, 0, "Places Details must never be called once the budget gate blocks it");
    // website 3 + leadership_change's own /team crawl (cost_cents_est 0 — the only PR 18 signal
    // this filter doesn't block; hiring/ad_activity/new_location all cost >0 and ARE budget-stopped
    // here, same as review_velocity — and permit_growth self-skips, no `city` on this fixture).
    assert.equal(h.crawlCalls, 4, "the free website-change + leadership_change crawls still ran despite the company being over its signals budget");
  } finally {
    if (prev === undefined) delete process.env.CLARA_PROSPECTING; else process.env.CLARA_PROSPECTING = prev;
  }
});

test("multiple companies are each scanned independently", async () => {
  const prev = process.env.CLARA_PROSPECTING;
  process.env.CLARA_PROSPECTING = "active";
  try {
    const h = harness({
      companies: [
        { id: "co_1", website_url: "https://acme.com" },
        { id: "co_2", website_url: "https://beta.com" },
      ],
      factsByCompany: {},
    });
    const r = await signalRefreshTick(h.deps);
    assert.equal(r.scanned, 2);
  } finally {
    if (prev === undefined) delete process.env.CLARA_PROSPECTING; else process.env.CLARA_PROSPECTING = prev;
  }
});
