// crawler/evidence.ts — persists a crawled page locally and records it as a company_sources row.
//
// Mirrors ledger.ts's loadConfig()->cfg.dataDir local-first rationale: the local file is the
// durable copy (company_sources in the OS exists now, orion PRs 01-03, but a failed/unavailable
// `sources_add` call must never lose the content itself, only the OS's audit row of it) — same
// "best-effort OS mirror, swallow the error" idiom as ledger.ts's providerRequestAdd.

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { loadConfig } from "../../config";
import { sourcesAdd as sourcesAddReal, type SourcesAddInput } from "../osBridge";

export type SourceType = NonNullable<SourcesAddInput["source_type"]>;
export type FetchMethod = NonNullable<SourcesAddInput["fetch_method"]>;

/** sources_add's content_text cap (see osBridge.ts's SourcesAddInput doc comment). */
export const MAX_INLINE_TEXT_BYTES = 200_000;

/** Home → "homepage", /about(-us) → "about", etc. — best-effort from the path alone; "other" when
 *  nothing matches rather than guessing wrong. */
export function inferSourceType(url: string): SourceType {
  let pathname: string;
  try {
    pathname = new URL(url).pathname.toLowerCase();
  } catch {
    return "other";
  }
  const p = pathname.replace(/\/+$/, "") || "/";
  if (p === "/") return "homepage";
  if (p.includes("about")) return "about";
  if (p.includes("contact")) return "contact";
  if (p.includes("team")) return "team";
  if (p.includes("service")) return "services";
  if (p.includes("career") || p.includes("job")) return "careers";
  if (p.includes("financ")) return "financing";
  if (p.includes("review")) return "reviews";
  return "other";
}

export interface WriteEvidenceInput {
  companyId: string;
  url: string;
  /** Plain text (htmlToText's output, or Jina's already-extracted text). Always written. */
  text: string;
  /** Raw HTML, when the rung that fetched this page had any (http/playwright; jina has none). */
  html?: string;
  fetchMethod: FetchMethod;
  researchJobId?: string;
}

export interface EvidenceRef {
  sha: string;
  companyId: string;
  url: string;
  sourceType: SourceType;
  htmlPath?: string;
  txtPath: string;
  sourceId?: string;
}

export interface EvidenceDeps {
  sourcesAdd: typeof sourcesAddReal;
}

export const defaultEvidenceDeps: EvidenceDeps = { sourcesAdd: sourcesAddReal };

async function evidenceDir(companyId: string): Promise<string> {
  const cfg = await loadConfig();
  const dir = path.join(cfg.dataDir, "prospecting", "evidence", companyId);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/**
 * Writes a crawled page to `dataDir/prospecting/evidence/<companyId>/<sha>.{html,txt}` (sha =
 * sha256 of the text) and records it with the OS as a company_sources row — inline (`content_text`)
 * when the text fits the tool's 200KB cap, else a `content_ref` pointing at the local file. The OS
 * call is best-effort: a failure there still returns a usable ref (no `sourceId`) because the local
 * file — not the OS row — is what PR 8's extract stage actually reads.
 */
export async function writeEvidence(input: WriteEvidenceInput, deps: EvidenceDeps = defaultEvidenceDeps): Promise<EvidenceRef> {
  const sha = createHash("sha256").update(input.text, "utf8").digest("hex");
  const dir = await evidenceDir(input.companyId);

  const txtPath = path.join(dir, `${sha}.txt`);
  await fs.writeFile(txtPath, input.text, "utf8");

  let htmlPath: string | undefined;
  if (input.html) {
    htmlPath = path.join(dir, `${sha}.html`);
    await fs.writeFile(htmlPath, input.html, "utf8");
  }

  const sourceType = inferSourceType(input.url);
  const textBytes = Buffer.byteLength(input.text, "utf8");

  let sourceId: string | undefined;
  try {
    const res = await deps.sourcesAdd({
      company_id: input.companyId,
      url: input.url,
      source_type: sourceType,
      fetch_method: input.fetchMethod,
      content_hash: sha,
      ...(textBytes <= MAX_INLINE_TEXT_BYTES ? { content_text: input.text } : { content_ref: txtPath }),
      ...(input.researchJobId ? { research_job_id: input.researchJobId } : {}),
    });
    sourceId = res.source_id;
  } catch {
    /* best-effort OS mirror — see module doc comment */
  }

  return { sha, companyId: input.companyId, url: input.url, sourceType, htmlPath, txtPath, sourceId };
}
