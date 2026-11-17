// Clara — path-safe vault access. The single chokepoint every vault-touching API route goes
// through (editor, wikilinks, transcript viewer). Nothing else in the app should build vault
// paths from user input.
//
// Threat model: the /vault editor and /api/vault/* routes take arbitrary relative paths from the
// browser. A traversal bug here means "web request can read/write any file the Next process can" —
// so rejection is layered and deliberately paranoid:
//   - no absolute paths, no ".." segments (checked on SEGMENTS, not substrings — "..foo" is fine)
//   - no ":" anywhere (blocks both drive letters and NTFS alternate data streams like "note.md:x")
//   - no null bytes
//   - after resolution, a case-insensitive prefix check against vaultRoot (NTFS is case-insensitive;
//     a case-sensitive startsWith would pass "d:\vault\clara\..\..\x" style probes on the
//     comparison even after resolve on some path shapes)
// Writes are further restricted to .md so the UI can never touch ledger.jsonl / queue.json /
// _index.json even through a legit vault path.

import { promises as fs } from "node:fs";
import path from "node:path";
import { loadConfig } from "./config";
import { append as ledgerAppend } from "./ledger";
import { indexVaultFile } from "./memory";

const TEXT_READ_EXTS = new Set([".md", ".txt", ".json", ".jsonl"]);
const RAW_READ_TYPES: Record<string, string> = {
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".pdf": "application/pdf",
};

export class VaultPathError extends Error {
  constructor(msg: string) { super(msg); this.name = "VaultPathError"; }
}

/** Validate + resolve a vault-relative path. Throws VaultPathError on anything suspicious. */
export async function safeResolve(rel: string): Promise<{ abs: string; rel: string }> {
  const cfg = await loadConfig();
  if (typeof rel !== "string" || !rel.trim()) throw new VaultPathError("empty path");
  if (rel.includes("\0")) throw new VaultPathError("null byte in path");
  if (rel.includes(":")) throw new VaultPathError("':' not allowed (drive letters / NTFS streams)");
  const normalizedRel = rel.replace(/\\/g, "/");
  if (path.isAbsolute(normalizedRel) || normalizedRel.startsWith("/")) throw new VaultPathError("absolute paths not allowed");
  const segments = normalizedRel.split("/");
  if (segments.some((s) => s === ".." || s === "")) throw new VaultPathError("'..' or empty path segments not allowed");

  const root = path.resolve(cfg.vaultRoot);
  const abs = path.resolve(root, normalizedRel);
  const cmp = (s: string) => (process.platform === "win32" ? s.toLowerCase() : s);
  if (cmp(abs) !== cmp(root) && !cmp(abs).startsWith(cmp(root + path.sep))) {
    throw new VaultPathError("path escapes the vault");
  }
  return { abs, rel: segments.join("/") };
}

export interface TreeNode {
  name: string;
  relPath: string;
  type: "dir" | "file";
  ext?: string;
  size?: number;
  mtimeMs?: number;
  children?: TreeNode[];
}

/** Recursive vault listing. Skips dotfiles/dirs and derived index files. */
export async function listTree(): Promise<TreeNode[]> {
  const cfg = await loadConfig();
  const root = path.resolve(cfg.vaultRoot);

  async function walk(dirAbs: string, dirRel: string): Promise<TreeNode[]> {
    let entries: import("node:fs").Dirent[] = [];
    try { entries = await fs.readdir(dirAbs, { withFileTypes: true }); } catch { return []; }
    const nodes: TreeNode[] = [];
    for (const e of entries) {
      if (e.name.startsWith(".") || e.name === "_index.json") continue;
      const rel = dirRel ? `${dirRel}/${e.name}` : e.name;
      const abs = path.join(dirAbs, e.name);
      if (e.isDirectory()) {
        nodes.push({ name: e.name, relPath: rel, type: "dir", children: await walk(abs, rel) });
      } else {
        const ext = path.extname(e.name).toLowerCase();
        let size: number | undefined, mtimeMs: number | undefined;
        try { const st = await fs.stat(abs); size = st.size; mtimeMs = st.mtimeMs; } catch { /* races are fine */ }
        nodes.push({ name: e.name, relPath: rel, type: "file", ext, size, mtimeMs });
      }
    }
    // Dirs first, then files, each alphabetical — matches Obsidian's default ordering.
    nodes.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
    return nodes;
  }

  return walk(root, "");
}

export async function readNote(rel: string): Promise<{ content: string; mtimeMs: number }> {
  const { abs } = await safeResolve(rel);
  const ext = path.extname(abs).toLowerCase();
  if (!TEXT_READ_EXTS.has(ext)) throw new VaultPathError(`reading ${ext || "(no extension)"} as text is not allowed`);
  const [content, st] = await Promise.all([fs.readFile(abs, "utf8"), fs.stat(abs)]);
  return { content, mtimeMs: st.mtimeMs };
}

export async function readRaw(rel: string): Promise<{ buf: Buffer; contentType: string }> {
  const { abs } = await safeResolve(rel);
  const ext = path.extname(abs).toLowerCase();
  const contentType = RAW_READ_TYPES[ext];
  if (!contentType) throw new VaultPathError(`raw reads limited to ${Object.keys(RAW_READ_TYPES).join("/")}`);
  return { buf: await fs.readFile(abs), contentType };
}

export class VaultConflictError extends Error {
  constructor(public diskMtimeMs: number) { super("file changed on disk since it was loaded"); this.name = "VaultConflictError"; }
}

/**
 * Write a markdown note. `.md` only — the editor must never be able to rewrite operational files
 * (ledger.jsonl, queues, indices) even via a legitimate in-vault path. When `expectedMtime` is
 * given and the on-disk file is newer, throws VaultConflictError (409 at the route) — Clara's own
 * writers (tasks.ts, contacts.ts) rewrite these files too, so last-write-wins would eat edits.
 */
export async function writeNote(rel: string, content: string, opts: { expectedMtime?: number; actor?: "owner" | "clara" } = {}): Promise<{ mtimeMs: number }> {
  const { abs, rel: cleanRel } = await safeResolve(rel);
  if (path.extname(abs).toLowerCase() !== ".md") throw new VaultPathError("writes are limited to .md files");

  if (opts.expectedMtime !== undefined) {
    try {
      const st = await fs.stat(abs);
      // mtime precision differs across tools; treat >1s drift as a real conflict.
      if (Math.abs(st.mtimeMs - opts.expectedMtime) > 1000) throw new VaultConflictError(st.mtimeMs);
    } catch (e) {
      if (e instanceof VaultConflictError) throw e;
      // ENOENT → new file, no conflict possible.
    }
  }

  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf8");
  const st = await fs.stat(abs);

  await ledgerAppend({ kind: "action", actor: opts.actor ?? "owner", what: `vault edit: ${cleanRel}`, ref: cleanRel }).catch(() => {});
  void indexVaultFile(abs).catch(() => {}); // keep memory fresh; never block the save on it

  return { mtimeMs: st.mtimeMs };
}
