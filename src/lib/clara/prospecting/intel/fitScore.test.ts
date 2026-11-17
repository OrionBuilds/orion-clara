import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeFitScore,
  matchWhen,
  buildFitContext,
  type Company,
  type FactLike,
  type FitScoreConfig,
  type FitScoreRule,
  type FitTechnologyLike,
  type FitSignalLike,
} from "./fitScore";

const COMPANY: Company = { id: "c1", rating: 4.8, review_count: 120, state: "FL" };
const FACTS: FactLike[] = [
  { id: "f1", field_name: "services", value: "roof replacement" },
  { id: "f2", field_name: "services", value: "roof repair" },
  { id: "f3", field_name: "year_founded", value: 2008 },
  { id: "f4", field_name: "financing", value: "GreenSky" },
];

test("eq rule: matches a simple equality against a company column", () => {
  const config: FitScoreConfig = { rules: [{ key: "fl", label: "Florida", points: 10, when: { field: "state", op: "eq", value: "FL" } }] };
  const r = computeFitScore(COMPANY, FACTS, config);
  assert.equal(r.score, 10);
  assert.equal(r.breakdown.length, 1);
  assert.equal(r.breakdown[0].key, "fl");
});

test("gte rule: numeric-threshold rule against a company column", () => {
  const config: FitScoreConfig = { rules: [{ key: "rating", label: "4+ rating", points: 15, when: { field: "rating", op: "gte", value: 4 } }] };
  const r = computeFitScore(COMPANY, FACTS, config);
  assert.equal(r.score, 15);
});

test("gte rule does not fire below the threshold", () => {
  const config: FitScoreConfig = { rules: [{ key: "rating", label: "4.9+ rating", points: 15, when: { field: "rating", op: "gte", value: 4.9 } }] };
  const r = computeFitScore(COMPANY, FACTS, config);
  assert.equal(r.score, 0);
  assert.equal(r.breakdown.length, 0);
});

test("in rule: matches one of a list of values, against a fact", () => {
  const config: FitScoreConfig = {
    rules: [{ key: "roofing_service", label: "Offers roof replacement/repair", points: 20, when: { field: "services", op: "in", value: ["roof replacement", "siding"] } }],
  };
  const r = computeFitScore(COMPANY, FACTS, config);
  assert.equal(r.score, 20);
  assert.deepEqual(r.breakdown[0].evidenceFactIds, ["f1"]);
});

test("exists rule: fires when any fact value is present for the field", () => {
  const config: FitScoreConfig = { rules: [{ key: "has_financing", label: "Offers financing", points: 5, when: { field: "financing", op: "exists" } }] };
  const r = computeFitScore(COMPANY, FACTS, config);
  assert.equal(r.score, 5);
  assert.deepEqual(r.breakdown[0].evidenceFactIds, ["f4"]);
});

test("exists rule does not fire for a field with no values at all", () => {
  const config: FitScoreConfig = { rules: [{ key: "has_owner", label: "Owner known", points: 5, when: { field: "owner", op: "exists" } }] };
  const r = computeFitScore(COMPANY, FACTS, config);
  assert.equal(r.score, 0);
});

test("all combinator: every sub-condition must match", () => {
  const config: FitScoreConfig = {
    rules: [{
      key: "fl_established",
      label: "Florida + established",
      points: 25,
      when: { all: [{ field: "state", op: "eq", value: "FL" }, { field: "year_founded", op: "lte", value: 2015 }] },
    }],
  };
  const r = computeFitScore(COMPANY, FACTS, config);
  assert.equal(r.score, 25);
  assert.deepEqual(r.breakdown[0].evidenceFactIds, ["f3"]);
});

test("all combinator: fails to match when one sub-condition fails", () => {
  const config: FitScoreConfig = {
    rules: [{ key: "x", label: "x", points: 25, when: { all: [{ field: "state", op: "eq", value: "FL" }, { field: "rating", op: "gte", value: 4.95 }] } }],
  };
  const r = computeFitScore(COMPANY, FACTS, config);
  assert.equal(r.score, 0);
});

