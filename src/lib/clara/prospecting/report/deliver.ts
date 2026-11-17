// report/deliver.ts — Drive Doc + Sheet under `Prospecting/<job>`, then email via deliverToPrincipal
// pointing at both files and the Office list URL.

import { ensureFolder, createFile } from "../../ms-files";
import { deliverToPrincipal } from "../../deliver";
import { loadConfig } from "../../config";
import type { Job } from "../types";
import { composeSummary, type CompanyExportRow } from "./compose";
import { buildCsv } from "./exportSheet";

export function officeListUrl(listId: string): string {
  const base = (process.env.OFFICE_PUBLIC_URL ?? "https://office.example.com").replace(/\/$/, "");
  return `${base}/prospects/lists/${listId}`;
}

export interface DeliverResult {
  ok: boolean;
  docUrl?: string;
  sheetUrl?: string;
  error?: string;
}

export async function deliverJobReport(job: Job, companies: CompanyExportRow[]): Promise<DeliverResult> {
  const cfg = await loadConfig();
  const parent = cfg.claraDriveId || undefined;
  const prospectingFolder = await ensureFolder("Prospecting", parent);
  const jobFolder = await ensureFolder((job.title || job.id).slice(0, 80), prospectingFolder?.id);

  const summary = composeSummary(job, companies);
  const csv = buildCsv(companies);
  const today = new Date().toISOString().slice(0, 10);

  const doc = await createFile({ name: `Research — ${job.title} — ${today}`, content: summary, as: "doc", folderId: jobFolder?.id });
  const sheet = await createFile({ name: `${job.title} — prospects`, content: csv, as: "sheet", folderId: jobFolder?.id });

  if (!doc.ok && !sheet.ok) {
    return { ok: false, error: doc.error ?? sheet.error ?? "Drive upload failed" };
  }

  const bodyLines = [
    summary,
    "",
    doc.file?.webViewLink ? `Full report: ${doc.file.webViewLink}` : doc.error ? `(report doc failed: ${doc.error})` : "",
    sheet.file?.webViewLink ? `Full list: ${sheet.file.webViewLink}` : sheet.error ? `(list sheet failed: ${sheet.error})` : "",
    job.list_id ? `Office list: ${officeListUrl(job.list_id)}` : "",
  ].filter(Boolean);

  const headsUp = `Prospecting job "${job.title}" ${job.status === "completed" ? "finished" : "updated"} — ${companies.length} companies.${doc.file?.webViewLink ? ` ${doc.file.webViewLink}` : ""}`;
  const d = await deliverToPrincipal("owner", `Prospecting — ${job.title}`, bodyLines.join("\n"), headsUp);

  return { ok: d.ok, docUrl: doc.file?.webViewLink, sheetUrl: sheet.file?.webViewLink, error: d.ok ? undefined : d.error };
}
