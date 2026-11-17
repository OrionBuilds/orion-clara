// report/compose.ts — the plain-text summary that goes into the Drive Doc + the delivery email.

import type { FunnelCounts, Job } from "../types";

export interface CompanyExportRow {
  name: string;
  website?: string;
  city?: string;
  state?: string;
  industry?: string;
  rating?: number;
  reviews?: number;
  fitScore?: number;
  email?: string;
  phone?: string;
}

export function funnelSummaryLines(funnel: Partial<FunnelCounts>): string[] {
  return [
    `Discovered: ${funnel.discovered ?? 0}`,
    `In industry: ${funnel.in_industry ?? 0}`,
    `Active website: ${funnel.active_website ?? 0}`,
    `Passed basic ICP: ${funnel.pass_icp ?? 0}`,
    `AI qualified: ${funnel.ai_qualified ?? 0}`,
    `Decision makers found: ${funnel.dm_found ?? 0}`,
    `Emails found: ${funnel.email_found ?? 0}`,
    `Mobiles requested: ${funnel.mobile_requested ?? 0}`,
    `Mobiles found: ${funnel.mobile_found ?? 0}`,
  ];
}

export function composeSummary(job: Pick<Job, "title" | "request_text" | "status" | "spend_usd" | "budget_usd" | "funnel">, companies: CompanyExportRow[]): string {
  const lines: string[] = [];
  lines.push(`Prospecting job: ${job.title}`);
  lines.push(`Request: ${job.request_text}`);
  lines.push(`Status: ${job.status}`);
  lines.push(`Spend: $${(job.spend_usd ?? 0).toFixed(2)} of $${(job.budget_usd ?? 0).toFixed(2)} budget`);
  lines.push("");
  lines.push("Funnel:");
  lines.push(...funnelSummaryLines(job.funnel ?? {}));
  lines.push("");
  if (companies.length) {
    const shown = Math.min(companies.length, 20);
    lines.push(`Top prospects (${shown} of ${companies.length}):`);
    for (const c of companies.slice(0, shown)) {
      const bits = [c.city ? `${c.city}${c.state ? `, ${c.state}` : ""}` : "", c.fitScore != null ? `fit ${c.fitScore}` : "", c.website ?? ""].filter(Boolean);
      lines.push(`- ${c.name}${bits.length ? ` — ${bits.join(" — ")}` : ""}`);
    }
  } else {
    lines.push("No prospects to list yet.");
  }
  return lines.join("\n");
}
