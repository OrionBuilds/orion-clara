// Clara ↔ SharePoint document library: search, read, create, and the approval-gated destructive
// operations. Graph replacement for google-drive.ts (Google Drive).
//
// Posture unchanged from the Google version: searching and reading are autonomous, creating a NEW
// file is autonomous (can't damage existing work), editing or trashing something that already
// exists always goes through the approvals queue and the owner's SMS confirmation.
//
// Reading: Excel maps cleanly onto Graph's Workbook API (see ms-editors.ts) the same way Sheets
// did. Word has no Graph export-to-text endpoint the way Docs' files.export did — this uses
// `mammoth` to extract plain text from the .docx's own OOXML, same library ms-editors.ts uses for
// its pre-replace text check. PowerPoint (.pptx) text extraction has no equivalently simple path
// and is left unimplemented (readAsText returns a clear error for it) rather than faked.
//
// Anything read out of SharePoint is untrusted input, same as Drive was — readAsText still runs
// the injection detector.

import mammoth from "mammoth";
import { Document, Packer, Paragraph } from "docx";
import ExcelJS from "exceljs";
import { mfetch, type MAccount } from "./ms-auth";
import { detectPromptInjection, type InjectionVerdict } from "./injection";
import { draft as approvalDraft, type Approval } from "./approvals";
import { can } from "./tiers";
import { append as ledgerAppend } from "./ledger";
import type { PrincipalId } from "./types";

const GRAPH = "https://graph.microsoft.com/v1.0";

const MIME = {
  // Graph DriveItems don't carry a mimeType for folders the way Drive did, and native Office
  // files use their real OOXML content-types rather than Google's "vnd.google-apps.*" sentinels.
  doc: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  sheet: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  slides: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  /** Internal-only sentinel — Graph gives folders no mimeType, so we assign one ourselves. */
  folder: "application/vnd.ms-folder",
} as const;

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime?: string;
  createdTime?: string;
  owners?: string[];
  webViewLink?: string;
  parents?: string[];
  size?: number;
  trashed?: boolean;
  /** Graph's change-detection token — the headRevisionId equivalent used for staleness checks. */
  eTag?: string;
}

interface DriveItem {
  id: string; name: string; webUrl?: string;
  createdDateTime?: string; lastModifiedDateTime?: string; size?: number;
  eTag?: string; cTag?: string;
  file?: { mimeType?: string };
  folder?: Record<string, unknown>;
  parentReference?: { id?: string };
  createdBy?: { user?: { email?: string; displayName?: string } };
}

function toFile(r: DriveItem): DriveFile {
  return {
    id: r.id,
    name: r.name,
    mimeType: r.folder ? MIME.folder : (r.file?.mimeType ?? "application/octet-stream"),
    modifiedTime: r.lastModifiedDateTime,
    createdTime: r.createdDateTime,
    owners: r.createdBy?.user ? [r.createdBy.user.email ?? r.createdBy.user.displayName ?? ""].filter(Boolean) : [],
    webViewLink: r.webUrl,
    parents: r.parentReference?.id ? [r.parentReference.id] : undefined,
    size: r.size,
    // SharePoint/OneDrive items you can still fetch are, by definition, not in the recycle bin —
    // there's no "soft-trashed but still listed" state the way Drive's `trashed:true` flag is.
    trashed: false,
    eTag: r.eTag ?? r.cTag,
  };
}

// ── Drive (site) resolution ─────────────────────────────────────────────────────────────────────
// Which SharePoint document library Clara treats as her "file manager" is one shared drive, set
// once via env — either the drive id directly, or a site id to resolve the site's default drive
// from. Mirrors the single-choke-point style of google-auth.ts's client()/redirectUri().

let cachedDriveId: string | null = null;

export async function driveId(account: MAccount = "work"): Promise<string> {
  if (cachedDriveId) return cachedDriveId;
  const explicit = process.env.MS_SHAREPOINT_DRIVE_ID?.trim();
  if (explicit) { cachedDriveId = explicit; return explicit; }
  const siteId = process.env.MS_SHAREPOINT_SITE_ID?.trim();
  if (!siteId) throw new Error("SharePoint not configured — set MS_SHAREPOINT_DRIVE_ID (or MS_SHAREPOINT_SITE_ID) in .env.local");
  const r = await mfetch(`${GRAPH}/sites/${encodeURIComponent(siteId)}/drive`, {}, account);
  if (!r.ok) throw new Error(`SharePoint site drive lookup failed: ${r.status} ${(await r.text().catch(() => "")).slice(0, 160)}`);
  const j = await r.json() as { id: string };
  cachedDriveId = j.id;
  return j.id;
}

