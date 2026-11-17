// Clara — the writes SharePoint's plain file API can't express: in-place Word/Excel edits.
//
// Google's Docs/Sheets batchUpdate APIs let you edit a native document's CONTENT without
// touching its container format. Microsoft Graph has a clean equivalent for Excel (the Workbook
// API operates on live ranges, same spirit as Sheets). It has NO equivalent for Word: a .docx is
// a zip of OOXML parts, and Graph only exposes it as opaque file bytes. Editing an existing Word
// doc here means downloading the zip, locating the visible text, patching the raw XML, and
// re-uploading the whole file — which is genuinely lossier than Google Docs' character-indexed
// batchUpdate (formatting boundaries inside a replaced span can be flattened; see docsReplaceText
// below). This is the documented trade-off from the migration plan, not an oversight.
//
// Everything here is reached ONLY through an approved drive.modify approval — nothing in this
// file should ever be called directly from an autonomous path (same posture as google-editors.ts).

import JSZip from "jszip";
import mammoth from "mammoth";
import { mfetch, type MAccount } from "./ms-auth";
import { driveBase } from "./ms-files";

// ── Word (.docx) — raw OOXML patch, best-effort ────────────────────────────────────────────────

async function downloadBytes(itemId: string, account: MAccount): Promise<Buffer> {
  const r = await mfetch(`${await driveBase(account)}/items/${encodeURIComponent(itemId)}/content`, {}, account);
  if (!r.ok) throw new Error(`download ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}`);
  return Buffer.from(await r.arrayBuffer());
}

