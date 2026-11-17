// Clara ↔ Google Drive: search, read, create, and the approval-gated destructive operations.
//
// Posture: searching and reading are autonomous, and so is creating a NEW file — none of those can
// damage existing work. Editing or trashing something that already exists always goes through the
// approvals queue and the owner's SMS confirmation.
//
// Reading deliberately avoids the Docs/Slides APIs: Drive's own `files.export` returns plain text
// for both, with no extra call and no extra failure mode. Sheets is the exception — Drive's CSV
// export silently returns ONLY THE FIRST TAB, so multi-tab spreadsheets go through the Sheets API
// instead. That asymmetry is the single easiest thing to get wrong here.
//
// Anything read out of Drive is untrusted input: a shared document is content someone else wrote.
// readAsText runs the injection detector and hands back the verdict so callers can mark any
// resulting approval origin:"external".

import { gfetch, type GAccount } from "./google-auth";
import { detectPromptInjection, type InjectionVerdict } from "./injection";
import { draft as approvalDraft, type Approval } from "./approvals";
import { can } from "./tiers";
import { append as ledgerAppend } from "./ledger";
import type { PrincipalId } from "./types";

const DRIVE = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3";
const SHEETS = "https://sheets.googleapis.com/v4/spreadsheets";

const MIME = {
  doc: "application/vnd.google-apps.document",
  sheet: "application/vnd.google-apps.spreadsheet",
  slides: "application/vnd.google-apps.presentation",
  folder: "application/vnd.google-apps.folder",
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
}

interface RawFile {
  id: string; name: string; mimeType: string; modifiedTime?: string; createdTime?: string;
  owners?: { displayName?: string; emailAddress?: string }[];
  webViewLink?: string; parents?: string[]; size?: string; trashed?: boolean;
  headRevisionId?: string;
}

const FILE_FIELDS = "id,name,mimeType,modifiedTime,createdTime,owners(displayName,emailAddress),webViewLink,parents,size,trashed";

function toFile(r: RawFile): DriveFile {
  return {
    id: r.id, name: r.name, mimeType: r.mimeType, modifiedTime: r.modifiedTime, createdTime: r.createdTime,
    owners: (r.owners ?? []).map((o) => o.emailAddress ?? o.displayName ?? "").filter(Boolean),
    webViewLink: r.webViewLink, parents: r.parents,
    size: r.size ? Number(r.size) : undefined, trashed: r.trashed,
  };
}

async function gjson<T>(url: string, init?: RequestInit, account: GAccount = "work"): Promise<T> {
  const r = await gfetch(url, init ?? {}, account);
  if (!r.ok) throw new Error(`Drive ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}`);
  return await r.json() as T;
}

// Drive's query language treats ' as the string delimiter, so an apostrophe in a search term
// ("the owner's budget") would otherwise break out of the quoted value.
function escapeQ(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

// ── Binary upload + folder ensure (deep-work deliverables) ──────────────────────────────────────
// createFile() below builds its multipart body by string-joining, which corrupts binary payloads —
// fine for the text/csv-to-Google-native conversions it was written for, unusable for the PDF/DOCX/
// XLSX deliverables deep work produces. This is the Blob-bodied variant (same shape as FRIDAY's
// uploadBytes, which documents the corruption trap): a Buffer passes through untouched. Creating a
// NEW file is autonomous under the same posture as createFile — it cannot damage existing work.

export async function uploadBytes(
  name: string,
  data: Buffer | Uint8Array,
  mime: string,
  parentId?: string,
): Promise<DriveFile | null> {
  const boundary = `clara${Date.now()}`;
  const meta = JSON.stringify({ name, ...(parentId ? { parents: [parentId] } : {}) });
  const pre =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n` +
    `--${boundary}\r\nContent-Type: ${mime}\r\n\r\n`;
  const post = `\r\n--${boundary}--`;
  const body = new Blob([pre, new Uint8Array(data), post]);
  const r = await gfetch(`${DRIVE_UPLOAD}/files?uploadType=multipart&fields=${encodeURIComponent(FILE_FIELDS)}`, {
    method: "POST",
    headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
    body,
  }, "work").catch(() => null);
  if (!r || !r.ok) return null;
  return toFile(await r.json() as RawFile);
}

/** Find-or-create a folder by name (optionally under a parent) in the work account's My Drive. */
export async function ensureFolder(name: string, parentId?: string): Promise<DriveFile | null> {
  const q = `name = '${escapeQ(name)}' and mimeType = '${MIME.folder}' and trashed = false` + (parentId ? ` and '${parentId}' in parents` : "");
  try {
    const found = await gjson<{ files: RawFile[] }>(`${DRIVE}/files?q=${encodeURIComponent(q)}&pageSize=1&fields=files(${encodeURIComponent(FILE_FIELDS)})`);
    if (found.files?.[0]) return toFile(found.files[0]);
    const created = await gjson<RawFile>(`${DRIVE}/files?fields=${encodeURIComponent(FILE_FIELDS)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, mimeType: MIME.folder, ...(parentId ? { parents: [parentId] } : {}) }),
    });
    return toFile(created);
  } catch {
    return null;
  }
}

