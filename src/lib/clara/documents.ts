// Clara — document generation.
//
// Honest implementation note: the plan called for pdf/docx/xlsx/pptx generation "via FRIDAY
// delegation, using the matching Claude Skill." In practice this doesn't hold up: Clara's
// Next.js runtime cannot invoke Claude Skills directly (only an actual Claude Code session
// can), and FRIDAY's delegation bridge (friday-bridge.ts) only returns text — it has no
// contract for handing back a generated file. Rather than pretend that works, this module:
//   1. Gets the document CONTENT via FRIDAY delegation (falls back to Clara's own LLM router
//      if FRIDAY is unreachable) — this part is real.
//   2. Renders that content into an actual PDF locally using pdf-lib (a real, small, pure-JS
//      library — no external skill dependency needed for simple text-layout documents).
// Every requested "kind" (pdf/docx/xlsx/pptx) currently produces a PDF; true native
// docx/xlsx/pptx would need either a heavy dependency (docx/exceljs/pptxgenjs) or a real
// file-returning delegation contract with FRIDAY, neither of which exists yet.

import { promises as fs } from "node:fs";
import path from "node:path";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { loadConfig } from "./config";
import { delegate } from "./friday-bridge";
import { classify, pickEngine } from "./sensitivity";
import { CLARA_IDENTITY } from "./persona";
import { append as ledgerAppend } from "./ledger";
import { mergePdfs, compressPdf } from "./stirling";
import { lmStudioBaseUrl, lmStudioChatModel } from "./lmstudio";
import { recordLMStudioCall } from "./usage";

export type DocumentKind = "pdf" | "docx" | "xlsx" | "pptx";

export interface DocumentRequest {
  kind: DocumentKind;
  purpose: string;         // "Travel itinerary — Austin trip"
  context: string;         // full content brief to turn into the document
  filename: string;        // without extension, e.g. "austin-itinerary"
}

export interface DocumentResult {
  ok: boolean;
  path?: string;
  relPath?: string;
  error?: string;
}

function slug(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "document";
}

async function draftContent(req: DocumentRequest): Promise<string> {
  const prompt = `Write the full text content for this document. Plain text, well-organized with clear headings and line breaks — this will be laid out on a PDF page as-is, no markdown syntax.\n\nPurpose: ${req.purpose}\n\nBrief:\n${req.context}`;

  // Sensitive content never leaves the machine — skip FRIDAY delegation (its engine may not be
  // local) and go straight to Clara's own local-only path.
  const hint = classify({ text: req.context });
  if (!hint.sensitive) {
    const delegated = await delegate(prompt, { kind: "draft" }).catch(() => null);
    if (delegated?.ok && delegated.reply) return delegated.reply;
  }

  const engine = pickEngine(hint, "lmstudio");
  try {
    const base = await lmStudioBaseUrl();
    const model = await lmStudioChatModel();
    const r = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [{ role: "system", content: CLARA_IDENTITY }, { role: "user", content: prompt }],
        temperature: 0.3,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (r.ok) {
      const j = await r.json() as { choices: { message: { content: string } }[] };
      void recordLMStudioCall(j, { purpose: "documents" });
      const text = j.choices?.[0]?.message?.content?.trim();
      if (text) return text;
    }
  } catch { /* fall through */ }

  if (hint.sensitive || engine === "lmstudio" || engine === "ollama") {
    throw new Error("document content requires local LM Studio and it's unreachable");
  }

  // OS model setting (agentSettings.ts) → its fallback → this site's built-in model.
  const { callModelText } = await import("./modelCall");
  const out = await callModelText({ site: "documents", purpose: "documents", defaultModel: "claude-opus-4-8", system: CLARA_IDENTITY, prompt, maxTokens: 2000 });
  if (out) return out.text;
  throw new Error("no LLM available to draft document content");
}