test("any combinator: matches when at least one sub-condition matches", () => {
  const config: FitScoreConfig = {
    rules: [{ key: "x", label: "x", points: 8, when: { any: [{ field: "state", op: "eq", value: "GA" }, { field: "rating", op: "gte", value: 4 }] } }],
  };
  const r = computeFitScore(COMPANY, FACTS, config);
  assert.equal(r.score, 8);
});

test("not combinator: inverts a sub-condition", () => {
  const config: FitScoreConfig = {
    rules: [{ key: "not_ga", label: "Not Georgia", points: 3, when: { not: { field: "state", op: "eq", value: "GA" } } }],
  };
  const r = computeFitScore(COMPANY, FACTS, config);
  assert.equal(r.score, 3);
});

test("multiple rules sum their points", () => {
  const config: FitScoreConfig = {
    rules: [
      { key: "fl", label: "Florida", points: 10, when: { field: "state", op: "eq", value: "FL" } },
      { key: "rating", label: "4+ rating", points: 15, when: { field: "rating", op: "gte", value: 4 } },
    ],
  };
  const r = computeFitScore(COMPANY, FACTS, config);
  assert.equal(r.score, 25);
  assert.equal(r.breakdown.length, 2);
});

test("clamps the total at 100 even when rule points sum higher", () => {
  const config: FitScoreConfig = {
    rules: [
      { key: "a", label: "a", points: 60, when: { field: "state", op: "eq", value: "FL" } },
      { key: "b", label: "b", points: 60, when: { field: "rating", op: "gte", value: 4 } },
    ],
  };
  const r = computeFitScore(COMPANY, FACTS, config);
  assert.equal(r.score, 100);
});

test("clamps the total at 0 even when a rule has negative points", () => {
  const config: FitScoreConfig = { rules: [{ key: "neg", label: "penalty", points: -50, when: { field: "state", op: "eq", value: "FL" } }] };
  const r = computeFitScore(COMPANY, FACTS, config);
  assert.equal(r.score, 0);
});

test("a null/undefined config degrades gracefully to score 0, empty breakdown", () => {
  assert.deepEqual(computeFitScore(COMPANY, FACTS, null), { score: 0, breakdown: [] });
  assert.deepEqual(computeFitScore(COMPANY, FACTS, undefined), { score: 0, breakdown: [] });
});

test("an empty rules array degrades gracefully to score 0", () => {
  const r = computeFitScore(COMPANY, FACTS, { rules: [] });
  assert.equal(r.score, 0);
});

test("an unrecognized `when` shape never matches (fails closed, never throws)", () => {
  const config: FitScoreConfig = { rules: [{ key: "x", label: "x", points: 10, when: { nonsense: true } }] };
  assert.doesNotThrow(() => computeFitScore(COMPANY, FACTS, config));
  assert.equal(computeFitScore(COMPANY, FACTS, config).score, 0);
});

test("matchWhen + buildFitContext directly: evidenceFactIds threads through a multi-valued 'in' match", () => {
  const ctx = buildFitContext(COMPANY, FACTS);
  const r = matchWhen({ field: "services", op: "in", value: ["roof repair"] }, ctx);
  assert.equal(r.matched, true);
  assert.deepEqual(r.factIds, ["f2"]);
});

// ── FOLLOW-UP (fit-score matcher fix): fact/tech_category/signal keys + contains/between/absent/
// matches ops, exercised against the real orion seed ("Roofing fit",
// supabase/migrations/20261001100000_prospect_core.sql) below. ──────────────────────────────────

test("`fact` is a synonym for `field` — same resolver, same eq behavior", () => {
  const config: FitScoreConfig = { rules: [{ key: "fl", label: "Florida", points: 10, when: { fact: "state", op: "eq", value: "FL" } }] };
  const r = computeFitScore(COMPANY, FACTS, config);
  assert.equal(r.score, 10);
});

test("contains (fact key): matches a substring, case-insensitive", () => {
  const config: FitScoreConfig = { rules: [{ key: "roofing", label: "Roofing", points: 20, when: { fact: "industry", op: "contains", value: "roofing" } }] };
  const company: Company = { id: "c2", industry: "ABC Roofing & Siding" };
  const r = computeFitScore(company, [], config);
  assert.equal(r.score, 20);
});