export async function searchDrive(
  query: string,
  opts: { max?: number; mimeType?: string; modifiedAfterISO?: string; account?: GAccount } = {},
): Promise<DriveFile[]> {
  const account = opts.account ?? "work";
  const clauses = [`fullText contains '${escapeQ(query)}'`, "trashed = false"];
  if (opts.mimeType) clauses.push(`mimeType = '${escapeQ(opts.mimeType)}'`);
  if (opts.modifiedAfterISO) clauses.push(`modifiedTime > '${escapeQ(opts.modifiedAfterISO)}'`);

  const url = `${DRIVE}/files?q=${encodeURIComponent(clauses.join(" and "))}`
    + `&fields=${encodeURIComponent(`files(${FILE_FIELDS})`)}`
    + `&pageSize=${Math.min(opts.max ?? 20, 100)}`
    + `&corpora=allDrives&includeItemsFromAllDrives=true&supportsAllDrives=true&orderBy=modifiedTime desc`;

  const j = await gjson<{ files?: RawFile[] }>(url, {}, account);
  return (j.files ?? []).map(toFile);
}

// Raw Drive query (caller supplies the full `q`). searchDrive is fullText-only; the meeting
// ingester needs a NAME-based query (Meet/Gemini save "<title> - Transcript" / "Notes by Gemini"
// docs), and building that through fullText would match every doc that merely mentions a transcript.
// Same fields/normalisation as searchDrive so callers get identical DriveFile rows.
export async function listDriveByQuery(
  q: string,
  opts: { max?: number; account?: GAccount; orderBy?: string } = {},
): Promise<DriveFile[]> {
  const account = opts.account ?? "work";
  const url = `${DRIVE}/files?q=${encodeURIComponent(q)}`
    + `&fields=${encodeURIComponent(`files(${FILE_FIELDS})`)}`
    + `&pageSize=${Math.min(opts.max ?? 20, 100)}`
    + `&corpora=allDrives&includeItemsFromAllDrives=true&supportsAllDrives=true&orderBy=${encodeURIComponent(opts.orderBy ?? "modifiedTime desc")}`;
  const j = await gjson<{ files?: RawFile[] }>(url, {}, account);
  return (j.files ?? []).map(toFile);
}

export async function getFile(fileId: string, account: GAccount = "work"): Promise<DriveFile | null> {
  try {
    const r = await gjson<RawFile>(
      `${DRIVE}/files/${encodeURIComponent(fileId)}?fields=${encodeURIComponent(FILE_FIELDS)}&supportsAllDrives=true`,
      {}, account,
    );
    return toFile(r);
  } catch { return null; }
}

async function headRevision(fileId: string, account: GAccount): Promise<string | undefined> {
  try {
    const r = await gjson<RawFile>(`${DRIVE}/files/${encodeURIComponent(fileId)}?fields=headRevisionId&supportsAllDrives=true`, {}, account);
    return r.headRevisionId;
  } catch { return undefined; }
}

// Reads a Sheet through the Sheets API rather than Drive's CSV export, which returns only tab 1.
async function readSheetAsText(fileId: string, account: GAccount): Promise<string> {
  const meta = await gjson<{ sheets?: { properties?: { title?: string } }[] }>(
    `${SHEETS}/${encodeURIComponent(fileId)}?includeGridData=false`, {}, account,
  );
  const titles = (meta.sheets ?? []).map((s) => s.properties?.title).filter(Boolean) as string[];
  if (!titles.length) return "";
  const ranges = titles.map((t) => `ranges=${encodeURIComponent(`'${t.replace(/'/g, "''")}'`)}`).join("&");
  const vals = await gjson<{ valueRanges?: { range?: string; values?: unknown[][] }[] }>(
    `${SHEETS}/${encodeURIComponent(fileId)}/values:batchGet?${ranges}`, {}, account,
  );
  return (vals.valueRanges ?? []).map((vr, i) => {
    const rows = (vr.values ?? []).map((row) => row.map((c) => String(c ?? "")).join("\t")).join("\n");
    return `## ${titles[i] ?? vr.range ?? `Sheet ${i + 1}`}\n${rows}`;
  }).join("\n\n");
}

