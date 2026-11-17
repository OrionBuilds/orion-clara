// Clara — "who am I talking to?" for the BUSINESS audience.
//
// Resolves a texter (phone) or emailer to an OS contact and renders a short, factual context block
// for the system prompt: name, company, the readiness scorecard they took (industry, score, band,
// weakest area, when the PDF went out), which follow-ups they've already had from the owner (emails) and
// Clara (texts), whether an opportunity or appointment exists. This is the difference between
// "Hi, how can I help?" and "You scored 23/36 in healthcare; change control was the low cell."
//
// Backed by ONE org-scoped RPC (`scorecard_lead_lookup`, via the OS MCP) so the SMS hot path pays
// one round-trip. Everything returned is CRM data about the person on the other end — safe to
// show them their own record; never includes anything private about the owner or Clara's internals.
import { osClient, osEnabled } from "./osClient";
import { BUSINESS_DOMAIN } from "./owner";

// Fallback links when the CRM row carries no per-contact token (CLARA_BOOKING_URL / CLARA_OUTLINE_URL).
const BOOKING_URL = process.env.CLARA_BOOKING_URL?.trim() || `https://${BUSINESS_DOMAIN}/schedule`;
const OUTLINE_URL = process.env.CLARA_OUTLINE_URL?.trim() || `https://${BUSINESS_DOMAIN}/outline`;

export interface LeadContext {
  contactId: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  company: string | null;
  tags: string[];
  isScorecardLead: boolean;
  scorecard: {
    completedAt: string;
    industry: string | null;
    industryName: string | null;
    score: number | null;
    band: string | null;
    bandTitle: string | null;
    weakestArea: string | null;
    areaScores: Record<string, number> | null;
  } | null;
  /** Flat drip tokens from the latest scorecard submission (first_name, weakest, pain, proof, outline_url, …). */
  tokens: Record<string, unknown>;
  smsStepsSent: number[];
  emailsSent: string[]; // E2/E3/E4
  inboundMessages: number;
  opportunity: { stage: string | null; name: string | null } | null;
  appointment: { startAtUtc: string; status: string | null } | null;
  smsConsent: boolean;
}

function unwrap(content: unknown): unknown {
  if (Array.isArray(content)) {
    const first = content.find((c) => c && typeof c === "object" && "text" in (c as object));
    if (first && typeof (first as { text?: unknown }).text === "string") {
      try { return JSON.parse((first as { text: string }).text); } catch { return (first as { text: string }).text; }
    }
  }
  return content;
}

const AREA_NAMES: Record<string, string> = {
  access: "access",
  logging: "logging",
  data_location: "data location",
  change_control: "change control",
  failure_handling: "failure handling",
  vendor_review: "vendor review",
};

export function areaName(id: string | null | undefined): string | null {
  if (!id) return null;
  return AREA_NAMES[id] ?? id.replace(/_/g, " ");
}

/** Resolve by phone and/or email. Null when the OS isn't configured or nobody matches. */
export async function lookupLead(opts: { phone?: string; email?: string }): Promise<LeadContext | null> {
  if (!osEnabled()) return null;
  if (!opts.phone && !opts.email) return null;
  let raw: unknown;
  try {
    raw = unwrap(await osClient.callTool("scorecard_lead_lookup", { phone: opts.phone, email: opts.email }));
  } catch (e) {
    console.warn("[clara-leadContext] lookup failed:", e instanceof Error ? e.message : e);
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (!r.contact_id) return null;

  const cf = (r.custom_fields ?? {}) as Record<string, unknown>;
  const sc = (r.scorecard ?? null) as Record<string, unknown> | null;
  const tokens = (r.drip_tokens ?? {}) as Record<string, unknown>;
  const stepRows = (Array.isArray(r.sms_steps_sent) ? r.sms_steps_sent : []) as Array<{ step?: string | number }>;
  const emailRows = (Array.isArray(r.emails_sent) ? r.emails_sent : []) as Array<{ step?: string }>;
  const opp = (r.opportunity ?? null) as Record<string, unknown> | null;
  const appt = (r.appointment ?? null) as Record<string, unknown> | null;

  const num = (v: unknown): number | null => (typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v)) ? Number(v) : null);
  const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

  return {
    contactId: String(r.contact_id),
    firstName: str(r.first_name) ?? "",
    lastName: str(r.last_name) ?? "",
    email: str(r.email),
    phone: str(r.phone),
    company: str(r.company),
    tags: (Array.isArray(r.tags) ? r.tags : []).map(String),
    isScorecardLead: r.is_scorecard_lead === true,
    scorecard: sc
      ? {
          completedAt: String(sc.completed_at ?? ""),
          industry: str(sc.industry),
          industryName: str(sc.industry_name),
          score: num(sc.score),
          band: str(sc.band),
          bandTitle: str(sc.band_title),
          weakestArea: str(sc.weakest_area),
          areaScores: (sc.area_scores && typeof sc.area_scores === "object" ? sc.area_scores : null) as Record<string, number> | null,
        }
      : null,
    tokens,
    smsStepsSent: stepRows.map((x) => Number(x.step)).filter((n) => Number.isFinite(n)),
    emailsSent: emailRows.map((x) => String(x.step ?? "")).filter(Boolean),
    inboundMessages: num(r.inbound_messages) ?? 0,
    opportunity: opp ? { stage: str(opp.stage), name: str(opp.name) } : null,
    appointment: appt ? { startAtUtc: String(appt.start_at_utc ?? ""), status: str(appt.status) } : null,
    smsConsent: cf.sms_consent === true || cf.sms_consent === "true",
  };
}

function daysAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return "";
  const d = Math.floor(ms / 86_400_000);
  if (d <= 0) return "today";
  if (d === 1) return "yesterday";
  return `${d} days ago`;
}

/**
 * Prompt block. Facts only, in the order Clara needs them mid-conversation. Empty for unknowns so
 * the stranger path is byte-identical to before when there's no match.
 */
export function leadContextBlock(lead: LeadContext | null): string {
  if (!lead) return "";
  const lines: string[] = [];
  const name = `${lead.firstName} ${lead.lastName}`.trim() || "this contact";
  lines.push(`Who you're talking to (from our CRM): ${name}${lead.company ? `, ${lead.company}` : ""}.`);
  if (lead.scorecard) {
    const s = lead.scorecard;
    const when = s.completedAt ? ` ${daysAgo(s.completedAt)}` : "";
    const score = s.score != null ? `${s.score}/36` : "unknown score";
    const band = s.bandTitle ?? s.band ?? "";
    const weakest = areaName(s.weakestArea);
    lines.push(
      `They took the AI & Compliance Readiness Scorecard${when} for ${s.industryName ?? s.industry ?? "their industry"}: ${score}${band ? ` (${band})` : ""}${weakest ? `; lowest control area was ${weakest}` : ""}. The owner's results email with the one-pager PDF went out right after.`,
    );
    if (s.areaScores) {
      const cells = Object.entries(s.areaScores)
        .map(([k, v]) => `${areaName(k)} ${v}/6`)
        .join(", ");
      if (cells) lines.push(`Control map: ${cells}. An area is "ready" at 4 of 6.`);
    }
  }
  if (lead.emailsSent.length) lines.push(`The owner has since emailed them: ${lead.emailsSent.join(", ")} (E2 = weakest-control fix, E3 = the 30-day story + Sprint outline link, E4 = "worth a conversation?").`);
  if (lead.smsStepsSent.length) lines.push(`You have already texted them step${lead.smsStepsSent.length > 1 ? "s" : ""} ${lead.smsStepsSent.join(", ")} of your 4-text follow-up (1 = intro, 2 = one question, 3 = outline nudge, 4 = closing with the calendar link).`);
  if (lead.opportunity) lines.push(`There is an open opportunity for them in our pipeline${lead.opportunity.stage ? ` (stage: ${lead.opportunity.stage})` : ""}.`);
  if (lead.appointment) lines.push(`They have a call booked with the owner for ${lead.appointment.startAtUtc} (UTC). Confirm, don't re-sell.`);
  if (lead.tags.includes("closed-no")) lines.push(`They previously said no to sales follow-up. Answer only what they ask; do not pitch.`);
  if (lead.tags.includes("later")) lines.push(`They previously asked us to check back later.`);
  lines.push(
    `Use this to be specific and useful. If they want the call, give them the booking link ${String(lead.tokens.book_url ?? BOOKING_URL)}. If they ask for the Sprint outline, the link is ${String(lead.tokens.outline_url ?? OUTLINE_URL)}?c=${lead.contactId}. Never quote a price; the owner scopes that on the call.`,
  );
  return `\n\n${lines.join("\n")}`;
}
