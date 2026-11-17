// contacts/waterfall.ts — the generic rung engine shared by the email waterfall (stage 85,
// contact.email) and the mobile waterfall (stage 90, contact.phone). Both are "try each rung in a
// fixed order, first hit wins, every skip/miss gets logged with a reason" — this file is that loop,
// written once; rungs/*.ts supplies the nine actual rungs (5 email, 4 mobile).
//
// A rung is exactly the shape the plan specifies: "{id, enabled(key), gate(fit), costUnits, call()}".
// `enabled` checks the env (an unset CLARA_LEADMAGIC_API_KEY/CLARA_HUNTER_API_KEY/CLARA_APOLLO_API_KEY
// skips that rung with reason "not_configured" — the whole stage still runs cleanly in shadow, per
// the PR's own brief); `gate` checks the RungContext (free rungs gate true always; paid ones can
// refuse on fit/person-availability before spending anything); `call` does the actual lookup and
// reports its own cost (real cost, not `costUnits`'s nominal estimate — see each rung's own
// cachedCall wiring in rungs/*.ts).

export type ContactKind = "email" | "phone" | "mobile";

export interface PersonContext {
  id?: string;
  fullName: string;
  firstName?: string;
  lastName?: string;
  title?: string;
  linkedinUrl?: string;
}

/** Everything a rung might need. Not every rung uses every field — e.g. only leadmagic_mobile reads
 *  `email`, only dbprPhone/siteTel read `city`/`websiteUrl`. Kept as one bag (this codebase's
 *  convention — see signals/types.ts's CompanySignalInput / SignalRunDeps) so adding a tenth rung
 *  later never means widening every existing rung's signature. */
export interface RungContext {
  companyId: string;
  companyName: string;
  /** Normalized etld+1, no scheme/www — e.g. "acmeroofing.com". Undefined when the company has no
   *  website_url, which most free/paid email rungs can't work without. */
  domain?: string;
  websiteUrl?: string;
  city?: string;
  state?: string;
  /** The company's main line, as Places/discovery already captured it — the free "office" phone the
   *  placesPhone rung just copies into contact_methods rather than looking anything up. */
  officePhone?: string;
  person?: PersonContext;
  fitScore: number;
  /** prospectingMode() === "active" — threaded down rather than re-read per rung so a shadow-mode
   *  job is consistently shadow for every rung it touches (matches signals/types.ts's allowLive). */
  allowLive: boolean;
  jobId?: string;
  /** The verified/likely_valid email just found by the email waterfall — only read by the mobile
   *  waterfall's leadmagic_mobile rung (LeadMagic's mobile-finder takes a work email). */
  email?: string;
}

export interface RungHit {
  hit: true;
  kind: ContactKind;
  value: string;
  provider: string;
  confidence: number;
  verificationStatus: import("./verification").VerificationStatus;
  sourceUrl?: string;
  costUsd: number;
  raw?: unknown;
}

export interface RungMiss {
  hit: false;
  costUsd: number;
  reason: string;
}

export type RungCallResult = RungHit | RungMiss;

export interface Rung {
  id: string;
  /** Checked against process.env — NOT a boolean, so a test can pass a fake env object without
   *  mutating process.env itself. */
  enabled: (env: NodeJS.ProcessEnv) => boolean;
  gate: (ctx: RungContext) => boolean;
  /** Nominal/documented cost (rates.json) — informational only (shown in logs/UI); the waterfall's
   *  running total uses each call's REPORTED costUsd, which is $0 on a cache hit or a shadow-mode
   *  skip regardless of this number. */
  costUnits: number;
  call: (ctx: RungContext) => Promise<RungCallResult>;
}

export interface WaterfallLogEntry {
  id: string;
  outcome: "hit" | "miss" | "skipped";
  reason?: string;
  costUsd: number;
}

export interface WaterfallResult {
  result: RungHit | null;
  log: WaterfallLogEntry[];
  totalCostUsd: number;
}

/**
 * Runs `rungs` in order against `ctx`, stopping at the first hit. Every rung produces exactly one
 * log entry: "skipped" (not_configured or gated — no I/O, no cost), or "hit"/"miss" (call() ran).
 * Never throws — a rung whose call() rejects is treated as a $0 miss with the error as its reason,
 * so one rung's bug never aborts the rest of the waterfall.
 */
export async function runWaterfall(rungs: readonly Rung[], ctx: RungContext, env: NodeJS.ProcessEnv = process.env): Promise<WaterfallResult> {
  const log: WaterfallLogEntry[] = [];
  let totalCostUsd = 0;

  for (const rung of rungs) {
    if (!rung.enabled(env)) {
      log.push({ id: rung.id, outcome: "skipped", reason: "not_configured", costUsd: 0 });
      continue;
    }
    if (!rung.gate(ctx)) {
      log.push({ id: rung.id, outcome: "skipped", reason: "gated", costUsd: 0 });
      continue;
    }

    let r: RungCallResult;
    try {
      r = await rung.call(ctx);
    } catch (e) {
      r = { hit: false, costUsd: 0, reason: e instanceof Error ? e.message : String(e) };
    }
    totalCostUsd += r.costUsd;

    if (r.hit) {
      log.push({ id: rung.id, outcome: "hit", costUsd: r.costUsd });
      return { result: r, log, totalCostUsd };
    }
    log.push({ id: rung.id, outcome: "miss", reason: r.reason, costUsd: r.costUsd });
  }

  return { result: null, log, totalCostUsd };
}
