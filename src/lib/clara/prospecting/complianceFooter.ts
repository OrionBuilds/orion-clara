// complianceFooter.ts — the CAN-SPAM footer + headers every prospecting email carries (plan §38):
// a physical address, a working one-click unsubscribe link, and the SMTP headers that put a native
// "Unsubscribe" button in Gmail/Outlook. Pure builders (buildFooterText/buildComplianceHeaders) are
// unit-tested directly; mintUnsubscribeLink is the one function here that touches the OS
// (tracked_links_create — PR 13's new MCP tool) and so takes injected deps like every other
// OS-calling function in this module.

import { trackedLinksCreate as trackedLinksCreateReal, prospectSettingsGet as prospectSettingsGetReal } from "./osBridge";

export const REPLY_TO_ADDRESS = "clara@example.com";

// ── Unsubscribe link ─────────────────────────────────────────────────────────────────────────

/** Pure: the public URL a mail client/recipient actually opens. Built straight off the
 *  Supabase functions base (same `ORION_SUPABASE_URL` osClient.ts already reads) — no separate
 *  short-domain config exists for this yet, so the link is the full functions URL, exactly like
 *  link-redirect's own un-shortened form today. */
export function buildUnsubscribeUrl(slug: string, supabaseUrl: string): string {
  return `${supabaseUrl.replace(/\/+$/, "")}/functions/v1/email-unsubscribe/${slug}`;
}

export interface MintUnsubscribeLinkInput {
  email: string;
  companyId?: string;
  contactId?: string;
  enrollmentId?: string;
}
export interface MintUnsubscribeLinkDeps {
  trackedLinksCreate: typeof trackedLinksCreateReal;
  supabaseUrl: string;
}
export function defaultMintUnsubscribeLinkDeps(): MintUnsubscribeLinkDeps {
  return { trackedLinksCreate: trackedLinksCreateReal, supabaseUrl: process.env.ORION_SUPABASE_URL ?? "" };
}

/** Mints one tracked_links row per call (plan: "one per enrollment×step") and returns the public
 *  unsubscribe URL. `destination_url` is a harmless placeholder — the org's own site — since the
 *  table requires one but email-unsubscribe never reads it (see osBridge.ts's doc comment on
 *  TrackedLinksCreateInput). */
export async function mintUnsubscribeLink(input: MintUnsubscribeLinkInput, deps: MintUnsubscribeLinkDeps = defaultMintUnsubscribeLinkDeps()): Promise<string> {
  const { slug } = await deps.trackedLinksCreate({
    destination_url: "https://example.com",
    contact_id: input.contactId,
    metadata: { kind: "unsubscribe", email: input.email.trim().toLowerCase(), company_id: input.companyId, enrollment_id: input.enrollmentId },
  });
  return buildUnsubscribeUrl(slug, deps.supabaseUrl);
}

// ── Footer text ──────────────────────────────────────────────────────────────────────────────

export interface FooterInput {
  physicalAddress: string;
  unsubscribeUrl: string;
}

/** Pure. A plain-text footer — physical address (CAN-SPAM §3's actual legal requirement) plus the
 *  unsubscribe link as readable text, for the (common) case the recipient is reading in plain text
 *  or the List-Unsubscribe header's native button isn't rendered by their client. */
export function buildFooterText(input: FooterInput): string {
  return `\n\n—\n${input.physicalAddress}\nDon't want these emails? Unsubscribe: ${input.unsubscribeUrl}`;
}

export function appendComplianceFooter(body: string, input: FooterInput): string {
  return body.replace(/\s+$/, "") + buildFooterText(input);
}

// ── Headers ──────────────────────────────────────────────────────────────────────────────────

export interface ComplianceHeadersInput {
  unsubscribeUrl: string;
  /** The domain the send goes out FROM (sender rotation's chosen domain) — the mailto half of
   *  List-Unsubscribe is addressed there, not at Clara's own inbox, so a reply-based unsubscribe
   *  lands on infrastructure that can actually act on it. */
  senderDomain: string;
}

/** Pure. List-Unsubscribe carries BOTH forms (mailto + https) per RFC 8058 — a client that only
 *  understands one still gets a working one-click button; List-Unsubscribe-Post is what makes that
 *  button a true one-click POST instead of opening a compose window. Reply-To is always Clara's own
 *  address (plan: real sender, never Clara-as-the owner) regardless of which domain the send rotated to. */
export function buildComplianceHeaders(input: ComplianceHeadersInput): Record<string, string> {
  const subject = encodeURIComponent("unsubscribe");
  return {
    "List-Unsubscribe": `<mailto:unsub@${input.senderDomain}?subject=${subject}>, <${input.unsubscribeUrl}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    "Reply-To": REPLY_TO_ADDRESS,
  };
}

// ── Physical address (prospect_settings.physical_address) ──────────────────────────────────────

export interface PhysicalAddressDeps {
  prospectSettingsGet: typeof prospectSettingsGetReal;
}
export const defaultPhysicalAddressDeps: PhysicalAddressDeps = { prospectSettingsGet: prospectSettingsGetReal };

/** A missing physical_address is a configuration gap, not a silent omission — CAN-SPAM requires
 *  one on every commercial email, so a caller with none configured should refuse to send rather
 *  than send without it (the sequence runner, PR 14, treats an empty return as a hard stop, not a
 *  blank footer line). */
export async function loadPhysicalAddress(deps: PhysicalAddressDeps = defaultPhysicalAddressDeps): Promise<string | undefined> {
  const settings = await deps.prospectSettingsGet();
  const addr = settings?.physical_address?.trim();
  return addr || undefined;
}
