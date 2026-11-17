// intel/fitScore.ts — PR 9's fit-score engine. `computeFitScore` is pure (unit-tested directly with
// fabricated configs/facts); stage 60 (score.fit, stages.ts) is the only caller that touches the OS
// — it reads the active config via osBridge's `fitScoreConfigGet`, calls this pure function, then
// persists the result via `fitScoreRecompute` (the authoritative companies.fit_score writer).
//
// IMPORTANT — two separate score-writing paths, don't conflate them (see osBridge.ts's SignalsAdd
// doc comment too): `fitScoreRecompute` SETS companies.fit_score to whatever this module computed —
// every score.fit run, unconditionally. `signals_add`'s `score_delta` (publicdata/index.ts, stage 55)
// ADDS a discrete bump on top of whatever fitScoreRecompute last set. Stage 60 here never calls
// signals_add itself — that would double-count public_data's own bump reasoning as if it were also a
// fitScore.ts rule.
//
// `when` condition shape: the OS's fit_score_configs.rules[].when column is open JSONB — there is no
// fixed schema from the OS side. This module defines ITS OWN small, documented condition language
// (matchWhen below) that a real fit-score config can target: a leaf `{field, op, value}` test, or an
// `{all:[...]}` / `{any:[...]}` / `{not:...}` combinator of leaves/combinators. Anything else (a
// shape this matcher doesn't recognize) simply never matches — fail closed, never throw.
//
// FOLLOW-UP (fit-score matcher fix, after PR 9): the live orion seed (`fit_score_configs`'s
// "Roofing fit" row, supabase/migrations/20261001100000_prospect_core.sql) uses a WIDER grammar
// than PR 9 shipped — leaf keys `fact`/`tech_category`/`signal` as alternatives to `field`, ops
// `contains`/`between`/`absent`/`matches` alongside the original eq/neq/gte/lte/gt/lt/in/exists, and
// (for between/in) a plural `values` key next to the singular `value` PR 9 only read. This module now
// accepts both so the real seed's 10 rules actually fire instead of silently matching nothing (every
// company scoring 0). `fact` is purely a synonym for `field` — both resolve through the same
// facts/company-column path (ctx.resolve); `tech_category`/`signal` resolve through two NEW
// FitContext methods backed by company_technologies/company_signals rows buildFitContext now accepts.

import { fitScoreConfigGet as fitScoreConfigGetReal } from "../osBridge";

export type FitFieldOp =
  | "eq" | "neq" | "gte" | "lte" | "gt" | "lt" | "in" | "exists"
  | "contains" | "between" | "absent" | "matches";

export interface FitWhenLeaf {
  /** Exactly one of field/fact/tech_category/signal names what this leaf resolves against — see
   *  resolveLeafValues below. `fact` is a synonym for `field` (same resolver). */
  field?: string;
  fact?: string;
  tech_category?: string;
  signal?: string;
  op: FitFieldOp;
  /** The live seed spells this `value` on most rules but `values` on `between`/some `in` rules
   *  (plural, e.g. `{"op":"between","values":[10,100]}`) — leafValue() below reads whichever is
   *  present, preferring `value`. */
  value?: unknown;
  values?: unknown;
}
export interface FitWhenAll {
  all: FitWhen[];
}
export interface FitWhenAny {
  any: FitWhen[];
}
export interface FitWhenNot {
  not: FitWhen;
}
export type FitWhen = FitWhenLeaf | FitWhenAll | FitWhenAny | FitWhenNot;

export interface FitScoreRule {
  key: string;
  label: string;
  points: number;
  when: unknown;
}

export interface FitScoreConfig {
  id?: string;
  name?: string;
  version?: number;
  rules: FitScoreRule[];
}

/** One resolved field: every value that field currently has (a company column value and/or one+
 *  fact values for a multi-valued field_name), each paired with the fact id that supports it (a
 *  company-column value has no fact id — `undefined`). */
export interface FitFieldValue {
  value: unknown;
  factId?: string;
}

