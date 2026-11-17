// Clara — the writes Drive's own API can't express.
//
// Reading Docs/Slides goes through Drive's `files.export` (see google-drive.ts) — no Docs API
// needed. But editing an existing Doc genuinely requires documents.batchUpdate: a Drive
// files.update on a native Doc replaces the whole file via conversion, destroying comments,
// suggestions, and formatting. Same reasoning for Sheets ranges.
//
// Slides editing is deliberately not implemented: read via export and create-new via Drive cover
// the useful cases, and the Slides batchUpdate model (element ids, placeholder mapping) is a large
// surface for very little assistant value.
//
// Everything here is reached ONLY through an approved drive.modify approval — nothing in this file
// should ever be called directly from an autonomous path.

import { gfetch, type GAccount } from "./google-auth";

const DOCS = "https://docs.googleapis.com/v1/documents";
const SHEETS = "https://sheets.googleapis.com/v4/spreadsheets";

async function batch(url: string, body: unknown, account: GAccount): Promise<{ ok: boolean; error?: string }> {
  const r = await gfetch(url, { method: "POST", body: JSON.stringify(body) }, account);
  if (!r.ok) return { ok: false, error: `${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}` };
  return { ok: true };
}

export async function docsInsertText(
  docId: string,
  text: string,
  opts: { atIndex?: number; account?: GAccount } = {},
): Promise<{ ok: boolean; error?: string }> {
  const account = opts.account ?? "work";
  // No index given → append. endOfSegmentLocation targets the end of the body without needing to
  // first read the document to discover its length.
  const insertText = opts.atIndex != null
    ? { text, location: { index: opts.atIndex } }
    : { text, endOfSegmentLocation: {} };
  return batch(`${DOCS}/${encodeURIComponent(docId)}:batchUpdate`, { requests: [{ insertText }] }, account);
}

// ── Docs body text (for pre-checking replacements) ─────────────────────────────────────────────
// The Drive plain-text export Clara reads from can differ from what the Docs API actually matches
// against (bullet glyphs, smart quotes, tab-separated table cells). replaceAllText with a find
// string that matches nothing silently succeeds — the request is valid, zero replacements happen —
// and Clara would then report DONE on a document that never changed. So before sending the batch
// we pull the real body text and refuse any find that isn't in it.

interface DocElement { textRun?: { content?: string } }
interface DocStructural {
  paragraph?: { elements?: DocElement[] };
  table?: { tableRows?: { tableCells?: { content?: DocStructural[] }[] }[] };
  tableOfContents?: { content?: DocStructural[] };
}
export interface DocLike { body?: { content?: DocStructural[] } }

/** Pure: flatten a documents.get response into the text replaceAllText would see. */
export function docBodyText(doc: DocLike): string {
  const out: string[] = [];
  const walk = (items: DocStructural[] | undefined) => {
    for (const el of items ?? []) {
      for (const e of el.paragraph?.elements ?? []) if (e.textRun?.content) out.push(e.textRun.content);
      for (const row of el.table?.tableRows ?? []) for (const cell of row.tableCells ?? []) walk(cell.content);
      if (el.tableOfContents?.content) walk(el.tableOfContents.content);
    }
  };
  walk(doc.body?.content);
  return out.join("");
}

/** Pure: which `find` strings would match nothing in `bodyText` (case-sensitive, like the API). */
export function missingFinds(bodyText: string, replacements: { find: string }[]): string[] {
  return replacements.filter((r) => !r.find || !bodyText.includes(r.find)).map((r) => r.find);
}

export async function docsGetBodyText(docId: string, account: GAccount = "work"): Promise<{ ok: boolean; text: string; error?: string }> {
  const r = await gfetch(`${DOCS}/${encodeURIComponent(docId)}?fields=body`, {}, account);
  if (!r.ok) return { ok: false, text: "", error: `Docs ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}` };
  const doc = await r.json().catch(() => ({})) as DocLike;
  return { ok: true, text: docBodyText(doc) };
}

export async function docsReplaceText(
  docId: string,
  replacements: { find: string; replace: string }[],
  account: GAccount = "work",
): Promise<{ ok: boolean; error?: string }> {
  if (!replacements.length) return { ok: true };
  const body = await docsGetBodyText(docId, account);
  if (!body.ok) return { ok: false, error: body.error };
  const missing = missingFinds(body.text, replacements);
  if (missing.length) {
    const shown = missing.map((m) => `"${m.slice(0, 60)}${m.length > 60 ? "…" : ""}"`).join(", ");
    return { ok: false, error: `No match for ${shown} — the doc's wording differs from what you searched for; re-read it and try again. Nothing was changed.` };
  }
  return batch(`${DOCS}/${encodeURIComponent(docId)}:batchUpdate`, {
    requests: replacements.map((r) => ({
      replaceAllText: { containsText: { text: r.find, matchCase: true }, replaceText: r.replace },
    })),
  }, account);
}

export async function sheetsWriteRange(
  sheetId: string,
  range: string,
  values: (string | number)[][],
  opts: { mode?: "overwrite" | "append"; account?: GAccount } = {},
): Promise<{ ok: boolean; updated?: number; error?: string }> {
  const account = opts.account ?? "work";
  const isAppend = opts.mode === "append";
  const url = isAppend
    ? `${SHEETS}/${encodeURIComponent(sheetId)}/values/${encodeURIComponent(range)}:append`
      + `?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`
    : `${SHEETS}/${encodeURIComponent(sheetId)}/values/${encodeURIComponent(range)}`
      + `?valueInputOption=USER_ENTERED`;

  const r = await gfetch(url, { method: isAppend ? "POST" : "PUT", body: JSON.stringify({ values }) }, account);
  if (!r.ok) return { ok: false, error: `Sheets ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}` };
  const j = await r.json().catch(() => ({})) as { updatedCells?: number; updates?: { updatedCells?: number } };
  return { ok: true, updated: j.updatedCells ?? j.updates?.updatedCells };
}

export async function sheetsRead(
  sheetId: string,
  ranges: string[],
  account: GAccount = "work",
): Promise<{ ok: boolean; ranges: { range: string; values: string[][] }[]; error?: string }> {
  const qs = ranges.map((x) => `ranges=${encodeURIComponent(x)}`).join("&");
  const r = await gfetch(`${SHEETS}/${encodeURIComponent(sheetId)}/values:batchGet?${qs}`, {}, account);
  if (!r.ok) return { ok: false, ranges: [], error: `Sheets ${r.status}` };
  const j = await r.json().catch(() => ({})) as { valueRanges?: { range?: string; values?: unknown[][] }[] };
  return {
    ok: true,
    ranges: (j.valueRanges ?? []).map((vr) => ({
      range: vr.range ?? "",
      values: (vr.values ?? []).map((row) => row.map((c) => String(c ?? ""))),
    })),
  };
}
