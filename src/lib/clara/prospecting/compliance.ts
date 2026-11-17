// compliance.ts — CAN-SPAM + basic outreach hygiene (plan §38). The MEGA_DOMAINS/OPTOUT_RE/
// unsubMailto/appendOptOut/isOptOutReply/domainSize helpers are a direct port of FRIDAY's
// src/lib/outreach.ts (same module doc note there: "port, not reuse" — FRIDAY is a separate app
// with its own deploy, so this is a copy kept in sync by hand, not a shared import). Everything
// below that is new: the role-address check, the sendability/mega-domain/role combinator stage 85's
// own `isValidForSend`-type gate will want, the suppression-check wrapper, and the per-contact/
// company/global send quotas the sequence runner (PR 14) enforces every tick.

import { suppressionsCheck as suppressionsCheckReal } from "./osBridge";
import { isSendable, type VerificationStatus } from "./contacts/verification";

// ── Ported from FRIDAY src/lib/outreach.ts (2026-06-24 era code) ──────────────────────────────

export type CompanySize = "small" | "mid" | "large" | "unknown";

/** Giant platforms / public companies that won't answer cold outreach. Seeded with the domains
 *  that bounced FRIDAY's June campaign + the obvious household names — identical list, ported
 *  verbatim rather than re-curated, so both apps keep refusing the same domains. */
export const MEGA_DOMAINS = new Set<string>([
  "appsumo.com", "capterra.com", "g2.com", "producthunt.com", "angel.co", "ycombinator.com",
  "indiehackers.com", "dev.to", "medium.com", "notion.so", "zapier.com", "integromat.com",
  "make.com", "airtable.com", "webflow.com", "stripe.com", "google.com", "youtube.com",
  "facebook.com", "meta.com", "instagram.com", "amazon.com", "aws.amazon.com", "apple.com",
  "microsoft.com", "linkedin.com", "twitter.com", "x.com", "tiktok.com", "salesforce.com",
  "hubspot.com", "shopify.com", "adobe.com", "oracle.com", "ibm.com", "intercom.com",
  "slack.com", "atlassian.com", "canva.com", "figma.com", "wix.com", "squarespace.com",
  "mailchimp.com", "semrush.com", "ahrefs.com", "moz.com", "wordpress.com", "godaddy.com",
  "cloudflare.com", "openai.com", "anthropic.com", "gartner.com", "forbes.com", "techcrunch.com",
  "wikipedia.org", "reddit.com", "quora.com", "trustpilot.com", "yelp.com", "crunchbase.com",
]);

/** Pure. "large" for a known mega domain (or a subdomain of one, e.g. blog.hubspot.com) — matches
 *  FRIDAY's own behavior of never actually classifying "small"/"mid" (nothing in either app reads
 *  those branches today; the CompanySize union still names them for a future caller). */
export function domainSize(domain: string): CompanySize {
  const d = (domain || "").toLowerCase().replace(/^www\./, "");
  if (MEGA_DOMAINS.has(d)) return "large";
  for (const m of MEGA_DOMAINS) if (d.endsWith(`.${m}`)) return "large";
  return "unknown";
}

/** A reply is an opt-out request if it asks to stop / unsubscribe / be removed. */
export const OPTOUT_RE = /\b(unsubscribe|opt[\s-]?out|stop|remove me|take me off|do not (contact|email))\b/i;
export function isOptOutReply(subject: string, snippet?: string): boolean {
  return OPTOUT_RE.test(`${subject || ""} ${snippet || ""}`);
}

export function unsubMailto(from: string, lead: { domain?: string }): string {
  const subj = encodeURIComponent(`unsubscribe ${lead.domain || ""}`.trim());
  return `mailto:${from}?subject=${subj}`;
}
export function appendOptOut(body: string, from: string): string {
  return body.replace(/\s+$/, "")
    + `\n\n—\nNot interested? Just reply STOP and I won't email you again.`
    + `\nYou can also email ${from} with "unsubscribe" in the subject.`;
}

// ── Role addresses (plan: "not role@ unless only verified address and allow_role") ─────────────