/** Exported so ms-editors.ts (and any other Graph file module) shares the exact same drive resolution. */
export async function driveBase(account: MAccount = "work"): Promise<string> {
  return `${GRAPH}/drives/${await driveId(account)}`;
}

export function filesConfigured(): boolean {
  return Boolean(process.env.MS_SHAREPOINT_DRIVE_ID?.trim() || process.env.MS_SHAREPOINT_SITE_ID?.trim());
}

async function gjson<T>(url: string, init?: RequestInit, account: MAccount = "work"): Promise<T> {
  const r = await mfetch(url, init ?? {}, account);
  if (!r.ok) throw new Error(`SharePoint ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}`);
  return await r.json() as T;
}

// OData string literals escape a single quote by doubling it — Drive's query language used
// backslash-escaping, so this is NOT the same helper, just the same purpose.
function escapeOData(s: string): string {
  return s.replace(/'/g, "''");
}

// ── Upload + folder ensure ──────────────────────────────────────────────────────────────────────

export async function uploadBytes(
  name: string,
  data: Buffer | Uint8Array,
  mime: string,
  parentId?: string,
): Promise<DriveFile | null> {
  // Graph's simple PUT-content upload tops out at 4MB; anything larger needs a resumable upload
  // session (createUploadSession), not implemented here since Clara's deliverables haven't needed
  // it yet. Fail loudly rather than silently truncating a large file.
  if (data.byteLength > 4 * 1024 * 1024) {
    console.error(`ms-files.uploadBytes: ${name} is ${data.byteLength} bytes — over Graph's 4MB simple-upload limit; needs a resumable upload session (not implemented)`);
    return null;
  }
  const base = await driveBase().catch(() => null);
  if (!base) return null;
  const path = parentId
    ? `${base}/items/${encodeURIComponent(parentId)}:/${encodeURIComponent(name)}:/content`
    : `${base}/root:/${encodeURIComponent(name)}:/content`;
  const r = await mfetch(path, {
    method: "PUT",
    headers: { "Content-Type": mime },
    body: new Uint8Array(data),
  }, "work").catch(() => null);
  if (!r || !r.ok) return null;
  return toFile(await r.json() as DriveItem);
}

/** Find-or-create a folder by name (optionally under a parent) in the configured SharePoint drive. */
export async function ensureFolder(name: string, parentId?: string): Promise<DriveFile | null> {
  try {
    const base = await driveBase();
    const listUrl = parentId
      ? `${base}/items/${encodeURIComponent(parentId)}/children?$filter=${encodeURIComponent(`name eq '${escapeOData(name)}'`)}`
      : `${base}/root/children?$filter=${encodeURIComponent(`name eq '${escapeOData(name)}'`)}`;
    const found = await gjson<{ value: DriveItem[] }>(listUrl);
    const hit = found.value?.find((f) => f.folder);
    if (hit) return toFile(hit);
    const createUrl = parentId ? `${base}/items/${encodeURIComponent(parentId)}/children` : `${base}/root/children`;
    const created = await gjson<DriveItem>(createUrl, {
      method: "POST",
      body: JSON.stringify({ name, folder: {}, "@microsoft.graph.conflictBehavior": "fail" }),
    });
    return toFile(created);
  } catch {
    return null;
  }
}

export async function searchDrive(
  query: string,
  opts: { max?: number; mimeType?: string; modifiedAfterISO?: string; account?: MAccount } = {},
): Promise<DriveFile[]> {
  const account = opts.account ?? "work";
  const base = await driveBase(account);
  // Graph's search() has no server-side mimeType/modifiedAfter filter params the way Drive's `q`
  // query language did — fetch and filter client-side.
  const j = await gjson<{ value?: DriveItem[] }>(
    `${base}/root/search(q='${encodeURIComponent(escapeOData(query))}')?$top=${Math.min(opts.max ?? 20, 100) * 2}`,
    {}, account,
  );
  let files = (j.value ?? []).map(toFile);
  if (opts.mimeType) files = files.filter((f) => f.mimeType === opts.mimeType);
  if (opts.modifiedAfterISO) files = files.filter((f) => (f.modifiedTime ?? "") > opts.modifiedAfterISO!);
  return files.slice(0, opts.max ?? 20);
}

/**
 * Raw search passthrough for name-based lookups (meeting transcripts etc.) — Drive's full `q`
 * query language (arbitrary boolean clauses) has no Graph equivalent; this just forwards the
 * string into Graph's search(), which is name+content full-text, not a query language. Callers
 * that built complex Drive query strings need their own review (same caveat as ms-mail.ts's
 * searchMessages for Gmail query syntax).
 */
export async function listDriveByQuery(
  q: string,
  opts: { max?: number; account?: MAccount; orderBy?: string } = {},
): Promise<DriveFile[]> {
  const account = opts.account ?? "work";
  const base = await driveBase(account);
  const j = await gjson<{ value?: DriveItem[] }>(
    `${base}/root/search(q='${encodeURIComponent(escapeOData(q))}')?$top=${Math.min(opts.max ?? 20, 100)}`,
    {}, account,
  );
  return (j.value ?? []).map(toFile);
}

export async function getFile(fileId: string, account: MAccount = "work"): Promise<DriveFile | null> {
  try {
    const base = await driveBase(account);
    const r = await gjson<DriveItem>(`${base}/items/${encodeURIComponent(fileId)}`, {}, account);
    return toFile(r);
  } catch { return null; }
}

async function headRevision(fileId: string, account: MAccount): Promise<string | undefined> {
  const f = await getFile(fileId, account);
  return f?.eTag;
}

// Reads an Excel workbook through the Workbook API's usedRange rather than any export — Graph has
// no CSV-export-first-tab-only trap the way Drive did, but it also has no single "whole workbook"
// call, so this walks each sheet.
async function readWorkbookAsText(fileId: string, account: MAccount): Promise<string> {
  const base = await driveBase(account);
  const sheets = await gjson<{ value?: { id: string; name: string }[] }>(
    `${base}/items/${encodeURIComponent(fileId)}/workbook/worksheets?$select=id,name`, {}, account,
  );
  const names = (sheets.value ?? []).map((s) => s.name);
  const parts: string[] = [];
  for (const name of names) {
    const used = await gjson<{ text?: unknown[][] }>(
      `${base}/items/${encodeURIComponent(fileId)}/workbook/worksheets('${encodeURIComponent(name)}')/usedRange?$select=text`,
      {}, account,
    ).catch(() => ({ text: [] }));
    const rows = (used.text ?? []).map((row) => row.map((c) => String(c ?? "")).join("\t")).join("\n");
    parts.push(`## ${name}\n${rows}`);
  }
  return parts.join("\n\n");
}

export async function readAsText(
  fileId: string,
  opts: { maxChars?: number; account?: MAccount } = {},
): Promise<{ ok: boolean; text: string; mimeType: string; truncated: boolean; injection?: InjectionVerdict; error?: string }> {
  const account = opts.account ?? "work";
  const maxChars = opts.maxChars ?? 100_000;

  const meta = await getFile(fileId, account);
  if (!meta) return { ok: false, text: "", mimeType: "", truncated: false, error: "file not found or not accessible" };

  let text = "";
  try {
    if (meta.mimeType === MIME.sheet) {
      text = await readWorkbookAsText(fileId, account);
    } else if (meta.mimeType === MIME.doc) {
      const base = await driveBase(account);
      const r = await mfetch(`${base}/items/${encodeURIComponent(fileId)}/content`, {}, account);
      if (!r.ok) return { ok: false, text: "", mimeType: meta.mimeType, truncated: false, error: `download ${r.status}` };
      const buf = Buffer.from(await r.arrayBuffer());
      text = (await mammoth.extractRawText({ buffer: buf })).value;
    } else if (meta.mimeType === MIME.slides) {
      // No simple Graph or library path for pptx text extraction — honest refusal rather than a
      // fake result. Slides were already "deliberately unimplemented" under the Google version.
      return { ok: false, text: "", mimeType: meta.mimeType, truncated: false, error: "PowerPoint text extraction is not supported" };
    } else {
      const base = await driveBase(account);
      const r = await mfetch(`${base}/items/${encodeURIComponent(fileId)}/content`, {}, account);
      if (!r.ok) return { ok: false, text: "", mimeType: meta.mimeType, truncated: false, error: `download ${r.status}` };
      text = await r.text();
    }
  } catch (e) {
    return { ok: false, text: "", mimeType: meta.mimeType, truncated: false, error: String((e as Error).message ?? e) };
  }

  const truncated = text.length > maxChars;
  if (truncated) text = text.slice(0, maxChars);

  // SharePoint content is authored by other people — treat it as untrusted, always.
  const injection = detectPromptInjection(text);

  return { ok: true, text, mimeType: meta.mimeType, truncated, injection };
}

// Creating a NEW file is autonomous — it cannot damage anything that already exists. Unlike
// Google, Microsoft Graph does NOT auto-convert an uploaded text/csv payload into a native
// Word/Excel file — a plain-text blob saved as "foo.docx" is just a corrupt docx. "doc"/"sheet"
// are therefore built as real OOXML packages with small, well-known libraries (docx/exceljs)
// rather than relying on server-side conversion that doesn't exist on this platform.
export async function createFile(input: {
  name: string;
  content: string;
  as: "doc" | "sheet" | "slides" | "text" | "csv";
  folderId?: string;
  requestor?: PrincipalId;
  account?: MAccount;
}): Promise<{ ok: boolean; file?: DriveFile; error?: string }> {
  const account = input.account ?? "work";
  const decision = await can(input.requestor ?? "owner", "drive.create");
  if (!decision.allow) return { ok: false, error: `blocked by tier: ${decision.reason}` };

  if (input.as === "slides") {
    // PowerPoint has no comparably simple text-to-pptx path in the Node ecosystem — honest
    // refusal rather than shipping a broken file. Build this properly if it's ever actually needed.
    return { ok: false, error: "PowerPoint creation is not supported yet — Microsoft Graph has no text-to-pptx conversion; ask for this to be built if it's actually needed" };
  }

  let buf: Buffer;
  let mime: string;
  let name = input.name;
  try {
    if (input.as === "doc") {
      const doc = new Document({
        sections: [{ children: input.content.split("\n").map((line) => new Paragraph(line)) }],
      });
      buf = await Packer.toBuffer(doc);
      mime = MIME.doc;
      if (!/\.docx$/i.test(name)) name += ".docx";
    } else if (input.as === "sheet") {
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet("Sheet1");
      for (const line of input.content.split("\n")) {
        if (line.length) ws.addRow(line.split(","));
      }
      buf = Buffer.from(await wb.xlsx.writeBuffer());
      mime = MIME.sheet;
      if (!/\.xlsx$/i.test(name)) name += ".xlsx";
    } else {
      // "text" / "csv" — no conversion needed, upload the raw content as-is.
      buf = Buffer.from(input.content, "utf8");
      mime = input.as === "csv" ? "text/csv" : "text/plain";
      if (input.as === "csv" && !/\.csv$/i.test(name)) name += ".csv";
      if (input.as === "text" && !/\.txt$/i.test(name)) name += ".txt";
    }
  } catch (e) {
    return { ok: false, error: `building ${input.as} failed: ${String((e as Error).message ?? e)}` };
  }

  const file = await uploadBytes(name, buf, mime, input.folderId);
  if (!file) return { ok: false, error: "SharePoint create failed (see server logs)" };
  await ledgerAppend({
    kind: "document", actor: "clara",
    what: `created SharePoint file "${file.name}"`, ref: file.id,
    meta: { mimeType: file.mimeType, webViewLink: file.webViewLink },
  }).catch(() => {});
  return { ok: true, file };
}

// ── destructive: proposal + approved execution ───────────────────────────
export type DriveEditOp = "docs-insert" | "docs-replace" | "sheets-write" | "drive-replace-content";

export interface DriveEditIntent {
  account: MAccount;
  fileId: string;
  fileName: string;
  mimeType: string;
  webViewLink?: string;
  changeSummary: string;
  op: DriveEditOp;
  payload: unknown;
  /** Graph's eTag — the headRevisionId-equivalent staleness token. */
  headRevisionBefore?: string;
}

export interface DriveTrashIntent {
  account: MAccount;
  fileId: string;
  fileName: string;
  mimeType: string;
  webViewLink?: string;
  reason: string;
}

export async function proposeEdit(input: {
  fileId: string;
  changeSummary: string;
  op: DriveEditOp;
  payload: unknown;
  requestor?: PrincipalId;
  origin?: "owner" | "external";
  account?: MAccount;
}): Promise<Approval> {
  const account = input.account ?? "work";
  const file = await getFile(input.fileId, account);
  if (!file) throw new Error(`SharePoint file ${input.fileId} not found`);

  const intent: DriveEditIntent = {
    account, fileId: file.id, fileName: file.name, mimeType: file.mimeType,
    webViewLink: file.webViewLink, changeSummary: input.changeSummary,
    op: input.op, payload: input.payload,
    headRevisionBefore: await headRevision(file.id, account),
  };

  return approvalDraft({
    kind: "drive.modify",
    title: `Edit "${file.name}"`,
    summary: [
      `**File**: ${file.name}`,
      `**Change**: ${input.changeSummary}`,
      file.webViewLink ? `**Link**: ${file.webViewLink}` : "",
      ``,
      `_Clara will not touch anything else in this file._`,
    ].filter(Boolean).join("\n"),
    requestor: input.requestor ?? "owner",
    origin: input.origin,
    intent,
  });
}

export async function proposeTrash(input: {
  fileId: string;
  reason: string;
  requestor?: PrincipalId;
  origin?: "owner" | "external";
  account?: MAccount;
}): Promise<Approval> {
  const account = input.account ?? "work";
  const file = await getFile(input.fileId, account);
  if (!file) throw new Error(`SharePoint file ${input.fileId} not found`);

  const intent: DriveTrashIntent = {
    account, fileId: file.id, fileName: file.name, mimeType: file.mimeType,
    webViewLink: file.webViewLink, reason: input.reason,
  };

  return approvalDraft({
    kind: "drive.trash",
    title: `Move "${file.name}" to trash`,
    summary: [
      `**File**: ${file.name}`,
      `**Why**: ${input.reason}`,
      file.webViewLink ? `**Link**: ${file.webViewLink}` : "",
      ``,
      // SharePoint/OneDrive DELETE lands in the site's recycle bin, recoverable for a retention
      // period (default 93 days) — the same "soft trash" guarantee Drive's trashed:true gave,
      // just reached through the normal delete call instead of a flag.
      `_Goes to the site's recycle bin — recoverable. Clara never permanently deletes._`,
    ].filter(Boolean).join("\n"),
    requestor: input.requestor ?? "owner",
    origin: input.origin,
    intent,
  });
}

export type DriveEditPayload =
  | { op: "docs-insert"; text: string; atIndex?: number }
  | { op: "docs-replace"; replacements: { find: string; replace: string }[] }
  | { op: "sheets-write"; range: string; values: (string | number)[][]; mode?: "overwrite" | "append" }
  | { op: "drive-replace-content"; content: string; mimeType?: string };

export function normalizeDriveEditPayload(op: DriveEditOp, payload: unknown): { ok: true; value: DriveEditPayload } | { ok: false; error: string } {
  const obj = payload && typeof payload === "object" ? payload as Record<string, unknown> : null;
  const str = typeof payload === "string" ? payload : null;
  switch (op) {
    case "docs-insert": {
      const text = obj && typeof obj.text === "string" ? obj.text : str;
      if (!text || !text.trim()) return { ok: false, error: "docs-insert needs the text to append" };
      const atIndex = obj && typeof obj.atIndex === "number" && Number.isFinite(obj.atIndex) ? obj.atIndex : undefined;
      return { ok: true, value: { op, text, atIndex } };
    }
    case "docs-replace": {
      const raw = obj && Array.isArray(obj.replacements) ? obj.replacements as unknown[] : null;
      if (!raw || !raw.length) return { ok: false, error: "docs-replace needs a non-empty list of {find, replace} pairs" };
      const replacements: { find: string; replace: string }[] = [];
      for (const r of raw) {
        const rr = r && typeof r === "object" ? r as Record<string, unknown> : null;
        if (!rr || typeof rr.find !== "string" || !rr.find || typeof rr.replace !== "string") {
          return { ok: false, error: "each docs-replace entry needs a non-empty `find` and a `replace` string" };
        }
        replacements.push({ find: rr.find, replace: rr.replace });
      }
      return { ok: true, value: { op, replacements } };
    }
    case "sheets-write": {
      const range = obj && typeof obj.range === "string" ? obj.range : "";
      const values = obj && Array.isArray(obj.values) ? obj.values as unknown[] : null;
      if (!range || !values || !values.length || !values.every((row) => Array.isArray(row))) {
        return { ok: false, error: "sheets-write needs a `range` (e.g. Sheet1!A1) and `values` as an array of rows" };
      }
      const mode = obj && (obj.mode === "append" || obj.mode === "overwrite") ? obj.mode : undefined;
      return { ok: true, value: { op, range, values: values as (string | number)[][], mode } };
    }
    case "drive-replace-content": {
      const content = obj && typeof obj.content === "string" ? obj.content : str;
      if (content == null) return { ok: false, error: "drive-replace-content needs the new file content" };
      const mimeType = obj && typeof obj.mimeType === "string" ? obj.mimeType : undefined;
      return { ok: true, value: { op, content, mimeType } };
    }
  }
  return { ok: false, error: `unknown op "${String(op)}"` };
}

export async function applyApprovedDriveEdit(row: Approval): Promise<{ ok: boolean; error?: string; ref?: string; knowledgeRefreshed?: boolean }> {
  const intent = row.intent as DriveEditIntent;
  const account = intent.account ?? "work";

  if (intent.headRevisionBefore) {
    const now = await headRevision(intent.fileId, account);
    if (now && now !== intent.headRevisionBefore) {
      return { ok: false, error: `"${intent.fileName}" changed since this was drafted — re-draft the edit` };
    }
  }

  const parsed = normalizeDriveEditPayload(intent.op, intent.payload);
  if (!parsed.ok) return { ok: false, error: `${parsed.error} — nothing was changed` };
  const p = parsed.value;

  try {
    const { docsInsertText, docsReplaceText, sheetsWriteRange } = await import("./ms-editors");
    switch (p.op) {
      case "docs-insert": {
        const res = await docsInsertText(intent.fileId, p.text, { atIndex: p.atIndex, account });
        if (!res.ok) return { ok: false, error: res.error };
        break;
      }
      case "docs-replace": {
        const res = await docsReplaceText(intent.fileId, p.replacements, account);
        if (!res.ok) return { ok: false, error: res.error };
        break;
      }
      case "sheets-write": {
        const res = await sheetsWriteRange(intent.fileId, p.range, p.values, { mode: p.mode, account });
        if (!res.ok) return { ok: false, error: res.error };
        break;
      }
      case "drive-replace-content": {
        const base = await driveBase(account);
        const r = await mfetch(
          `${base}/items/${encodeURIComponent(intent.fileId)}/content`,
          { method: "PUT", headers: { "Content-Type": p.mimeType ?? "text/plain" }, body: p.content },
          account,
        );
        if (!r.ok) return { ok: false, error: `SharePoint update ${r.status}` };
        break;
      }
    }
    await ledgerAppend({
      kind: "document", actor: "owner",
      what: `edited SharePoint file "${intent.fileName}": ${intent.changeSummary}`,
      ref: intent.fileId, meta: { op: intent.op, webViewLink: intent.webViewLink },
    }).catch(() => {});
    {
      const { recordOutcome } = await import("./vaultMemory");
      await recordOutcome({ thread: `drive-${intent.fileId}`, kind: "drive-edit", status: "done",
        title: `Edited "${intent.fileName}"`, done: intent.changeSummary,
        links: intent.webViewLink ? [{ label: intent.fileName, url: intent.webViewLink }] : [] }).catch(() => {});
    }
    let knowledgeRefreshed = false;
    try {
      const { refreshKnowledgeSource } = await import("./knowledge");
      const r = await refreshKnowledgeSource(intent.fileId, { notify: false });
      knowledgeRefreshed = r.ok;
    } catch { /* knowledge refresh is best-effort */ }
    return { ok: true, ref: intent.fileId, knowledgeRefreshed };
  } catch (e) {
    return { ok: false, error: String((e as Error).message ?? e) };
  }
}

export async function applyApprovedDriveTrash(row: Approval): Promise<{ ok: boolean; error?: string; ref?: string }> {
  const intent = row.intent as DriveTrashIntent;
  const account = intent.account ?? "work";
  try {
    const base = await driveBase(account);
    // SharePoint/OneDrive DELETE is the recycle-bin soft-delete, not a permanent destroy — see the
    // comment on proposeTrash above.
    const r = await mfetch(
      `${base}/items/${encodeURIComponent(intent.fileId)}`,
      { method: "DELETE" },
      account,
    );
    if (!r.ok) return { ok: false, error: `SharePoint trash ${r.status}: ${(await r.text().catch(() => "")).slice(0, 160)}` };
    await ledgerAppend({
      kind: "document", actor: "owner",
      what: `moved SharePoint file "${intent.fileName}" to trash: ${intent.reason}`,
      ref: intent.fileId, meta: { webViewLink: intent.webViewLink },
    }).catch(() => {});
    return { ok: true, ref: intent.fileId };
  } catch (e) {
    return { ok: false, error: String((e as Error).message ?? e) };
  }
}

// Deliberately absent: any sharing/permissions wrapper, same posture as google-drive.ts.
