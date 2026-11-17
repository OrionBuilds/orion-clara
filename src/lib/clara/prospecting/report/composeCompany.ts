// report/composeCompany.ts — PR 12: the plain-text body of the per-company "Research —
// {company} — {date}" Drive doc created on promotion. Pure (takes the already-fetched
// companies_get envelope + companies_timeline rows + an optional call brief, returns text) —
// mirrors report/compose.ts's job-level composeSummary, one level down at the company.
//
// Sections, in the plan's stated order: summary, timeline, top facts, people, tech stack, signals,
// call brief.

import type { CompanyFullRow, CompanyTimelineRow } from "../osBridge";
import type { CallBrief } from "../intel/callBrief";

function str(v: unknown): string {
  return typeof v === "string" ? v : v === null || v === undefined ? "" : String(v);
}
function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function fmtFactValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function composeSummarySection(company: Record<string, unknown>): string[] {
  const lines: string[] = [];
  const city = str(company.city);
  const state = str(company.state);
  const location = [city, state].filter(Boolean).join(", ");
  const fit = num(company.fit_score);
  const rating = num(company.rating);
  const reviews = num(company.review_count);
  lines.push(`${str(company.name) || "Unnamed company"}${location ? ` — ${location}` : ""}`);
  if (company.website_url) lines.push(`Website: ${str(company.website_url)}`);
  if (fit !== undefined) lines.push(`Fit score: ${fit}`);
  if (rating !== undefined || reviews !== undefined) lines.push(`Google: ${rating ?? "—"}★ (${reviews ?? 0} reviews)`);
  const industry = company.industry;
  if (Array.isArray(industry) && industry.length) lines.push(`Industry: ${industry.join(", ")}`);
  const revLow = num(company.revenue_low), revHigh = num(company.revenue_high);
  if (revLow !== undefined || revHigh !== undefined) {
    lines.push(`Estimated revenue: $${(revLow ?? 0).toLocaleString()}–$${(revHigh ?? revLow ?? 0).toLocaleString()}`);
  }
  return lines;
}

export function composeTimelineSection(timeline: CompanyTimelineRow[]): string[] {
  if (!timeline.length) return ["(no timeline events yet)"];
  return timeline.slice(0, 20).map((t) => {
    const when = t.occurred_at ? new Date(t.occurred_at).toISOString().slice(0, 10) : "?";
    return `- ${when} — ${t.event_type ?? "event"}${t.summary ? `: ${t.summary}` : ""}`;
  });
}

export function composeFactsSection(facts: CompanyFullRow["facts"], max = 15): string[] {
  if (!facts.length) return ["(no facts recorded yet)"];
  const sorted = [...facts].sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
  return sorted.slice(0, max).map((f) => `- ${f.field_name}: ${fmtFactValue(f.value)}${f.confidence !== undefined ? ` (confidence ${Math.round(f.confidence * 100)}%)` : ""}`);
}

export function composePeopleSection(people: CompanyFullRow["people"], methods: CompanyFullRow["contact_methods"]): string[] {
  if (!people.length) return ["(no decision maker identified yet)"];
  return people.map((p) => {
    const name = str(p.full_name) || "Unnamed";
    const title = str(p.title);
    const own = methods.filter((m) => m.person_id === p.id);
    const email = own.find((m) => m.kind === "email");
    const phone = own.find((m) => m.kind === "mobile") ?? own.find((m) => m.kind === "phone");
    const bits = [
      title ? title : undefined,
      email ? `${str(email.value)} (${str(email.verification_status)})` : undefined,
      phone ? `${str(phone.value)} (${str(phone.kind)})` : undefined,
    ].filter(Boolean);
    return `- ${name}${bits.length ? ` — ${bits.join(" · ")}` : ""}`;
  });
}

export function composeTechSection(tech: CompanyFullRow["technologies"]): string[] {
  if (!tech.length) return ["(no technology detected yet)"];
  return tech.map((t) => `- ${str(t.category)}: ${str(t.name)}${t.vendor ? ` (${str(t.vendor)})` : ""}`);
}

export function composeSignalsSection(signals: CompanyFullRow["signals"], max = 10): string[] {
  if (!signals.length) return ["(no buying signals yet)"];
  return signals.slice(0, max).map((s) => {
    const when = s.observed_at ? new Date(str(s.observed_at)).toISOString().slice(0, 10) : "?";
    return `- ${when} — ${str(s.headline)}`;
  });
}

export function composeCallBriefSection(brief: CallBrief | undefined): string[] {
  if (!brief) return ["(call brief unavailable)"];
  const lines = [`Opener: ${brief.opener}`, ""];
  if (brief.talkingPoints.length) {
    lines.push("Talking points:");
    lines.push(...brief.talkingPoints.map((p) => `- ${p}`));
    lines.push("");
  }
  if (brief.objections.length) {
    lines.push("Likely objections:");
    for (const o of brief.objections) lines.push(`- "${o.objection}" → ${o.response}`);
  }
  return lines;
}

export function composeCompanyResearchDoc(full: CompanyFullRow, timeline: CompanyTimelineRow[], brief: CallBrief | undefined, date: string): string {
  const lines: string[] = [];
  lines.push(`Research — ${str(full.company.name) || "Unnamed company"} — ${date}`);
  lines.push("");
  lines.push("## Summary");
  lines.push(...composeSummarySection(full.company));
  lines.push("");
  lines.push("## Timeline");
  lines.push(...composeTimelineSection(timeline));
  lines.push("");
  lines.push("## Top facts");
  lines.push(...composeFactsSection(full.facts));
  lines.push("");
  lines.push("## People");
  lines.push(...composePeopleSection(full.people, full.contact_methods));
  lines.push("");
  lines.push("## Tech stack");
  lines.push(...composeTechSection(full.technologies));
  lines.push("");
  lines.push("## Signals");
  lines.push(...composeSignalsSection(full.signals));
  lines.push("");
  lines.push("## Call brief");
  lines.push(...composeCallBriefSection(brief));
  return lines.join("\n");
}