const ROLE_LOCALPARTS: ReadonlySet<string> = new Set([
  "info", "contact", "sales", "support", "office", "admin", "hello", "service", "help", "team",
  "billing", "accounts", "noreply", "no-reply", "webmaster", "postmaster",
]);
export function isRoleAddress(email: string): boolean {
  const local = email.split("@")[0]?.toLowerCase() ?? "";
  return ROLE_LOCALPARTS.has(local);
}

// ── The send gate email steps run every outbound email through (plan §38 checklist) ────────────

export interface SendGateInput {
  email: string;
  verificationStatus: VerificationStatus;
  /** True only when this address is the one and only method on file for the company/person — the
   *  plan's narrow exception ("not role@ unless only verified address and allow_role"). */
  isOnlyAddress: boolean;
  allowRole: boolean;
}
export interface SendGateDecision {
  ok: boolean;
  reason?: "mega_domain" | "role_address" | "not_sendable";
}

/** Pure. Combines the mega-domain, role-address and verification-status rules into the single
 *  pass/fail check every email step (PR 14's sequenceRunner) runs before rendering a send. */
export function sendGate(input: SendGateInput): SendGateDecision {
  const domain = input.email.split("@")[1] ?? "";
  if (domainSize(domain) === "large") return { ok: false, reason: "mega_domain" };
  if (isRoleAddress(input.email) && !(input.isOnlyAddress && input.allowRole)) return { ok: false, reason: "role_address" };
  if (!isSendable(input.verificationStatus)) return { ok: false, reason: "not_sendable" };
  return { ok: true };
}

// ── Suppression client (wraps osBridge.suppressionsCheck — PR 11's own wrapper) ────────────────

export interface SuppressionCheckInput {
  channel: "email" | "sms" | "voice" | "all";
  email?: string;
  phone?: string;
  domain?: string;
  companyId?: string;
  contactId?: string;
}
export interface SuppressionCheckDeps {
  suppressionsCheck: typeof suppressionsCheckReal;
}
export const defaultSuppressionCheckDeps: SuppressionCheckDeps = { suppressionsCheck: suppressionsCheckReal };

export async function checkSuppressed(input: SuppressionCheckInput, deps: SuppressionCheckDeps = defaultSuppressionCheckDeps): Promise<{ blocked: boolean; hits: unknown[] }> {
  return deps.suppressionsCheck({
    channel: input.channel,
    email: input.email,
    phone: input.phone,
    domain: input.domain,
    company_id: input.companyId,
    contact_id: input.contactId,
  });
}

// ── Quotas (plan §38: "global 50/day (setting), contact 1/day, company 1/day & 3/week") ────────

export interface EmailQuotas {
  globalPerDay: number;
  contactPerDay: number;
  companyPerDay: number;
  companyPerWeek: number;
}
/** Defaults match the plan exactly; globalPerDay is normally overridden by the live
 *  prospect_settings.global_email_per_day (an org setting, not a hardcoded constant — see
 *  osBridge.ts's ProspectSettings). */
export const DEFAULT_EMAIL_QUOTAS: EmailQuotas = { globalPerDay: 50, contactPerDay: 1, companyPerDay: 1, companyPerWeek: 3 };

export interface QuotaCounts {
  globalToday: number;
  contactToday: number;
  companyToday: number;
  companyThisWeek: number;
}
export interface QuotaDecision {
  blocked: boolean;
  reason?: "global_daily_cap" | "contact_daily_cap" | "company_daily_cap" | "company_weekly_cap";
}

/** Pure. Checked in this exact order — global first (the hardest, most compliance-sensitive
 *  ceiling), then narrowing to the specific recipient/company — so the reported reason is always
 *  the FIRST cap actually hit, not an arbitrary one. */
export function checkEmailQuota(counts: QuotaCounts, quotas: EmailQuotas = DEFAULT_EMAIL_QUOTAS): QuotaDecision {
  if (counts.globalToday >= quotas.globalPerDay) return { blocked: true, reason: "global_daily_cap" };
  if (counts.contactToday >= quotas.contactPerDay) return { blocked: true, reason: "contact_daily_cap" };
  if (counts.companyToday >= quotas.companyPerDay) return { blocked: true, reason: "company_daily_cap" };
  if (counts.companyThisWeek >= quotas.companyPerWeek) return { blocked: true, reason: "company_weekly_cap" };
  return { blocked: false };
}
