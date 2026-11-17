// Clara — company knowledge for the BUSINESS audience.
//
// `knowledge/company.md` is a curated, public-safe reference (services, industries, process,
// credentials, offers; start from knowledge/company.example.md). It is appended to
// CLARA_BUSINESS_IDENTITY for prospects/clients/strangers on SMS, voice and chat so Clara can answer
// "what do you actually do?" with facts instead of "a team member will follow up."
//
// Why a file and not the vault RAG: memory-RAG is principal-only by design (it would pipe the owner's
// own vault into a stranger's reply). This doc is the opposite — written to be shown to anyone.
// It never receives the soul, the owner-facing identity, or anything from the vault.
//
// Refresh: `knowledge/sources.json` lists the Drive files the doc was compiled from. The weekly
// `knowledge-refresh` scheduler job re-reads them, snapshots the text under `knowledge/sources/`,
// and tells the owner which ones changed. It never rewrites company.md on its own — a person (or a
// deliberate session) re-curates, because a silent rewrite is how a stray internal doc ends up
// quoted to a prospect.
import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { detectPromptInjection } from "./injection";
import { BUSINESS_NAME } from "./owner";

const KNOWLEDGE_DIR = () => process.env.CLARA_KNOWLEDGE_DIR ?? path.join(process.cwd(), "knowledge");
const DOC = () => path.join(KNOWLEDGE_DIR(), "company.md");
const SOURCES = () => path.join(KNOWLEDGE_DIR(), "sources.json");
const SNAPSHOTS = () => path.join(KNOWLEDGE_DIR(), "sources");

// Cap what a single prompt carries. company.md is ~6k tokens by design; this is the safety rail if
// someone pastes a 200-page manual into it.
const MAX_CHARS = 32_000;

let cache: { text: string; mtimeMs: number } | null = null;

/** Raw curated doc (cached by mtime). Empty string when missing — callers must degrade gracefully. */
export async function companyKnowledge(): Promise<string> {
  try {
    const st = await fs.stat(DOC());
    if (cache && cache.mtimeMs === st.mtimeMs) return cache.text;
    let text = await fs.readFile(DOC(), "utf8");
    if (text.length > MAX_CHARS) text = text.slice(0, MAX_CHARS) + "\n\n[knowledge truncated]";
    // The doc is authored by us, but it's still text that ends up in a system prompt. Screen it the
    // same way Drive reads are screened; a poisoned edit should fail loud, not quietly steer Clara.
    const verdict = detectPromptInjection(text);
    if (verdict.triggered) {
      console.warn("[clara-knowledge] company.md flagged by the injection detector; not injecting", verdict);
      return "";
    }
    cache = { text, mtimeMs: st.mtimeMs };
    return text;
  } catch {
    return "";
  }
}

/**
 * Prompt block for the business audience. Returns "" when no doc is present so call sites can
 * simply concatenate. Framed as reference material, not as new instructions.
 */
export async function companyKnowledgeBlock(): Promise<string> {
  const text = await companyKnowledge();
  if (!text) return "";
  return [
    "",
    `Company reference (public-safe; you may state any of this plainly, and should when asked what ${BUSINESS_NAME} does):`,
    "<<<COMPANY_KNOWLEDGE",
    text,
    "COMPANY_KNOWLEDGE>>>",
    "If something is not in the reference — a price, a date, a guarantee — say you don't want to guess and offer the 30-minute scoping call.",
  ].join("\n");
}

/**
 * Synchronous variant for prompt builders that can't await (voice brains build prompts inline).
 * Serves the mtime cache; `warmCompanyKnowledge()` primes it at boot and the async path refreshes
 * it on every SMS/chat turn, so voice is at most one edit behind.
 */
export function companyKnowledgeBlockSync(): string {
  const text = cache?.text ?? "";
  if (!text) return "";
  return [
    "",
    `Company reference (public-safe; you may state any of this plainly, and should when asked what ${BUSINESS_NAME} does):`,
    "<<<COMPANY_KNOWLEDGE",
    text,
    "COMPANY_KNOWLEDGE>>>",
    "If something is not in the reference — a price, a date, a guarantee — say you don't want to guess and offer the 30-minute scoping call.",
  ].join("\n");
}

export async function warmCompanyKnowledge(): Promise<boolean> {
  return (await companyKnowledge()).length > 0;
}

// ── Weekly refresh of the underlying Drive sources ──────────────────────────────────────────────

interface KnowledgeSource {
  id: string;        // Drive file id
  title: string;
  /** Optional: only these sections are considered public-safe; recorded for the human re-curating. */
  note?: string;
  /** Short names the owner uses for this file ("the ICP") so the router can resolve them without a search. */
  aliases?: string[];
}

