// §20 — funnel priors: what fraction of companies survive each gate.
//
// The blueprint's example (10,000 discovered → 5,800 roofing → 3,400 live sites → 2,100 basic ICP
// → 1,200 qualified → 1,200 decision makers → 900 emails → 400 mobiles asked → 240 found) seeds the
// ratios; every finished job nudges them toward what actually happened (EMA, alpha 0.3), so the
// second Tampa estimate is closer than the first. Kept as a small JSON file next to the ledgers.

import { promises as fs } from "node:fs";
import path from "node:path";
import type { FunnelCounts } from "./types";

/** Each ratio is relative to the previous step, except mobile_requested (share of ai_qualified). */
export interface Priors {
  in_industry: number;
  active_website: number;
  pass_icp: number;
  ai_qualified: number;
  dm_found: number;
  email_found: number;
  mobile_requested: number;
  mobile_found: number;
  /** How many jobs have fed these numbers. */
  samples: number;
}

export const DEFAULT_PRIORS: Priors = {
  in_industry: 0.58,
  active_website: 0.586,
  pass_icp: 0.618,
  ai_qualified: 0.571,
  dm_found: 1.0,
  email_found: 0.75,
  mobile_requested: 0.333,
  mobile_found: 0.6,
  samples: 0,
};

const ALPHA = 0.3;
const RATIO_KEYS = ["in_industry", "active_website", "pass_icp", "ai_qualified", "dm_found", "email_found", "mobile_requested", "mobile_found"] as const;

/** Pure: expected counts at every step from a discovered count. Always integers, never negative. */
export function applyPriors(discovered: number, p: Priors = DEFAULT_PRIORS): FunnelCounts {
  const d = Math.max(0, Math.round(discovered));
  const in_industry = Math.round(d * p.in_industry);
  const active_website = Math.round(in_industry * p.active_website);
  const pass_icp = Math.round(active_website * p.pass_icp);
  const ai_qualified = Math.round(pass_icp * p.ai_qualified);
  const dm_found = Math.round(ai_qualified * p.dm_found);
  const email_found = Math.round(dm_found * p.email_found);
  const mobile_requested = Math.round(ai_qualified * p.mobile_requested);
  const mobile_found = Math.round(mobile_requested * p.mobile_found);
  return { discovered: d, in_industry, active_website, pass_icp, ai_qualified, dm_found, email_found, mobile_requested, mobile_found };
}

/** Pure: fold one finished job's real funnel into the priors. Steps with no data leave the prior alone. */
export function updatePriors(prev: Priors, actual: Partial<FunnelCounts>): Priors {
  const next: Priors = { ...prev, samples: prev.samples + 1 };
  const ratio = (num: number | undefined, den: number | undefined) =>
    typeof num === "number" && typeof den === "number" && den > 0 ? Math.min(1, Math.max(0, num / den)) : undefined;
  const observed: Partial<Record<(typeof RATIO_KEYS)[number], number | undefined>> = {
    in_industry: ratio(actual.in_industry, actual.discovered),
    active_website: ratio(actual.active_website, actual.in_industry),
    pass_icp: ratio(actual.pass_icp, actual.active_website),
    ai_qualified: ratio(actual.ai_qualified, actual.pass_icp),
    dm_found: ratio(actual.dm_found, actual.ai_qualified),
    email_found: ratio(actual.email_found, actual.dm_found),
    mobile_requested: ratio(actual.mobile_requested, actual.ai_qualified),
    mobile_found: ratio(actual.mobile_found, actual.mobile_requested),
  };
  for (const k of RATIO_KEYS) {
    const o = observed[k];
    if (o === undefined) continue;
    next[k] = Number((prev[k] * (1 - ALPHA) + o * ALPHA).toFixed(4));
  }
  return next;
}

async function priorsFile(): Promise<string> {
  const { loadConfig } = await import("../config");
  const cfg = await loadConfig();
  const dir = path.join(cfg.dataDir, "prospecting");
  await fs.mkdir(dir, { recursive: true });
  return path.join(dir, "priors.json");
}

export async function loadPriors(): Promise<Priors> {
  try {
    const raw = JSON.parse(await fs.readFile(await priorsFile(), "utf8")) as Partial<Priors>;
    return { ...DEFAULT_PRIORS, ...raw };
  } catch {
    return { ...DEFAULT_PRIORS };
  }
}

export async function recordJobActuals(actual: Partial<FunnelCounts>): Promise<Priors> {
  const next = updatePriors(await loadPriors(), actual);
  await fs.writeFile(await priorsFile(), JSON.stringify(next, null, 2), "utf8").catch(() => {});
  return next;
}