export async function readAsText(
  fileId: string,
  opts: { maxChars?: number; account?: GAccount } = {},
): Promise<{ ok: boolean; text: string; mimeType: string; truncated: boolean; injection?: InjectionVerdict; error?: string }> {
  const account = opts.account ?? "work";
  const maxChars = opts.maxChars ?? 100_000;

  const meta = await getFile(fileId, account);
  if (!meta) return { ok: false, text: "", mimeType: "", truncated: false, error: "file not found or not accessible" };

  let text = "";
  try {
    if (meta.mimeType === MIME.sheet) {
      text = await readSheetAsText(fileId, account);
    } else if (meta.mimeType.startsWith("application/vnd.google-apps.")) {
      // Docs, Slides, and other native types export straight to plain text.
      const r = await gfetch(
        `${DRIVE}/files/${encodeURIComponent(fileId)}/export?mimeType=text%2Fplain&supportsAllDrives=true`, {}, account,
      );
      if (!r.ok) return { ok: false, text: "", mimeType: meta.mimeType, truncated: false, error: `export ${r.status}` };
      text = await r.text();
    } else {
      const r = await gfetch(`${DRIVE}/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`, {}, account);
      if (!r.ok) return { ok: false, text: "", mimeType: meta.mimeType, truncated: false, error: `download ${r.status}` };
      text = await r.text();
    }
  } catch (e) {
    return { ok: false, text: "", mimeType: meta.mimeType, truncated: false, error: String((e as Error).message ?? e) };
  }

  const truncated = text.length > maxChars;
  if (truncated) text = text.slice(0, maxChars);

  // Drive content is authored by other people — treat it as untrusted, always.
  const injection = detectPromptInjection(text);

  return { ok: true, text, mimeType: meta.mimeType, truncated, injection };
}

// Creating a NEW file is autonomous — it cannot damage anything that already exists. Google
// converts the uploaded text into the native type, so no Docs/Sheets API is needed here.
export async function createFile(input: {
  name: string;
  content: string;
  as: "doc" | "sheet" | "slides" | "text" | "csv";
  folderId?: string;
  requestor?: PrincipalId;
  account?: GAccount;
}): Promise<{ ok: boolean; file?: DriveFile; error?: string }> {
  const account = input.account ?? "work";
  const decision = await can(input.requestor ?? "owner", "drive.create");
  if (!decision.allow) return { ok: false, error: `blocked by tier: ${decision.reason}` };

  const targetMime = input.as === "doc" ? MIME.doc
    : input.as === "sheet" ? MIME.sheet
    : input.as === "slides" ? MIME.slides
    : undefined;
  const sourceMime = input.as === "csv" || input.as === "sheet" ? "text/csv" : "text/plain";

  const metadata: Record<string, unknown> = { name: input.name };
  if (targetMime) metadata.mimeType = targetMime;
  if (input.folderId) metadata.parents = [input.folderId];

  const boundary = `clara-${Date.now()}`;
  const body = [
    `--${boundary}`,
    "Content-Type: application/json; charset=UTF-8",
    "",
    JSON.stringify(metadata),
    `--${boundary}`,
    `Content-Type: ${sourceMime}; charset=UTF-8`,
    "",
    input.content,
    `--${boundary}--`,
    "",
  ].join("\r\n");

  try {
    const r = await gfetch(
      `${DRIVE_UPLOAD}/files?uploadType=multipart&supportsAllDrives=true&fields=${encodeURIComponent(FILE_FIELDS)}`,
      { method: "POST", headers: { "Content-Type": `multipart/related; boundary=${boundary}` }, body },
      account,
    );
    if (!r.ok) return { ok: false, error: `Drive create ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}` };
    const file = toFile(await r.json() as RawFile);
    await ledgerAppend({
      kind: "document", actor: "clara",
      what: `created Drive file "${file.name}"`, ref: file.id,
      meta: { mimeType: file.mimeType, webViewLink: file.webViewLink },
    }).catch(() => {});
    return { ok: true, file };
  } catch (e) {
    return { ok: false, error: String((e as Error).message ?? e) };
  }
}