export interface FitContext {
  /** Resolves a `when.field`/`when.fact` name to every current value for it. Company columns are
   *  checked first (field name matches a top-level company property), then facts (field_name match,
   *  every row — multi-valued fields naturally yield several FitFieldValue entries). */
  resolve: (field: string) => FitFieldValue[];
  /** Resolves a `when.tech_category` to the company's current (not valid_until'd) company_technologies
   *  rows in that category — one FitFieldValue per row, `value` = the tech's `name`. */
  resolveTechCategory: (category: string) => FitFieldValue[];
  /** Resolves a `when.signal` to the company's current company_signals rows of that signal_type
   *  (observed within the configured window — 90 days by default). `value` is the signal's
   *  searchable text (headline + detail, falling back to the signal_type itself) so `matches` can
   *  regex against it, e.g. {"signal":"hiring","op":"matches","value":"sales"} only fires for a
   *  hiring signal whose headline/detail actually mentions "sales". */
  resolveSignal: (signalType: string) => FitFieldValue[];
}

export interface Company {
  id: string;
  [key: string]: unknown;
}

export interface FactLike {
  id: string;
  field_name: string;
  value: unknown;
}

/** A company_technologies row, loosened to just what buildFitContext needs (osBridge's
 *  CompanyTechnologyRow/CompanyTechnologyInput both satisfy this structurally). */
export interface FitTechnologyLike {
  category: string;
  name: string;
  fact_id?: string;
}

/** A company_signals row, loosened to just what buildFitContext needs (osBridge's SignalRow
 *  satisfies this structurally). */
export interface FitSignalLike {
  signal_type: string;
  observed_at: string;
  headline?: string;
  detail?: string;
  fact_id?: string;
}

export interface BuildFitContextOptions {
  /** How recent a company_signals row must be (observed_at) to count as "current" for
   *  resolveSignal. Default 90 days, matching the plan's "last 90 days by default, configurable". */
  signalWindowDays?: number;
}

/** Builds the FitContext a real company+facts(+technologies+signals) set resolves to. Pure.
 *  `technologies`/`signals` default to `[]` — existing callers passing only (company, facts) keep
 *  working exactly as before; a `when.tech_category`/`when.signal` leaf just never matches against an
 *  empty list (fail closed), same as any other field with no resolved values. */
export function buildFitContext(
  company: Company,
  facts: FactLike[],
  technologies: FitTechnologyLike[] = [],
  signals: FitSignalLike[] = [],
  options: BuildFitContextOptions = {},
): FitContext {
  const windowDays = options.signalWindowDays ?? 90;
  const cutoffMs = Date.now() - windowDays * 24 * 60 * 60 * 1000;
  return {
    resolve(field: string): FitFieldValue[] {
      const out: FitFieldValue[] = [];
      if (field in company && company[field] !== undefined && company[field] !== null) {
        out.push({ value: company[field] });
      }
      for (const f of facts) {
        if (f.field_name === field) out.push({ value: f.value, factId: f.id });
      }
      return out;
    },
    resolveTechCategory(category: string): FitFieldValue[] {
      return technologies.filter((t) => t.category === category).map((t) => ({ value: t.name, factId: t.fact_id }));
    },
    resolveSignal(signalType: string): FitFieldValue[] {
      return signals
        .filter((s) => s.signal_type === signalType)
        .filter((s) => {
          const t = Date.parse(s.observed_at);
          return Number.isFinite(t) && t >= cutoffMs;
        })
        .map((s) => ({ value: [s.headline, s.detail].filter(Boolean).join(" ").trim() || s.signal_type, factId: s.fact_id }));
    },
  };
}

function isLeaf(w: FitWhen): w is FitWhenLeaf {
  const l = w as FitWhenLeaf;
  const hasKey = typeof l.field === "string" || typeof l.fact === "string" || typeof l.tech_category === "string" || typeof l.signal === "string";
  return hasKey && typeof l.op === "string";
}

/** Resolves a leaf's field/fact/tech_category/signal key against the right FitContext method.
 *  `fact` is a pure synonym for `field` (same resolver, same facts/company-column path). */
function resolveLeafValues(w: FitWhenLeaf, ctx: FitContext): FitFieldValue[] {
  if (typeof w.tech_category === "string") return ctx.resolveTechCategory(w.tech_category);
  if (typeof w.signal === "string") return ctx.resolveSignal(w.signal);
  if (typeof w.fact === "string") return ctx.resolve(w.fact);
  if (typeof w.field === "string") return ctx.resolve(w.field);
  return [];
}

/** The live seed spells the comparison operand `value` on most rules but `values` (plural) on
 *  `between` and some `in` rules — read whichever is present, preferring `value`. */
