// Clara — vector-searchable memory over the vault.
//
// Facade over the shared embeddings pipeline (@autom8ionlab/agent-core — LM Studio
// /v1/embeddings + cosine similarity, extracted out of FRIDAY's/Clara's formerly-duplicated
// local copies into the shared package). Clara's own index is separate from FRIDAY's
// skill/memory indices — different file, different content shape (contacts, onboarding
// transcripts, briefs, ledger notes keyed by vault-relative path, not FRIDAY's
// client/project model).
//
// Best-effort throughout: if LM Studio's embed model isn't available, indexing/search
// degrade to no-ops rather than throwing — Clara's other features never depend on this.

import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { loadConfig } from "./config";
import { embed, cosine } from "./embeddings";
import { OWNER_FIRST } from "./owner";

const INDEX_FILE_NAME = "memory-index.json";

export interface MemoryEntry {
  relPath: string;       // vault-relative path, e.g. "contacts/acme-client.md"
  contentHash: string;   // sha1 of the indexed text — used to detect changes cheaply
  snippet: string;       // first ~400 chars, shown in search results
  updatedAt: string;
  vec: number[];
}

let cached: MemoryEntry[] | null = null;

async function indexPath(): Promise<string> {
  const cfg = await loadConfig();
  return path.join(cfg.dataDir, INDEX_FILE_NAME);
}

async function loadIndex(): Promise<MemoryEntry[]> {
  if (cached) return cached;
  try {
    cached = JSON.parse(await fs.readFile(await indexPath(), "utf8")) as MemoryEntry[];
  } catch {
    cached = [];
  }
  return cached;
}

async function saveIndex(rows: MemoryEntry[]): Promise<void> {
  cached = rows;
  await fs.writeFile(await indexPath(), JSON.stringify(rows), "utf8");
}

function hash(text: string): string {
  return crypto.createHash("sha1").update(text).digest("hex");
}
function snippet(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 400);
}

// Provenance framing (mirrors FRIDAY's clientChannel.ts fix for the same failure class, at the
// file level instead of the message level): a vault file's top-level folder tells you what kind
// of claim its content is — Clara's own unverified summary, a raw unattributed transcript, a
// completed ledger fact, reference data — but indexVaultFile used to embed the raw text with none
// of that context, so a Clara-drafted promise or an unverified third-party claim could get recalled
// later as undifferentiated fact. Tagging by folder is cheap, deterministic, and needs no new
// per-entry bookkeeping — every vault write already goes into one of these folders on purpose.
const PROVENANCE_TAGS: Record<string, string> = {
  briefs: "Clara's own brief (status/summary, not independently verified)",
  transcripts: `Transcript (${OWNER_FIRST}/third-party said — unattributed within the text itself, verify before treating as fact)`,
  meetings: "Meeting digest (Clara's own summary + action items over a third-party transcript — items are her attribution, not verified commitments)",
  ledger: "Ledger entry (Clara's own recorded action — a completed fact)",
  tasks: "Task entry (status as of last update, may be stale)",
  followups: "Follow-up entry (open item, may be stale)",
  contacts: "Contact record (reference data)",
  vendors: "Vendor record (reference data)",
  preferences: `Preference record (${OWNER_FIRST}'s stated preference)`,
  approvals: `Approval record (a decision ${OWNER_FIRST} made)`,
  documents: "Document (generated or uploaded file content)",
  legal: "Legal record (reference data — not legal advice)",
  tax: "Tax record (reference data — not tax advice)",
  sensitive: "Sensitive note (reference data)",
  "crm-memories": `CRM memory (imported from orion's clara_memories, ${OWNER_FIRST}/org-scoped — reference data, not independently re-verified on import)`,
};
function provenanceTag(relPath: string): string {
  const top = relPath.split("/")[0]?.toLowerCase();
  return PROVENANCE_TAGS[top] ?? "Vault note (unattributed)";
}

// Index (or re-index if changed) a single vault file. `absPath` must live under the vault root.
export async function indexVaultFile(absPath: string): Promise<{ indexed: boolean; reason?: string }> {
  const cfg = await loadConfig();
  const relPath = path.relative(cfg.vaultRoot, absPath).replace(/\\/g, "/");
  let raw: string;
  try {
    raw = (await fs.readFile(absPath, "utf8")).trim();
  } catch {
    return { indexed: false, reason: "unreadable" };
  }
  if (raw.length < 12) return { indexed: false, reason: "too short" };
  const text = `${provenanceTag(relPath)}: ${raw}`;

  const h = hash(text);
  const rows = await loadIndex();
  const existing = rows.find((r) => r.relPath === relPath);
  if (existing && existing.contentHash === h) return { indexed: false, reason: "unchanged" };

  let vec: number[];
  try {
    const [v] = await embed([text]);
    if (!v) return { indexed: false, reason: "embed unavailable" };
    vec = v;
  } catch (e) {
    return { indexed: false, reason: (e as Error).message };
  }

  const entry: MemoryEntry = { relPath, contentHash: h, snippet: snippet(text), updatedAt: new Date().toISOString(), vec };
  const next = rows.filter((r) => r.relPath !== relPath);
  next.push(entry);
  await saveIndex(next);
  return { indexed: true };
}

// Walk the whole vault and (re-)index every markdown file that's new or changed.
export async function reindexAll(): Promise<{ scanned: number; indexed: number; skipped: number }> {
  const cfg = await loadConfig();
  let scanned = 0, indexed = 0, skipped = 0;
  const stack = [cfg.vaultRoot];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: import("node:fs").Dirent[] = [];
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { stack.push(full); continue; }
      if (!e.name.toLowerCase().endsWith(".md")) continue;
      scanned++;
      const res = await indexVaultFile(full);
      if (res.indexed) indexed++; else skipped++;
    }
  }
  return { scanned, indexed, skipped };
}

export interface SearchHit { relPath: string; snippet: string; score: number; updatedAt: string }

export async function searchMemory(query: string, k = 8): Promise<SearchHit[]> {
  const q = query.trim();
  if (!q) return [];
  const rows = await loadIndex();
  if (!rows.length) return [];
  let qVec: number[];
  try {
    const [v] = await embed([q]);
    if (!v) return [];
    qVec = v;
  } catch {
    return [];
  }
  return rows
    .map((r) => ({ relPath: r.relPath, snippet: r.snippet, updatedAt: r.updatedAt, score: cosine(qVec, r.vec) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

export async function indexStats(): Promise<{ count: number }> {
  return { count: (await loadIndex()).length };
}