// ── destructive: proposal + approved execution ───────────────────────────
export type DriveEditOp = "docs-insert" | "docs-replace" | "sheets-write" | "drive-replace-content";

export interface DriveEditIntent {
  account: GAccount;
  fileId: string;
  fileName: string;
  mimeType: string;
  webViewLink?: string;
  changeSummary: string;
  op: DriveEditOp;
  payload: unknown;
  headRevisionBefore?: string;
}

export interface DriveTrashIntent {
  account: GAccount;
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
  account?: GAccount;
}): Promise<Approval> {
  const account = input.account ?? "work";
  const file = await getFile(input.fileId, account);
  if (!file) throw new Error(`Drive file ${input.fileId} not found`);

  const intent: DriveEditIntent = {
    account, fileId: file.id, fileName: file.name, mimeType: file.mimeType,
    webViewLink: file.webViewLink, changeSummary: input.changeSummary,
    op: input.op, payload: input.payload,
    headRevisionBefore: await headRevision(file.id, account),
  };

  // Title carries the file NAME, never the id — the approval SMS is built from it.
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
  account?: GAccount;
}): Promise<Approval> {
  const account = input.account ?? "work";
  const file = await getFile(input.fileId, account);
  if (!file) throw new Error(`Drive file ${input.fileId} not found`);

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
      `_Goes to Drive's trash — recoverable for 30 days. Clara never permanently deletes._`,
    ].filter(Boolean).join("\n"),
    requestor: input.requestor ?? "owner",
    origin: input.origin,
    intent,
  });
}

// Per-op payload validation. The router used to hand the executor a bare string for every op
// (2026-09-23 ICP incident): docs-insert then sent `insertText` with no text and docs-replace threw
// on `undefined.length`, so every Doc edit reported FAILED. Everything the executor touches now
// goes through here first; a legacy string is still honoured where its meaning is unambiguous.
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

  // Staleness guard: if the file moved on between drafting and approval, the change the owner agreed
  // to isn't the change that would land. Refuse rather than clobber someone else's edit.
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
    const { docsInsertText, docsReplaceText, sheetsWriteRange } = await import("./google-editors");
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
        const r = await gfetch(
          `${DRIVE_UPLOAD}/files/${encodeURIComponent(intent.fileId)}?uploadType=media&supportsAllDrives=true`,
          { method: "PATCH", headers: { "Content-Type": p.mimeType ?? "text/plain" }, body: p.content },
          account,
        );
        if (!r.ok) return { ok: false, error: `Drive update ${r.status}` };
        break;
      }
    }
    await ledgerAppend({
      kind: "document", actor: "owner",
      what: `edited Drive file "${intent.fileName}": ${intent.changeSummary}`,
      ref: intent.fileId, meta: { op: intent.op, webViewLink: intent.webViewLink },
    }).catch(() => {});
    {
      const { recordOutcome } = await import("./vaultMemory");
      await recordOutcome({ thread: `drive-${intent.fileId}`, kind: "drive-edit", status: "done",
        title: `Edited "${intent.fileName}"`, done: intent.changeSummary,
        links: intent.webViewLink ? [{ label: intent.fileName, url: intent.webViewLink }] : [] }).catch(() => {});
    }
    // If this file feeds Clara's company knowledge (knowledge/sources.json), re-snapshot it now so
    // her own edit is what she reads next, not last Sunday's copy. Quiet: no "sources changed" nag
    // for a change she just made herself. company.md stays hand-curated (see knowledge.ts).
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
    const r = await gfetch(
      `${DRIVE}/files/${encodeURIComponent(intent.fileId)}?supportsAllDrives=true`,
      { method: "PATCH", body: JSON.stringify({ trashed: true }) },
      account,
    );
    if (!r.ok) return { ok: false, error: `Drive trash ${r.status}: ${(await r.text().catch(() => "")).slice(0, 160)}` };
    await ledgerAppend({
      kind: "document", actor: "owner",
      what: `moved Drive file "${intent.fileName}" to trash: ${intent.reason}`,
      ref: intent.fileId, meta: { webViewLink: intent.webViewLink },
    }).catch(() => {});
    return { ok: true, ref: intent.fileId };
  } catch (e) {
    return { ok: false, error: String((e as Error).message ?? e) };
  }
}

// Deliberately absent: any permissions.create / sharing wrapper. The full Drive scope can grant
// public access, and drive.share is blocked in the tier table — not writing the code at all is the
// second half of that guarantee.
