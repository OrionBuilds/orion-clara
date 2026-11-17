// contacts/rungs/siteMailto.ts — email rung 1: scan the company's own homepage for a mailto: link
// on its own domain. Free (http is $0 in rates.json), so this rung has no `enabled` gate at all and
// always runs first — the plan's "free email rungs first" rule in its simplest form.
//
// Not a full site crawl: stage 40 already crawled up to 6 pages for extraction (PR 7/8); re-reading
// that evidence would mean threading company_sources lookups through this rung for a marginal gain,
// so this rung does its OWN single homepage fetch instead, exactly like signals/checks/techChange.ts
// re-crawls the homepage rather than reusing stage-40's evidence. Still free either way.

import { crawlPage as crawlPageReal } from "../../crawler/waterfall";
import type { Rung, RungCallResult, RungContext } from "../waterfall";

const MAILTO_RE = /mailto:([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})/gi;

/** Generic role-address local-parts — a hit here is still returned (better than nothing), but with
 *  lower confidence and ranked behind any non-role address found on the same page. */
const ROLE_LOCALPARTS: ReadonlySet<string> = new Set([
  "info", "contact", "sales", "support", "office", "admin", "hello", "service", "help", "team",
]);

export interface MailtoMatch {
  value: string;
  isRole: boolean;
}

/** Pure: every distinct @domain mailto address in `text`, role addresses flagged (not excluded —
 *  the caller decides). `domain` filters out addresses on an unrelated domain (a webmaster@gmail.com
 *  support link, say) when provided; undefined domain accepts anything. */
export function extractMailtoEmails(text: string, domain?: string): MailtoMatch[] {
  const seen = new Set<string>();
  const out: MailtoMatch[] = [];
  const re = new RegExp(MAILTO_RE);
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const email = m[1].toLowerCase();
    if (seen.has(email)) continue;
    if (domain && !email.endsWith(`@${domain}`)) continue;
    seen.add(email);
    out.push({ value: email, isRole: ROLE_LOCALPARTS.has(email.split("@")[0]) });
  }
  return out;
}

export interface SiteMailtoDeps {
  crawlPage: typeof crawlPageReal;
  readFile: (path: string) => Promise<string>;
}

async function defaultReadFile(path: string): Promise<string> {
  const { promises: fs } = await import("node:fs");
  return fs.readFile(path, "utf8");
}

export const defaultSiteMailtoDeps: SiteMailtoDeps = { crawlPage: crawlPageReal, readFile: defaultReadFile };

export async function callSiteMailto(ctx: RungContext, deps: SiteMailtoDeps = defaultSiteMailtoDeps): Promise<RungCallResult> {
  if (!ctx.websiteUrl) return { hit: false, costUsd: 0, reason: "no website_url" };

  const page = await deps.crawlPage(ctx.websiteUrl, { companyId: ctx.companyId, jobId: ctx.jobId }).catch((e) => {
    throw e instanceof Error ? e : new Error(String(e));
  });
  if (!page.ok || !page.evidence) return { hit: false, costUsd: 0, reason: page.reason ?? page.error ?? "homepage fetch failed" };

  const text = await deps.readFile(page.evidence.txtPath).catch(() => "");
  const matches = extractMailtoEmails(text, ctx.domain);
  if (!matches.length) return { hit: false, costUsd: 0, reason: "no mailto: link found" };

  const chosen = matches.find((m) => !m.isRole) ?? matches[0];
  return {
    hit: true,
    kind: "email",
    value: chosen.value,
    provider: "website",
    confidence: chosen.isRole ? 0.35 : 0.65,
    // A mailto link is neither finder-verified nor independently checked — "unknown" until stage 87
    // runs a real verify call (see contacts/verification.ts's finder-only note: this ISN'T even a
    // finder call, so it doesn't even earn likely_valid yet).
    verificationStatus: "unknown",
    sourceUrl: ctx.websiteUrl,
    costUsd: 0,
  };
}

export const siteMailtoRung: Rung = {
  id: "site_mailto",
  enabled: () => true,
  gate: () => true,
  costUnits: 0,
  call: (ctx) => callSiteMailto(ctx),
};
