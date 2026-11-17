// Clara — [[wikilink]] index: Obsidian-compatible backlinks over the vault. Not a new format —
// the vault IS a real Obsidian vault, so this adopts Obsidian's own [[target]], [[target|alias]],
// [[target#heading]], [[target#heading|alias]] syntax rather than inventing a parallel one. A link
// written in the /vault editor renders identically when the same file is opened in Obsidian.
//
// The index is DERIVED state, stored in dataDir (~/.agentic-os/clara/link-index.json), never in
// the vault itself — so Obsidian and git only ever see real note edits, not index churn.

import { promises as fs } from "node:fs";
import path from "node:path";
import { loadConfig } from "./config";
import { listTree, readNote, type TreeNode } from "./vault";
import { listContacts } from "./contacts";

export const WIKILINK_RX = /\[\[([^\]|#\n]+)(?:#[^\]|\n]*)?(?:\|([^\]\n]*))?\]\]/g;

export interface LinkOccurrence {
  raw: string;              // literal target text inside [[ ]], trimmed
  resolved: string | null;  // resolved vault relPath, or null if the target doesn't match any note
  context: string;          // ~160 chars of surrounding text
  line: number;
}
interface FileLinks { mtimeMs: number; links: LinkOccurrence[] }
interface LinkIndexData { builtAt: string; files: Record<string, FileLinks> }

let cached: LinkIndexData | null = null;

async function indexPath(): Promise<string> {
  const cfg = await loadConfig();
  return path.join(cfg.dataDir, "link-index.json");
}

async function loadIndex(): Promise<LinkIndexData> {
  if (cached) return cached;
  try {
    cached = JSON.parse(await fs.readFile(await indexPath(), "utf8")) as LinkIndexData;
  } catch {
    cached = { builtAt: new Date(0).toISOString(), files: {} };
  }
  return cached;
}

async function saveIndex(idx: LinkIndexData): Promise<void> {
  cached = idx;
  await fs.writeFile(await indexPath(), JSON.stringify(idx), "utf8").catch(() => {});
}

function flattenMdFiles(nodes: TreeNode[], out: { relPath: string }[] = []): { relPath: string }[] {
  for (const n of nodes) {
    if (n.type === "dir") flattenMdFiles(n.children ?? [], out);
    else if (n.ext === ".md") out.push({ relPath: n.relPath });
  }
  return out;
}

function basenameOf(relPath: string): string {
  return path.basename(relPath, ".md");
}

/** Case-insensitive basename -> relPath(s), shortest-path-wins on collision (Obsidian's own
 *  tie-break is "closest to the linking file," which needs per-file context this doesn't track —
 *  shortest path is a reasonable, simple approximation for a single-user vault). */
function buildBasenameIndex(files: { relPath: string }[]): Map<string, string[]> {
  const idx = new Map<string, string[]>();
  for (const f of files) {
    const key = basenameOf(f.relPath).toLowerCase();
    const list = idx.get(key) ?? [];
    list.push(f.relPath);
    idx.set(key, list);
  }
  for (const list of idx.values()) {
    list.sort((a, b) => a.split("/").length - b.split("/").length || a.length - b.length);
  }
  return idx;
}

function resolveTarget(target: string, basenameIndex: Map<string, string[]>): string | null {
  const clean = target.trim().toLowerCase();
  return basenameIndex.get(clean)?.[0] ?? basenameIndex.get(path.basename(clean).toLowerCase())?.[0] ?? null;
}

function extractLinks(content: string, basenameIndex: Map<string, string[]>): LinkOccurrence[] {
  const out: LinkOccurrence[] = [];
  const lineStarts: number[] = [];
  let offset = 0;
  for (const l of content.split("\n")) { lineStarts.push(offset); offset += l.length + 1; }

  const rx = new RegExp(WIKILINK_RX.source, "g");
  let m: RegExpExecArray | null;
  while ((m = rx.exec(content))) {
    const raw = m[1].trim();
    if (!raw) continue;
    const start = Math.max(0, m.index - 80);
    const end = Math.min(content.length, m.index + m[0].length + 80);
    const context = content.slice(start, end).replace(/\s+/g, " ").trim();
    let line = 1;
    for (let i = 0; i < lineStarts.length; i++) { if (lineStarts[i] <= m.index) line = i + 1; else break; }
    out.push({ raw, resolved: resolveTarget(raw, basenameIndex), context, line });
  }
  return out;
}

/** Full rebuild — scheduled weekly + on boot if the index is missing. Cheap at vault scale
 *  (hundreds of files): reads every .md once. */
export async function rebuildLinkIndex(): Promise<{ files: number; links: number }> {
  const mdFiles = flattenMdFiles(await listTree());
  const basenameIndex = buildBasenameIndex(mdFiles);

  const files: Record<string, FileLinks> = {};
  let totalLinks = 0;
  for (const f of mdFiles) {
    let content: string, mtimeMs: number;
    try { ({ content, mtimeMs } = await readNote(f.relPath)); } catch { continue; }
    const links = extractLinks(content, basenameIndex);
    if (links.length) { files[f.relPath] = { mtimeMs, links }; totalLinks += links.length; }
  }
  await saveIndex({ builtAt: new Date().toISOString(), files });
  return { files: Object.keys(files).length, links: totalLinks };
}

export async function indexExists(): Promise<boolean> {
  try { await fs.stat(await indexPath()); return true; } catch { return false; }
}

/** Incremental update for a single file — called from vault.ts's writeNote() after every save, so
 *  backlinks stay current without waiting for the weekly rebuild. Re-derives the basename index
 *  from the current file list each time (cheap; avoids drift if a note was renamed elsewhere). */
export async function updateFileInIndex(relPath: string, content: string): Promise<void> {
  const idx = await loadIndex();
  const basenameIndex = buildBasenameIndex(flattenMdFiles(await listTree()));
  const links = extractLinks(content, basenameIndex);
  if (links.length) idx.files[relPath] = { mtimeMs: Date.now(), links };
  else delete idx.files[relPath];
  await saveIndex(idx);
}

export interface Backlink { from: string; context: string; line: number }
export async function backlinksFor(relPath: string): Promise<Backlink[]> {
  const idx = await loadIndex();
  const target = relPath.toLowerCase();
  const out: Backlink[] = [];
  for (const [from, fl] of Object.entries(idx.files)) {
    for (const link of fl.links) {
      if (link.resolved?.toLowerCase() === target) out.push({ from, context: link.context, line: link.line });
    }
  }
  return out;
}

export async function forwardLinksFor(relPath: string): Promise<LinkOccurrence[]> {
  const idx = await loadIndex();
  return idx.files[relPath]?.links ?? [];
}

export interface EntityCandidate { label: string; relPath: string; kind: "note" | "contact" }

/** Autocomplete source for `[[` / `@` in the editor. Notes first-match on basename; contacts by
 *  display name (mapped to their vault file — contacts.ts's own fileForId() fallback handles the
 *  rare case where a contact's file doesn't match `${id}.md`, so this is a best-effort suggestion,
 *  not a guarantee — resolution at link-index build time is what's authoritative). */
export async function entityCandidates(q: string): Promise<EntityCandidate[]> {
  const query = q.trim().toLowerCase();
  if (!query) return [];

  const mdFiles = flattenMdFiles(await listTree());
  const noteHits: EntityCandidate[] = mdFiles
    .filter((f) => basenameOf(f.relPath).toLowerCase().includes(query))
    .slice(0, 8)
    .map((f) => ({ label: basenameOf(f.relPath), relPath: f.relPath, kind: "note" as const }));

  const contacts = await listContacts().catch(() => []);
  const contactHits: EntityCandidate[] = contacts
    .filter((c) => c.name.toLowerCase().includes(query))
    .slice(0, 8)
    .map((c) => ({ label: c.name, relPath: `contacts/${c.id}.md`, kind: "contact" as const }));

  const seen = new Set<string>();
  return [...contactHits, ...noteHits]
    .filter((c) => (seen.has(c.relPath) ? false : (seen.add(c.relPath), true)))
    .slice(0, 10);
}