test("contains (fact key): does not match when the substring is absent", () => {
  const config: FitScoreConfig = { rules: [{ key: "roofing", label: "Roofing", points: 20, when: { fact: "industry", op: "contains", value: "roofing" } }] };
  const company: Company = { id: "c2", industry: "ABC Plumbing" };
  const r = computeFitScore(company, [], config);
  assert.equal(r.score, 0);
});

test("contains with an array value matches on substring, case-insensitive, if ANY element hits", () => {
  const ctx = buildFitContext({ id: "c3", crm_notes: "We migrated to JOBNIMBUS last year" }, []);
  const r = matchWhen({ fact: "crm_notes", op: "contains", value: ["jobnimbus", "accu lynx"] }, ctx);
  assert.equal(r.matched, true);
});

test("between (fact key, singular `value`): matches a number inside [min,max]", () => {
  const config: FitScoreConfig = { rules: [{ key: "emp", label: "10-100 employees", points: 15, when: { fact: "employees", op: "between", value: [10, 100] } }] };
  const r = computeFitScore({ id: "c4" }, [{ id: "f1", field_name: "employees", value: 45 }], config);
  assert.equal(r.score, 15);
});

test("between (fact key, plural `values`, as the real seed spells it): matches a number inside [min,max]", () => {
  const config: FitScoreConfig = { rules: [{ key: "rev", label: "$2M-$20M revenue", points: 15, when: { fact: "revenue_estimate", op: "between", values: [2000000, 20000000] } }] };
  const r = computeFitScore({ id: "c4" }, [{ id: "f1", field_name: "revenue_estimate", value: 5000000 }], config);
  assert.equal(r.score, 15);
});

test("between: does not match a number outside [min,max]", () => {
  const config: FitScoreConfig = { rules: [{ key: "emp", label: "10-100 employees", points: 15, when: { fact: "employees", op: "between", values: [10, 100] } }] };
  const r = computeFitScore({ id: "c4" }, [{ id: "f1", field_name: "employees", value: 500 }], config);
  assert.equal(r.score, 0);
});

test("absent (tech_category key): matches when no technologies resolve for that category — no values returns true", () => {
  const ctx = buildFitContext({ id: "c5" }, [], []);
  const r = matchWhen({ tech_category: "ai_receptionist", op: "absent" }, ctx);
  assert.equal(r.matched, true);
});

test("absent: does not match when a technology is present for that category", () => {
  const technologies: FitTechnologyLike[] = [{ category: "ai_receptionist", name: "SomeAI" }];
  const ctx = buildFitContext({ id: "c5" }, [], technologies);
  const r = matchWhen({ tech_category: "ai_receptionist", op: "absent" }, ctx);
  assert.equal(r.matched, false);
});

test("tech_category key resolves against company_technologies (e.g. via `in`)", () => {
  const technologies: FitTechnologyLike[] = [{ category: "crm", name: "JobNimbus", fact_id: "tf1" }];
  const config: FitScoreConfig = { rules: [{ key: "crm", label: "JobNimbus/AccuLynx", points: 10, when: { tech_category: "crm", op: "in", values: ["JobNimbus", "AccuLynx"] } }] };
  const r = computeFitScore({ id: "c6" }, [], config, technologies, []);
  assert.equal(r.score, 10);
  assert.deepEqual(r.breakdown[0].evidenceFactIds, ["tf1"]);
});

test("signal key (matches op): matches a recent signal of that type whose headline/detail hits the regex", () => {
  const signals: FitSignalLike[] = [{ signal_type: "hiring", observed_at: new Date().toISOString(), headline: "Hiring Outside Sales Rep" }];
  const ctx = buildFitContext({ id: "c7" }, [], [], signals);
  const r = matchWhen({ signal: "hiring", op: "matches", value: "sales" }, ctx);
  assert.equal(r.matched, true);
});

test("signal key (matches op): does not match a same-type signal whose text doesn't hit the regex", () => {
  const signals: FitSignalLike[] = [{ signal_type: "hiring", observed_at: new Date().toISOString(), headline: "Hiring Front Desk Admin" }];
  const ctx = buildFitContext({ id: "c7" }, [], [], signals);
  const r = matchWhen({ signal: "hiring", op: "matches", value: "sales" }, ctx);
  assert.equal(r.matched, false);
});