async function renderPdf(title: string, body: string): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const boldFont = await doc.embedFont(StandardFonts.HelveticaBold);
  const margin = 54;
  const pageSize: [number, number] = [612, 792]; // US Letter
  const fontSize = 11;
  const lineHeight = fontSize * 1.4;
  const maxWidth = pageSize[0] - margin * 2;

  function wrapLine(line: string): string[] {
    if (!line.trim()) return [""];
    const words = line.split(" ");
    const out: string[] = [];
    let cur = "";
    for (const w of words) {
      const test = cur ? `${cur} ${w}` : w;
      if (font.widthOfTextAtSize(test, fontSize) > maxWidth && cur) {
        out.push(cur);
        cur = w;
      } else {
        cur = test;
      }
    }
    if (cur) out.push(cur);
    return out;
  }

  const rawLines = body.split("\n").flatMap(wrapLine);

  let page = doc.addPage(pageSize);
  page.drawText(title, { x: margin, y: pageSize[1] - margin, size: 16, font: boldFont, color: rgb(0.1, 0.1, 0.1) });
  let y = pageSize[1] - margin - 30;

  for (const line of rawLines) {
    if (y < margin) {
      page = doc.addPage(pageSize);
      y = pageSize[1] - margin;
    }
    page.drawText(line, { x: margin, y, size: fontSize, font, color: rgb(0.15, 0.15, 0.15) });
    y -= lineHeight;
  }

  const bytes = await doc.save();
  return Buffer.from(bytes);
}

export async function requestDocument(req: DocumentRequest): Promise<DocumentResult> {
  let content: string;
  try {
    content = await draftContent(req);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }

  const cfg = await loadConfig();
  const dir = path.join(cfg.vaultRoot, "documents");
  await fs.mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);
  const filename = `${stamp}-${slug(req.filename)}.pdf`;
  const absPath = path.join(dir, filename);

  let pdfBytes: Buffer;
  try {
    pdfBytes = await renderPdf(req.purpose, content);
  } catch (e) {
    return { ok: false, error: `PDF render failed: ${(e as Error).message}` };
  }
  await fs.writeFile(absPath, pdfBytes);

  const relPath = `documents/${filename}`;
  await ledgerAppend({
    kind: "document",
    actor: "clara",
    what: `generated document: ${req.purpose}`,
    ref: relPath,
  });

  return { ok: true, path: absPath, relPath };
}

// Bundle several already-generated PDFs (vendor quotes, an itinerary, a confirmation) into one
// file via Stirling-PDF — e.g. "merge these 3 quotes + the itinerary for the accountant." Input
// names are vault-relative to documents/ (as returned by GET /api/documents), in the order to merge.
export async function mergeDocuments(names: string[], outFilename: string): Promise<DocumentResult> {
  if (names.length < 2) return { ok: false, error: "need at least 2 documents to merge" };
  const cfg = await loadConfig();
  const dir = path.join(cfg.vaultRoot, "documents");
  const files = [];
  for (const name of names) {
    try {
      const buf = await fs.readFile(path.join(dir, name));
      files.push({ name, buf });
    } catch {
      return { ok: false, error: `document not found: ${name}` };
    }
  }

  const merged = await mergePdfs(files);
  if (!merged.ok || !merged.buf) return { ok: false, error: merged.error ?? "merge failed" };

  const stamp = new Date().toISOString().slice(0, 10);
  const filename = `${stamp}-${slug(outFilename)}.pdf`;
  const absPath = path.join(dir, filename);
  await fs.writeFile(absPath, merged.buf);

  const relPath = `documents/${filename}`;
  await ledgerAppend({ kind: "document", actor: "clara", what: `merged ${names.length} documents: ${outFilename}`, ref: relPath });
  return { ok: true, path: absPath, relPath };
}

// Compress a generated document in place (over the vault's own copy) — e.g. before emailing a
// large scanned attachment. Returns the same filename with the smaller file written over it.
export async function compressDocument(name: string): Promise<DocumentResult> {
  const cfg = await loadConfig();
  const dir = path.join(cfg.vaultRoot, "documents");
  let buf: Buffer;
  try {
    buf = await fs.readFile(path.join(dir, name));
  } catch {
    return { ok: false, error: `document not found: ${name}` };
  }
  const compressed = await compressPdf({ name, buf });
  if (!compressed.ok || !compressed.buf) return { ok: false, error: compressed.error ?? "compress failed" };
  await fs.writeFile(path.join(dir, name), compressed.buf);
  await ledgerAppend({ kind: "document", actor: "clara", what: `compressed document: ${name}`, ref: `documents/${name}` });
  return { ok: true, path: path.join(dir, name), relPath: `documents/${name}` };
}