async function loadSources(): Promise<KnowledgeSource[]> {
  try {
    const raw = JSON.parse(await fs.readFile(SOURCES(), "utf8")) as { sources?: KnowledgeSource[] };
    return Array.isArray(raw.sources) ? raw.sources.filter((s) => s && typeof s.id === "string") : [];
  } catch {
    return [];
  }
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

/**
 * Re-read every listed Drive source, snapshot changed text under knowledge/sources/<id>.md, and
 * report what changed. Runs weekly from the scheduler; returns a summary line for the ledger/notify.
 */
/**
 * Snapshot ONE source (by Drive id) under knowledge/sources/<id>.md. Returns whether the text
 * changed. `notify: false` is for Clara's own edits — she made the change, so a "sources changed on
 * Drive" nag would be noise. Unknown ids are a no-op (`ok: false`), so callers can pass any fileId.
 */
export async function refreshKnowledgeSource(
  id: string,
  opts: { notify?: boolean } = {},
): Promise<{ ok: boolean; changed: boolean; title?: string; error?: string }> {
  const src = (await loadSources()).find((s) => s.id === id);
  if (!src) return { ok: false, changed: false, error: "not a knowledge source" };
  try {
    await fs.mkdir(SNAPSHOTS(), { recursive: true });
    const { readAsText } = await import("./ms-files");
    const r = await readAsText(src.id, { account: "work" });
    if (!r.ok || !r.text) return { ok: false, changed: false, title: src.title, error: r.error ?? "empty read" };
    if (r.injection?.triggered) {
      // Snapshot it (so the diff is visible) but mark it — the re-curator must not paste it in blind.
      console.warn(`[clara-knowledge] source "${src.title}" flagged by the injection detector`);
    }
    const file = path.join(SNAPSHOTS(), `${src.id}.md`);
    const header = `---\ntitle: ${JSON.stringify(src.title)}\ndrive_id: ${src.id}\nfetched: ${new Date().toISOString()}\nflagged: ${Boolean(r.injection?.triggered)}\n---\n\n`;
    let prevHash = "";
    try {
      const prev = await fs.readFile(file, "utf8");
      prevHash = sha(prev.replace(/^---[\s\S]*?---\n\n/, ""));
    } catch { /* first snapshot */ }
    const nextHash = sha(r.text);
    const changed = prevHash !== nextHash;
    if (changed) await fs.writeFile(file, header + r.text, "utf8");
    const reportable = changed && Boolean(prevHash); // first fetch is not "changed"
    if (reportable && opts.notify !== false) {
      const { notifyOwner } = await import("./notify");
      await notifyOwner({
        kind: "knowledge.sources_changed",
        priority: "low",
        text: `Company knowledge source changed on Drive: ${src.title}. Snapshot is under CLARA/knowledge/sources — say the word and I'll re-curate company.md.`,
        dedupeKey: `knowledge:changed:${src.id}:${new Date().toISOString().slice(0, 10)}`,
      }).catch(() => {});
    }
    return { ok: true, changed: reportable, title: src.title };
  } catch (e) {
    console.warn(`[clara-knowledge] refresh failed for ${src.title}:`, e);
    return { ok: false, changed: false, title: src.title, error: String((e as Error).message ?? e) };
  }
}

/**
 * Re-read every listed Drive source, snapshot changed text under knowledge/sources/<id>.md, and
 * report what changed. Runs weekly from the scheduler; returns a summary line for the ledger/notify.
 */
export async function refreshKnowledgeSources(): Promise<{ checked: number; changed: string[]; failed: string[] }> {
  const sources = await loadSources();
  const changed: string[] = [];
  const failed: string[] = [];
  if (!sources.length) return { checked: 0, changed, failed };

  for (const src of sources) {
    const r = await refreshKnowledgeSource(src.id, { notify: false });
    if (!r.ok) failed.push(src.title);
    else if (r.changed) changed.push(src.title);
  }

  if (changed.length) {
    const { notifyOwner } = await import("./notify");
    await notifyOwner({
      kind: "knowledge.sources_changed",
      priority: "low",
      text: `Company knowledge sources changed on Drive: ${changed.join(", ")}. Snapshots are under CLARA/knowledge/sources — say the word and I'll re-curate company.md.`,
      dedupeKey: `knowledge:changed:${new Date().toISOString().slice(0, 10)}`,
    }).catch(() => {});
  }
  return { checked: sources.length, changed, failed };
}

// ── Known documents (owner-facing router) ────────────────────────────────────────────────────────
// So "add X to the ICP" resolves straight to drive_read/drive_edit on the right file instead of a
// drive_search round-trip that may land on a copy. Sources only — ~15 lines, never the vault.

/** Pure: render the block from a sources list (exported for tests). */
export function renderKnownDocuments(sources: { id: string; title: string; aliases?: string[] }[]): string {
  if (!sources.length) return "";
  const lines = sources.map((s) => {
    const alias = s.aliases?.length ? ` (aka ${s.aliases.join(", ")})` : "";
    return `- ${s.title}${alias} — file id ${s.id}`;
  });
  return [
    "",
    "KNOWN DOCUMENTS. These Drive files are the company's reference docs; when the owner names one (or an alias), use its file id directly with drive_read / drive_edit — no drive_search needed:",
    ...lines,
    "To edit one: drive_read it first (page with offset if truncated), then drive_edit with docs-replace (copy `find` text verbatim from what you read) or docs-insert to append. Report exactly what the tool returned.",
  ].join("\n");
}

export async function knownDocumentsBlock(): Promise<string> {
  return renderKnownDocuments(await loadSources());
}