test("signal key: a signal outside the 90-day window does not resolve (never matches)", () => {
  const stale = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString();
  const signals: FitSignalLike[] = [{ signal_type: "hiring", observed_at: stale, headline: "Hiring Outside Sales Rep" }];
  const ctx = buildFitContext({ id: "c7" }, [], [], signals);
  const r = matchWhen({ signal: "hiring", op: "exists" }, ctx);
  assert.equal(r.matched, false);
});

test("mixed `all` combinator: contains + between + absent (new ops/keys) must all match", () => {
  const technologies: FitTechnologyLike[] = [];
  const config: FitScoreConfig = {
    rules: [{
      key: "x",
      label: "x",
      points: 30,
      when: {
        all: [
          { fact: "industry", op: "contains", value: "roofing" },
          { fact: "employees", op: "between", values: [10, 100] },
          { tech_category: "booking", op: "absent" },
        ],
      },
    }],
  };
  const company: Company = { id: "c8", industry: "Sunshine Roofing" };
  const r = computeFitScore(company, [{ id: "f1", field_name: "employees", value: 50 }], config, technologies, []);
  assert.equal(r.score, 30);
});

test("mixed `any` combinator: fires when only one new-op/key leaf matches", () => {
  const config: FitScoreConfig = {
    rules: [{
      key: "x",
      label: "x",
      points: 10,
      when: {
        any: [
          { fact: "industry", op: "contains", value: "plumbing" },
          { fact: "employees", op: "between", values: [10, 100] },
        ],
      },
    }],
  };
  const company: Company = { id: "c9", industry: "Sunshine Roofing" };
  const r = computeFitScore(company, [{ id: "f1", field_name: "employees", value: 50 }], config);
  assert.equal(r.score, 10);
});

test("mixed `not` combinator: inverts a tech_category `absent` leaf", () => {
  const technologies: FitTechnologyLike[] = [{ category: "booking", name: "Calendly" }];
  const config: FitScoreConfig = {
    rules: [{ key: "has_booking", label: "Has booking tech", points: 5, when: { not: { tech_category: "booking", op: "absent" } } }],
  };
  const r = computeFitScore({ id: "c10" }, [], config, technologies, []);
  assert.equal(r.score, 5);
});

// ── The exact live orion seed: "Roofing fit" (fit_score_configs), 10 rules, 100 raw points —
// supabase/migrations/20261001100000_prospect_core.sql. Hard-coded here (not re-derived) so this
// test actually breaks if the matcher regresses against the real predicate shapes the OS writes
// (`fact`/`tech_category`/`signal` keys, plural `values` on between/in, regex `matches`). ──────────
const ROOFING_SEED_RULES: FitScoreRule[] = [
  { key: "roofing", label: "Roofing contractor", points: 20, when: { fact: "industry", op: "contains", value: "roofing" } },
  { key: "employees_10_100", label: "10–100 employees", points: 15, when: { fact: "employees", op: "between", values: [10, 100] } },
  { key: "revenue_2m_20m", label: "$2M–$20M estimated revenue", points: 15, when: { fact: "revenue_estimate", op: "between", values: [2000000, 20000000] } },
  { key: "google_ads", label: "Runs Google Ads", points: 10, when: { tech_category: "ads", op: "in", values: ["Google Ads"] } },
  { key: "hiring_sales", label: "Hiring salespeople", points: 10, when: { signal: "hiring", op: "matches", value: "sales" } },
  { key: "crm_jobnimbus", label: "Uses JobNimbus / AccuLynx", points: 10, when: { tech_category: "crm", op: "in", values: ["JobNimbus", "AccuLynx"] } },
  { key: "multi_location", label: "Multiple locations", points: 5, when: { fact: "location_count", op: "gte", value: 2 } },
  { key: "reviews_100", label: "100+ Google reviews", points: 5, when: { fact: "review_count", op: "gte", value: 100 } },
  { key: "no_ai_receptionist", label: "No AI receptionist", points: 5, when: { tech_category: "ai_receptionist", op: "absent" } },
  { key: "no_online_booking", label: "No automated online booking", points: 5, when: { tech_category: "booking", op: "absent" } },
];
const ROOFING_SEED_CONFIG: FitScoreConfig = { name: "Roofing fit", version: 1, rules: ROOFING_SEED_RULES };
const ROOFING_SEED_TOTAL_RAW_POINTS = ROOFING_SEED_RULES.reduce((sum, r) => sum + r.points, 0);

