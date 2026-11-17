// Clara — vendor shortlist + quote outreach.
//
// Sources 2–3 candidates from vault vendor history (+ optional LLM suggestions), drafts a
// quote-request email to each, and holds the responses for the owner's pick. Clara has no
// purchase power, so there's no "hire" step here — see the note at the bottom of this file.

import { promises as fs } from "node:fs";
import path from "node:path";
import { loadConfig } from "./config";
import { draft as approvalDraft } from "./approvals";
import { sendMail } from "./ms-mail";
import { gateOutbound, recordSent, enqueue } from "./outbound";
import type { Approval } from "./approvals";
import type { PrincipalId } from "./types";
import { OWNER_NAME } from "./owner";

export interface VendorRecord {
  id: string;
  name: string;
  category: string;         // "cleaning" | "hvac" | "handyman" | "catering" | ...
  email?: string;
  phone?: string;
  notes?: string;
  rating?: 1 | 2 | 3 | 4 | 5;
  lastUsedAt?: string;
  lastCostUsd?: number;
}

async function vendorsFile(): Promise<string> {
  const cfg = await loadConfig();
  const dir = path.join(cfg.vaultRoot, "vendors");
  await fs.mkdir(dir, { recursive: true });
  return path.join(dir, "_index.json");
}

export async function listVendors(category?: string): Promise<VendorRecord[]> {
  try {
    const rows = JSON.parse(await fs.readFile(await vendorsFile(), "utf8")) as VendorRecord[];
    return category ? rows.filter((r) => r.category === category) : rows;
  } catch { return []; }
}
export async function saveVendor(v: Omit<VendorRecord, "id"> & { id?: string }): Promise<VendorRecord> {
  const rows = await listVendors();
  const row: VendorRecord = { ...v, id: v.id ?? crypto.randomUUID() };
  const i = rows.findIndex((r) => r.id === row.id);
  if (i >= 0) rows[i] = row; else rows.push(row);
  await fs.writeFile(await vendorsFile(), JSON.stringify(rows, null, 2), "utf8");
  return row;
}

// Draft a "reach out to N vendors" approval. On approve, sends the quote-request emails.
export async function shortlistForQuotes(input: {
  requestor: PrincipalId;
  category: string;
  scope: string;               // "monthly cleaning, 3-bed house"
  budgetUsd?: number;
  deadline?: string;           // "need someone by end of month"
  candidateIds?: string[];     // if omitted, we auto-pick top 3 by rating
}): Promise<{ approvalId: string; candidates: VendorRecord[] }> {
  const all = await listVendors(input.category);
  const candidates = (input.candidateIds ? all.filter((v) => input.candidateIds!.includes(v.id)) : all.sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0))).slice(0, 3);

  const a = await approvalDraft({
    kind: "vendor.quote-req",
    title: `Get quotes: ${input.scope}`,
    summary: [
      `**Category**: ${input.category}`,
      `**Scope**: ${input.scope}`,
      input.budgetUsd ? `**Budget**: ~$${input.budgetUsd}` : "",
      input.deadline ? `**Needed by**: ${input.deadline}` : "",
      ``,
      candidates.length ? `**Reaching out to:**\n${candidates.map((c) => `- ${c.name}${c.email ? ` (${c.email})` : ""}${c.rating ? ` — ⭐${c.rating}` : ""}`).join("\n")}` : `_No vendors in the shortlist for "${input.category}" yet — add some at /contacts once that page is wired._`,
    ].filter(Boolean).join("\n"),
    requestor: input.requestor,
    intent: { input, candidateIds: candidates.map((c) => c.id) },
  });
  return { approvalId: a.id, candidates };
}

export async function sendQuoteRequests(row: Approval): Promise<{ ok: boolean; error?: string; ref?: string }> {
  const { input, candidateIds } = row.intent as { input: Parameters<typeof shortlistForQuotes>[0]; candidateIds: string[] };
  const all = await listVendors();
  const targets = all.filter((v) => candidateIds.includes(v.id) && v.email);
  if (!targets.length) return { ok: false, error: "no vendors with email addresses to contact" };

  const body = [
    `Hi —`,
    ``,
    `I'm reaching out on behalf of ${OWNER_NAME} about ${input.scope}.`,
    input.budgetUsd ? `Budget is around $${input.budgetUsd}.` : "",
    input.deadline ? `Ideal timing: ${input.deadline}.` : "",
    ``,
    `Would you have availability for this? If so, could you send over a quote and next steps?`,
    ``,
    `Thanks,`,
    `Clara (${OWNER_NAME}'s assistant)`,
  ].filter(Boolean).join("\n");

  let ok = 0, failed = 0, queued = 0;
  const subject = `Quote request — ${input.scope}`;
  for (const v of targets) {
    const meta = { channel: "email" as const, to: v.email!, kind: "vendor.quote-req" };
    const gate = await gateOutbound(meta, { deferrable: true });
    if (gate.action === "block") { failed++; continue; }
    if (gate.action === "queue") { await enqueue(meta, gate.sendAfterMs, body, subject); queued++; continue; }
    const r = await sendMail({ to: v.email!, subject, body });
    if (r.ok) { await recordSent(meta); ok++; } else failed++;
  }
  return { ok: failed === 0, ref: `${ok}/${targets.length} sent${queued ? `, ${queued} queued (quiet hours)` : ""}`, error: failed ? `${failed} failed` : undefined };
}

// "Hiring" a vendor no longer has a Clara-executed step — Clara has no purchase power. Once
// the owner pick a vendor from the quote responses, they either confirm directly themselves, or
// ask Clara to place an approved business call to confirm scope/timing (see business-calls.ts).
