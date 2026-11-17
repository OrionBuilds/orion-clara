// report/exportSheet.ts — the CSV behind the Drive Sheet (createFile uploads CSV as `as: "sheet"`,
// which Google converts to native Sheets format on upload).

import type { CompanyExportRow } from "./compose";

const HEADERS = ["Name", "Website", "City", "State", "Industry", "Rating", "Reviews", "Fit Score", "Email", "Phone"];

function csvCell(v: unknown): string {
  if (v === undefined || v === null) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function buildCsv(rows: CompanyExportRow[]): string {
  const lines = [HEADERS.join(",")];
  for (const r of rows) {
    lines.push([r.name, r.website, r.city, r.state, r.industry, r.rating, r.reviews, r.fitScore, r.email, r.phone].map(csvCell).join(","));
  }
  return lines.join("\n");
}