test("Roofing seed: a fully-matching company scores the full 100", () => {
  assert.equal(ROOFING_SEED_TOTAL_RAW_POINTS, 100);
  const company: Company = { id: "all10", industry: "Sunshine Roofing & Siding" };
  const facts: FactLike[] = [
    { id: "f1", field_name: "employees", value: 45 },
    { id: "f2", field_name: "revenue_estimate", value: 5000000 },
    { id: "f3", field_name: "location_count", value: 3 },
    { id: "f4", field_name: "review_count", value: 150 },
  ];
  const technologies: FitTechnologyLike[] = [
    { category: "ads", name: "Google Ads" },
    { category: "crm", name: "JobNimbus" },
  ];
  const signals: FitSignalLike[] = [{ signal_type: "hiring", observed_at: new Date().toISOString(), headline: "Hiring Outside Sales Rep" }];
  const r = computeFitScore(company, facts, ROOFING_SEED_CONFIG, technologies, signals);
  assert.equal(r.score, 100);
  assert.equal(r.breakdown.length, 10);
});

test("Roofing seed: a company matching none of the 10 rules scores 0", () => {
  const company: Company = { id: "none", industry: "ABC Plumbing" };
  const facts: FactLike[] = [
    { id: "f1", field_name: "employees", value: 500 },
    { id: "f2", field_name: "revenue_estimate", value: 100 },
    { id: "f3", field_name: "location_count", value: 1 },
    { id: "f4", field_name: "review_count", value: 10 },
  ];
  // ai_receptionist/booking tech PRESENT so the two `absent` rules also fail to match.
  const technologies: FitTechnologyLike[] = [
    { category: "ai_receptionist", name: "SomeAI" },
    { category: "booking", name: "Calendly" },
  ];
  const r = computeFitScore(company, facts, ROOFING_SEED_CONFIG, technologies, []);
  assert.equal(r.score, 0);
  assert.equal(r.breakdown.length, 0);
});

test("Roofing seed: a company matching exactly 6 of the 10 rules scores the sum of their points", () => {
  const company: Company = { id: "mixed", industry: "ABC Roofing Co" };
  const facts: FactLike[] = [
    { id: "f1", field_name: "employees", value: 50 }, // matches employees_10_100
    { id: "f2", field_name: "revenue_estimate", value: 50000000 }, // too high — does not match revenue_2m_20m
    { id: "f3", field_name: "location_count", value: 3 }, // matches multi_location
    { id: "f4", field_name: "review_count", value: 200 }, // matches reviews_100
  ];
  // No ads/crm tech -> google_ads and crm_jobnimbus fail. No ai_receptionist/booking tech -> both
  // `absent` rules match.
  const technologies: FitTechnologyLike[] = [];
  // A hiring signal that isn't about sales -> hiring_sales fails.
  const signals: FitSignalLike[] = [{ signal_type: "hiring", observed_at: new Date().toISOString(), headline: "Hiring Front Desk Admin" }];
  const r = computeFitScore(company, facts, ROOFING_SEED_CONFIG, technologies, signals);
  const expectedKeys = ["roofing", "employees_10_100", "multi_location", "reviews_100", "no_ai_receptionist", "no_online_booking"];
  const expectedPoints = ROOFING_SEED_RULES.filter((r) => expectedKeys.includes(r.key)).reduce((sum, r) => sum + r.points, 0);
  assert.equal(expectedPoints, 55);
  assert.equal(r.score, expectedPoints);
  assert.equal(r.breakdown.length, 6);
  assert.deepEqual(r.breakdown.map((b) => b.key).sort(), [...expectedKeys].sort());
});