function leafValue(w: FitWhenLeaf): unknown {
  return w.value !== undefined ? w.value : w.values;
}

function evidenceFactIds(hits: FitFieldValue[]): string[] {
  return hits.map((v) => v.factId).filter((x): x is string => Boolean(x));
}
function isAll(w: FitWhen): w is FitWhenAll {
  return Array.isArray((w as FitWhenAll).all);
}
function isAny(w: FitWhen): w is FitWhenAny {
  return Array.isArray((w as FitWhenAny).any);
}
function isNot(w: FitWhen): w is FitWhenNot {
  return (w as FitWhenNot).not !== undefined && typeof (w as FitWhenNot).not === "object";
}

function compareNumeric(values: FitFieldValue[], op: "gte" | "lte" | "gt" | "lt", target: unknown): FitFieldValue[] {
  const t = typeof target === "number" ? target : Number(target);
  if (!Number.isFinite(t)) return [];
  return values.filter((v) => {
    const n = typeof v.value === "number" ? v.value : Number(v.value);
    if (!Number.isFinite(n)) return false;
    if (op === "gte") return n >= t;
    if (op === "lte") return n <= t;
    if (op === "gt") return n > t;
    return n < t;
  });
}

/** Evaluates one `when` node against a FitContext. Returns whether it matched and which fact ids (if
 *  any) support the match — used to populate breakdown[].evidenceFactIds. Unrecognized `when` shapes
 *  never match (fail closed) rather than throwing, so a malformed config row degrades a rule to
 *  "never fires" instead of crashing stage 60. */
export function matchWhen(when: unknown, ctx: FitContext): { matched: boolean; factIds: string[] } {
  if (!when || typeof when !== "object") return { matched: false, factIds: [] };
  const w = when as FitWhen;

  if (isAll(w)) {
    const results = w.all.map((sub) => matchWhen(sub, ctx));
    const matched = results.length > 0 && results.every((r) => r.matched);
    return { matched, factIds: matched ? [...new Set(results.flatMap((r) => r.factIds))] : [] };
  }
  if (isAny(w)) {
    const results = w.any.map((sub) => matchWhen(sub, ctx));
    const matchedOnes = results.filter((r) => r.matched);
    return { matched: matchedOnes.length > 0, factIds: [...new Set(matchedOnes.flatMap((r) => r.factIds))] };
  }
  if (isNot(w)) {
    const sub = matchWhen(w.not, ctx);
    return { matched: !sub.matched, factIds: [] };
  }
  if (!isLeaf(w)) return { matched: false, factIds: [] };

  const values = resolveLeafValues(w, ctx);
  const present = values.filter((v) => v.value !== undefined && v.value !== null && v.value !== "");

  if (w.op === "exists") {
    return { matched: present.length > 0, factIds: evidenceFactIds(present) };
  }
  if (w.op === "absent") {
    // Matches when NO values resolve for the field/tech/signal — the inverse of `exists`. A rule
    // like {"tech_category":"ai_receptionist","op":"absent"} carries no `value` at all; it only cares
    // whether the resolver came back empty.
    return { matched: present.length === 0, factIds: [] };
  }
  if (w.op === "eq") {
    const hit = values.filter((v) => v.value === w.value || String(v.value) === String(w.value));
    return { matched: hit.length > 0, factIds: evidenceFactIds(hit) };
  }
  if (w.op === "neq") {
    const hit = values.filter((v) => v.value !== w.value && String(v.value) !== String(w.value));
    return { matched: hit.length > 0, factIds: evidenceFactIds(hit) };
  }
  if (w.op === "in") {
    const raw = leafValue(w);
    const list = Array.isArray(raw) ? (raw as unknown[]) : [];
    const hit = values.filter((v) => list.some((x) => x === v.value || String(x) === String(v.value)));
    return { matched: hit.length > 0, factIds: evidenceFactIds(hit) };
  }
  if (w.op === "contains") {
    // value matches when it's a substring of any resolved value (case-insensitive). An array value
    // matches if ANY of its elements is a substring of any resolved value.
    const raw = leafValue(w);
    const needles = (Array.isArray(raw) ? raw : [raw]).map((x) => String(x).toLowerCase()).filter((n) => n.length > 0);
    const hit = values.filter((v) => {
      const hay = String(v.value).toLowerCase();
      return needles.some((n) => hay.includes(n));
    });
    return { matched: hit.length > 0, factIds: evidenceFactIds(hit) };
  }
  if (w.op === "matches") {
    // value is a regex string (case-insensitive); matches when any resolved value matches it.
    const raw = leafValue(w);
    if (typeof raw !== "string") return { matched: false, factIds: [] };
    let re: RegExp;
    try {
      re = new RegExp(raw, "i");
    } catch {
      return { matched: false, factIds: [] };
    }
    const hit = values.filter((v) => re.test(String(v.value)));
    return { matched: hit.length > 0, factIds: evidenceFactIds(hit) };
  }
  if (w.op === "gte" || w.op === "lte" || w.op === "gt" || w.op === "lt") {
    const hit = compareNumeric(values, w.op, leafValue(w));
    return { matched: hit.length > 0, factIds: evidenceFactIds(hit) };
  }
  if (w.op === "between") {
    // value/values must be [min, max]; matches when any resolved value is a number in [min, max].
    const raw = leafValue(w);
    if (!Array.isArray(raw) || raw.length !== 2) return { matched: false, factIds: [] };
    const lo = Number(raw[0]);
    const hi = Number(raw[1]);
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return { matched: false, factIds: [] };
    const hit = values.filter((v) => {
      const n = typeof v.value === "number" ? v.value : Number(v.value);
      return Number.isFinite(n) && n >= lo && n <= hi;
    });
    return { matched: hit.length > 0, factIds: evidenceFactIds(hit) };
  }
  return { matched: false, factIds: [] };
}