async function uploadBytesToItem(itemId: string, data: Buffer, account: MAccount): Promise<{ ok: boolean; error?: string }> {
  const r = await mfetch(`${await driveBase(account)}/items/${encodeURIComponent(itemId)}/content`, {
    method: "PUT",
    headers: { "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
    body: new Uint8Array(data),
  }, account);
  if (!r.ok) return { ok: false, error: `upload ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}` };
  return { ok: true };
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Append a new paragraph at the end of the document body.
 *
 * `atIndex` from the Google-era call sites (a character offset into Docs' content model) has no
 * OOXML equivalent cheap enough to implement here — Word has no single linear character index,
 * just a tree of paragraphs/runs. Every insert lands at the END of the body regardless of
 * `atIndex`; callers that relied on inserting mid-document need review (flagged in the plan).
 */
export async function docsInsertText(
  docId: string,
  text: string,
  opts: { atIndex?: number; account?: MAccount } = {},
): Promise<{ ok: boolean; error?: string }> {
  const account = opts.account ?? "work";
  try {
    const bytes = await downloadBytes(docId, account);
    const zip = await JSZip.loadAsync(bytes);
    const docXmlPath = "word/document.xml";
    const xml = await zip.file(docXmlPath)?.async("string");
    if (!xml) return { ok: false, error: "word/document.xml not found — is this a valid .docx?" };

    const paragraph = `<w:p><w:r><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`;
    const bodyClose = xml.lastIndexOf("</w:body>");
    if (bodyClose < 0) return { ok: false, error: "could not find </w:body> — unexpected document structure" };
    // Word requires any sectPr (page setup) to stay the LAST child of <w:body> — insert just
    // before it (or before </w:body> if there's none) rather than after, or Word will refuse to
    // open the file.
    const sectPrOpen = xml.lastIndexOf("<w:sectPr");
    const insertAt = sectPrOpen > -1 && sectPrOpen < bodyClose ? sectPrOpen : bodyClose;
    const patched = xml.slice(0, insertAt) + paragraph + xml.slice(insertAt);

    zip.file(docXmlPath, patched);
    const out = await zip.generateAsync({ type: "nodebuffer" });
    return await uploadBytesToItem(docId, out, account);
  } catch (e) {
    return { ok: false, error: String((e as Error).message ?? e) };
  }
}

/** Plain-text rendering of the whole document, for pre-checking replacements — mirrors Google's docBodyText/docsGetBodyText. */
export async function docsGetBodyText(docId: string, account: MAccount = "work"): Promise<{ ok: boolean; text: string; error?: string }> {
  try {
    const bytes = await downloadBytes(docId, account);
    const { value } = await mammoth.extractRawText({ buffer: bytes });
    return { ok: true, text: value };
  } catch (e) {
    return { ok: false, text: "", error: String((e as Error).message ?? e) };
  }
}

/** Pure: which `find` strings would match nothing in `bodyText`. Same contract as the Google version. */
export function missingFinds(bodyText: string, replacements: { find: string }[]): string[] {
  return replacements.filter((r) => !r.find || !bodyText.includes(r.find)).map((r) => r.find);
}

interface RunMatch { text: string; xmlStart: number; xmlEnd: number; }

/** Every `<w:t>` run's text content with its raw-XML byte range, in document order. */
function findRuns(xml: string): RunMatch[] {
  const out: RunMatch[] = [];
  const re = /<w:t[^>]*>([^<]*)<\/w:t>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    out.push({ text: m[1], xmlStart: m.index, xmlEnd: m.index + m[0].length });
  }
  return out;
}

/**
 * Replace every occurrence of each `find` with its `replace`, operating on the document's VISIBLE
 * text (mammoth's flattened rendering), then mapping each match back onto the `<w:t>` run(s) it
 * spans and rewriting just that span.
 *
 * KNOWN LIMITATION, stated plainly rather than hidden: when a match spans more than one run (Word
 * splits a single visible word across runs for spell-check squiggles, tracked-change boundaries,
 * or mixed formatting — common, not an edge case), this collapses the whole spanned range into
 * ONE run carrying the replacement text. The replacement lands correctly and the rest of the
 * document is untouched, but any formatting boundary that existed *inside* the replaced span is
 * flattened. Google's replaceAllText has no such caveat; Word's OOXML model gives us no cheaper
 * way to do this safely. If this bites in practice, the fix is a real Word-OOXML library, not a
 * bigger regex.
 */
export async function docsReplaceText(
  docId: string,
  replacements: { find: string; replace: string }[],
  account: MAccount = "work",
): Promise<{ ok: boolean; error?: string }> {
  if (!replacements.length) return { ok: true };
  const body = await docsGetBodyText(docId, account);
  if (!body.ok) return { ok: false, error: body.error };
  const missing = missingFinds(body.text, replacements);
  if (missing.length) {
    const shown = missing.map((m) => `"${m.slice(0, 60)}${m.length > 60 ? "…" : ""}"`).join(", ");
    return { ok: false, error: `No match for ${shown} — the doc's wording differs from what you searched for, or the text spans a formatting boundary raw-XML replace can't see; re-read it and try again. Nothing was changed.` };
  }

  try {
    const bytes = await downloadBytes(docId, account);
    const zip = await JSZip.loadAsync(bytes);
    const docXmlPath = "word/document.xml";
    let xml = await zip.file(docXmlPath)?.async("string");
    if (!xml) return { ok: false, error: "word/document.xml not found — is this a valid .docx?" };

    for (const { find, replace } of replacements) {
      // Recompute runs each pass — the XML shifts after every replacement.
      const runs = findRuns(xml);
      const concat = runs.map((r) => r.text).join("");
      const idx = concat.indexOf(find);
      if (idx < 0) continue; // already covered by the missingFinds check against mammoth's text; be lenient here
      const matchEnd = idx + find.length;

      // Walk runs to find which ones the [idx, matchEnd) span touches.
      let pos = 0, firstRun = -1, lastRun = -1;
      for (let i = 0; i < runs.length; i++) {
        const runStart = pos, runEnd = pos + runs[i].text.length;
        if (firstRun < 0 && idx < runEnd) firstRun = i;
        if (matchEnd <= runEnd) { lastRun = i; break; }
        pos = runEnd;
      }
      if (firstRun < 0 || lastRun < 0) continue;

      const xmlFrom = runs[firstRun].xmlStart;
      const xmlTo = runs[lastRun].xmlEnd;
      const replacementTag = `<w:t xml:space="preserve">${escapeXml(replace)}</w:t>`;
      xml = xml.slice(0, xmlFrom) + replacementTag + xml.slice(xmlTo);
    }

    zip.file(docXmlPath, xml);
    const out = await zip.generateAsync({ type: "nodebuffer" });
    return await uploadBytesToItem(docId, out, account);
  } catch (e) {
    return { ok: false, error: String((e as Error).message ?? e) };
  }
}

// ── Excel (.xlsx) — Graph Workbook API (clean 1:1 with Sheets ranges) ──────────────────────────

function colToLetters(col: number): string {
  let s = "";
  let n = col;
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}
function lettersToCol(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}
function parseCell(cell: string): { col: number; row: number } {
  const m = cell.match(/^([A-Za-z]+)(\d+)$/);
  if (!m) throw new Error(`not a cell reference: ${cell}`);
  return { col: lettersToCol(m[1]), row: Number(m[2]) };
}
/** "A1" + 3 rows + 2 cols → "A1:B3". Graph's range(address=) needs the full bounding range, unlike Sheets' auto-expanding single-cell address. */
function expandRange(startCell: string, rows: number, cols: number): string {
  const { col, row } = parseCell(startCell);
  const endCell = `${colToLetters(col + cols - 1)}${row + rows - 1}`;
  return `${startCell}:${endCell}`;
}

/** "Sheet1!A1:B2" → { sheet: "Sheet1", address: "A1:B2" }. A bare "Sheet1" (no `!`) means "whole sheet" (caller should use usedRange). */
function splitSheetRange(range: string): { sheet: string; address?: string } {
  const bang = range.indexOf("!");
  if (bang < 0) return { sheet: range };
  return { sheet: range.slice(0, bang), address: range.slice(bang + 1) };
}

export async function sheetsWriteRange(
  sheetId: string,
  range: string,
  values: (string | number)[][],
  opts: { mode?: "overwrite" | "append"; account?: MAccount } = {},
): Promise<{ ok: boolean; updated?: number; error?: string }> {
  const account = opts.account ?? "work";
  const { sheet, address } = splitSheetRange(range);
  const base = `${await driveBase(account)}/items/${encodeURIComponent(sheetId)}/workbook/worksheets('${encodeURIComponent(sheet)}')`;

  let targetAddress = address;
  if (opts.mode === "append") {
    // Graph has no append-to-range primitive like Sheets' values:append — find the next empty
    // row via usedRange, then write starting there.
    const used = await mfetch(`${base}/usedRange(valuesOnly=true)?$select=address,rowCount`, {}, account);
    if (used.ok) {
      const j = await used.json() as { address?: string; rowCount?: number };
      const baseAddr = address ? parseCell(address.split(":")[0]).row : 1;
      const nextRow = baseAddr + (j.rowCount ?? 0);
      const startCol = address ? address.match(/^([A-Za-z]+)/)?.[1] ?? "A" : "A";
      targetAddress = expandRange(`${startCol}${nextRow}`, values.length, values[0]?.length ?? 1);
    }
  }
  if (!targetAddress) return { ok: false, error: "sheetsWriteRange needs either a full A1:B2-style range, or a start cell to append below" };
  if (!address) {
    // A bare "Sheet1!A1" start-cell form — expand to the full bounding range values needs.
    targetAddress = expandRange(targetAddress.split(":")[0], values.length, values[0]?.length ?? 1);
  }

  const r = await mfetch(`${base}/range(address='${encodeURIComponent(targetAddress)}')`, {
    method: "PATCH",
    body: JSON.stringify({ values }),
  }, account);
  if (!r.ok) return { ok: false, error: `Workbook ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}` };
  return { ok: true, updated: values.length * (values[0]?.length ?? 0) };
}

export async function sheetsRead(
  sheetId: string,
  ranges: string[],
  account: MAccount = "work",
): Promise<{ ok: boolean; ranges: { range: string; values: string[][] }[]; error?: string }> {
  const base = await driveBase(account);
  const out: { range: string; values: string[][] }[] = [];
  for (const range of ranges) {
    const { sheet, address } = splitSheetRange(range);
    const wsBase = `${base}/items/${encodeURIComponent(sheetId)}/workbook/worksheets('${encodeURIComponent(sheet)}')`;
    const url = address
      ? `${wsBase}/range(address='${encodeURIComponent(address)}')?$select=text`
      : `${wsBase}/usedRange?$select=text`;
    const r = await mfetch(url, {}, account);
    if (!r.ok) return { ok: false, ranges: out, error: `Workbook ${r.status}` };
    const j = await r.json().catch(() => ({})) as { text?: unknown[][] };
    out.push({ range, values: (j.text ?? []).map((row) => row.map((c) => String(c ?? ""))) });
  }
  return { ok: true, ranges: out };
}
