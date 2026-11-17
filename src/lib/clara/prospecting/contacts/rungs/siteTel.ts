// contacts/rungs/siteTel.ts — mobile-waterfall rung 3: scan the company's homepage for a tel: link.
// Same free, single-fetch shape as contacts/rungs/siteMailto.ts (and the same rationale for not
// reusing stage 40's crawl evidence — see that file's doc comment). Classified as kind "phone" (an
// office line a website publishes is, by its nature, a public-facing number, not a decision maker's
// personal cell) — only leadmagic_mobile, the final rung, can produce a true "mobile".

import { crawlPage as crawlPageReal } from "../../crawler/waterfall";
import { normalizePhone } from "../../../dnc";
import type { Rung, RungCallResult, RungContext } from "../waterfall";

const TEL_RE = /tel:([+\d()\-.\s]{7,20})/gi;

/** Pure: every distinct tel: link in `text`, normalized to E.164-ish via dnc.ts's normalizePhone
 *  (the same normalizer the SMS/outbound governor uses, so a number found here compares equal to
 *  one later seen in a DNC check). */
export function extractTelLinks(text: string): string[] {
  const seen = new Set<string>();
  const re = new RegExp(TEL_RE);
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const normalized = normalizePhone(m[1]);
    if (/^\+?\d{7,15}$/.test(normalized)) seen.add(normalized);
  }
  return [...seen];
}

export interface SiteTelDeps {
  crawlPage: typeof crawlPageReal;
  readFile: (path: string) => Promise<string>;
}

async function defaultReadFile(path: string): Promise<string> {
  const { promises: fs } = await import("node:fs");
  return fs.readFile(path, "utf8");
}

export const defaultSiteTelDeps: SiteTelDeps = { crawlPage: crawlPageReal, readFile: defaultReadFile };

export async function callSiteTel(ctx: RungContext, deps: SiteTelDeps = defaultSiteTelDeps): Promise<RungCallResult> {
  if (!ctx.websiteUrl) return { hit: false, costUsd: 0, reason: "no website_url" };

  const page = await deps.crawlPage(ctx.websiteUrl, { companyId: ctx.companyId, jobId: ctx.jobId });
  if (!page.ok || !page.evidence) return { hit: false, costUsd: 0, reason: page.reason ?? page.error ?? "homepage fetch failed" };

  const text = await deps.readFile(page.evidence.txtPath).catch(() => "");
  const numbers = extractTelLinks(text);
  if (!numbers.length) return { hit: false, costUsd: 0, reason: "no tel: link found" };

  return {
    hit: true,
    kind: "phone",
    value: numbers[0],
    provider: "website",
    confidence: 0.6,
    verificationStatus: "unknown",
    sourceUrl: ctx.websiteUrl,
    costUsd: 0,
  };
}

export const siteTelRung: Rung = {
  id: "site_tel",
  enabled: () => true,
  gate: () => true,
  costUnits: 0,
  call: (ctx) => callSiteTel(ctx),
};
