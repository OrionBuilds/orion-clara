// Clara — Stirling-PDF client. Thin REST wrapper around a local Stirling-PDF Docker service
// (docker.stirlingpdf.com/stirlingtools/stirling-pdf, run with SECURITY_ENABLELOGIN=false —
// same no-auth trust model as LM Studio: 127.0.0.1-only, never exposed via the tunnel).
//
// Adds capabilities Clara has none of today: merging multiple PDFs, OCR on a scanned/photographed
// document, redacting sensitive text, compressing attachments. Endpoint paths + form fields
// confirmed against the running container's own OpenAPI doc (GET /v1/api-docs).

function baseUrl(): string {
  return (process.env.CLARA_STIRLING_BASE_URL ?? "http://127.0.0.1:8090").replace(/\/+$/, "");
}

export interface StirlingFile { name: string; buf: Buffer }
export interface StirlingResult { ok: boolean; buf?: Buffer; error?: string }

async function callStirling(path: string, form: FormData): Promise<StirlingResult> {
  try {
    const r = await fetch(`${baseUrl()}${path}`, { method: "POST", body: form, signal: AbortSignal.timeout(120_000) });
    if (!r.ok) return { ok: false, error: `Stirling-PDF ${path} ${r.status}: ${(await r.text().catch(() => "")).slice(0, 300)}` };
    return { ok: true, buf: Buffer.from(await r.arrayBuffer()) };
  } catch (e) {
    return { ok: false, error: `Stirling-PDF unreachable: ${(e as Error).message}` };
  }
}

export async function stirlingHealth(): Promise<boolean> {
  try {
    const r = await fetch(`${baseUrl()}/api/v1/info/status`, { signal: AbortSignal.timeout(3000) });
    if (!r.ok) return false;
    const j = await r.json() as { status?: string };
    return j.status === "UP";
  } catch {
    return false;
  }
}

/** Merge multiple PDFs (in the given order) into one — e.g. bundling vendor quotes + itinerary. */
export async function mergePdfs(files: StirlingFile[]): Promise<StirlingResult> {
  if (files.length < 2) return { ok: false, error: "mergePdfs needs at least 2 files" };
  const form = new FormData();
  for (const f of files) form.append("fileInput", new Blob([new Uint8Array(f.buf)], { type: "application/pdf" }), f.name);
  form.append("sortType", "orderProvided");
  form.append("removeCertSign", "true");
  return callStirling("/api/v1/general/merge-pdfs", form);
}

/** OCR a scanned/photographed PDF so its text becomes extractable — e.g. before legal-tax.ts's reviewContract(). */
export async function ocrPdf(file: StirlingFile, opts: { languages?: string[] } = {}): Promise<StirlingResult> {
  const form = new FormData();
  form.append("fileInput", new Blob([new Uint8Array(file.buf)], { type: "application/pdf" }), file.name);
  for (const lang of opts.languages ?? ["eng"]) form.append("languages", lang);
  form.append("ocrType", "Normal");
  form.append("ocrRenderType", "hocr");
  return callStirling("/api/v1/misc/ocr-pdf", form);
}

/** Redact sensitive terms (SSNs, account numbers, names) before sending a document onward. */
export async function redactPdf(file: StirlingFile, terms: string[]): Promise<StirlingResult> {
  if (!terms.length) return { ok: false, error: "redactPdf needs at least one term" };
  const form = new FormData();
  form.append("fileInput", new Blob([new Uint8Array(file.buf)], { type: "application/pdf" }), file.name);
  form.append("listOfText", terms.join(","));
  form.append("useRegex", "false");
  form.append("wholeWordSearch", "false");
  form.append("redactColor", "#000000");
  form.append("customPadding", "2");
  // Flattens the page to an image after redacting so the covered text can't be selected/recovered.
  form.append("convertPDFToImage", "true");
  return callStirling("/api/v1/security/auto-redact", form);
}

/** Extract plain text from a PDF (typically after ocrPdf() has given it a text layer). */
export async function pdfToText(file: StirlingFile): Promise<{ ok: boolean; text?: string; error?: string }> {
  const form = new FormData();
  form.append("fileInput", new Blob([new Uint8Array(file.buf)], { type: "application/pdf" }), file.name);
  form.append("outputFormat", "txt");
  const res = await callStirling("/api/v1/convert/pdf/text", form);
  if (!res.ok || !res.buf) return { ok: false, error: res.error };
  return { ok: true, text: res.buf.toString("utf8") };
}

/** Compress a PDF — e.g. before emailing a large scanned attachment. level: 1 (light) - 9 (max). */
export async function compressPdf(file: StirlingFile, level = 4): Promise<StirlingResult> {
  const form = new FormData();
  form.append("fileInput", new Blob([new Uint8Array(file.buf)], { type: "application/pdf" }), file.name);
  form.append("optimizeLevel", String(level));
  form.append("expectedOutputSize", "");
  form.append("linearize", "false");
  form.append("normalize", "false");
  form.append("grayscale", "false");
  return callStirling("/api/v1/misc/compress-pdf", form);
}