export interface FitScoreBreakdownEntry {
  key: string;
  label: string;
  points: number;
  evidenceFactIds: string[];
}

export interface FitScoreResult {
  score: number;
  breakdown: FitScoreBreakdownEntry[];
}

/** Pure: applies every rule in `config.rules` against `company`/`facts`(/`technologies`/`signals`),
 *  sums the points of every rule whose `when` matches, and clamps the total to [0,100]. An
 *  empty/missing config (OS has no active fit_score_configs row yet) degrades to score 0 with an
 *  empty breakdown rather than throwing — see the plan's "handle that gracefully" requirement.
 *  `technologies`/`signals` default to `[]` so every existing (company, facts, config) call site
 *  keeps working unchanged — only `when.tech_category`/`when.signal` leaves against an empty list,
 *  same as any other unresolved field. */
export function computeFitScore(
  company: Company,
  facts: FactLike[],
  config: FitScoreConfig | null | undefined,
  technologies: FitTechnologyLike[] = [],
  signals: FitSignalLike[] = [],
): FitScoreResult {
  const rules = config?.rules ?? [];
  const ctx = buildFitContext(company, facts, technologies, signals);
  const breakdown: FitScoreBreakdownEntry[] = [];
  let total = 0;

  for (const rule of rules) {
    const { matched, factIds } = matchWhen(rule.when, ctx);
    if (!matched) continue;
    total += rule.points;
    breakdown.push({ key: rule.key, label: rule.label, points: rule.points, evidenceFactIds: factIds });
  }

  return { score: Math.max(0, Math.min(100, total)), breakdown };
}

export interface FitScoreConfigDeps {
  fitScoreConfigGet: typeof fitScoreConfigGetReal;
}

export const defaultFitScoreConfigDeps: FitScoreConfigDeps = {
  fitScoreConfigGet: fitScoreConfigGetReal,
};

/** Live wrapper: fetches the active config off the OS (fit_score_config_get) and normalizes it into
 *  FitScoreConfig — defensive about the exact envelope (`{config: {...}}` vs. the row directly, or
 *  null/empty when nothing's configured yet) since, like companiesGet, that detail isn't pinned down
 *  anywhere PR 9 can confirm it against a running OS. */
export async function loadActiveFitScoreConfig(deps: FitScoreConfigDeps = defaultFitScoreConfigDeps): Promise<FitScoreConfig | null> {
  const raw = await deps.fitScoreConfigGet();
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const row = (r.config && typeof r.config === "object" ? r.config : r) as Record<string, unknown>;
  const rules = Array.isArray(row.rules) ? (row.rules as FitScoreRule[]) : [];
  if (!rules.length && !row.id) return null;
  return { id: typeof row.id === "string" ? row.id : undefined, name: typeof row.name === "string" ? row.name : undefined, version: typeof row.version === "number" ? row.version : undefined, rules };
}
