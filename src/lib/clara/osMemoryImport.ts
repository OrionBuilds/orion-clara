// B3 — import orion's clara_memories into Clara's own vault, making her memory.ts (with this
// session's provenance-tagging fix) the canonical store. orion's own clara_memories table and its
// clara-memory-decay cron are NOT touched here — they become a cold archive per the merge plan
// (B5/B6), not deleted. Idempotent and re-runnable: re-importing overwrites the same file per
// source id rather than duplicating, so it's safe to run again after the archive accumulates more
// rows.

import { promises as fs } from "node:fs";
import path from "node:path";
import { loadConfig } from "./config";
import { osClient, osEnabled } from "./osClient";
import { reindexAll } from "./memory";

interface OsMemoryRow {
  id: string;
  organization_id?: string;
  user_id?: string;
  memory_type?: string;
  title?: string;
  content?: string;
  importance_score?: number;
  created_at?: string;
  updated_at?: string;
  last_accessed_at?: string;
}

function isTextContent(c: unknown): c is { type: "text"; text: string } {
  return typeof c === "object" && c !== null && (c as { type?: unknown }).type === "text" && typeof (c as { text?: unknown }).text === "string";
}

// osClient.callTool() returns MCP content blocks; mcp-server's toolResult() puts the tool's JSON
// response (an array of clara_memories rows) into a single pretty-printed text block.
function extractRows(content: unknown): OsMemoryRow[] {
  if (!Array.isArray(content)) return [];
  const text = content.filter(isTextContent).map((c) => c.text).join("");
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) ? (parsed as OsMemoryRow[]) : [];
  } catch {
    return [];
  }
}

function slug(row: OsMemoryRow): string {
  const base = (row.title || row.content || row.id || "memory")
    .toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  return `${base || "memory"}-${row.id.slice(0, 8)}`;
}

function toMd(row: OsMemoryRow, importedAt: string): string {
  const fm = [
    "---",
    `id: ${row.id}`,
    row.memory_type ? `memory_type: ${row.memory_type}` : null,
    `importance_score: ${row.importance_score ?? 0}`,
    row.created_at ? `created: ${row.created_at}` : null,
    row.updated_at ? `updated: ${row.updated_at}` : null,
    "source: orion",
    `imported: ${importedAt}`,
    "---",
    "",
    `# ${row.title || "CRM memory"}`,
    "",
    (row.content ?? "").trim(),
    "",
  ].filter((l): l is string => l !== null);
  return fm.join("\n");
}

async function targetDir(): Promise<string> {
  const cfg = await loadConfig();
  const d = path.join(cfg.vaultRoot, "crm-memories");
  await fs.mkdir(d, { recursive: true });
  return d;
}

export interface ImportResult { ok: boolean; imported: number; skipped: number; error?: string }

/** clara_memories_list has no offset param (mcp-server limitation) — one page, so `limit` should
 *  cover the whole table. Defaults generously since this is a low-volume, occasional operation. */
export async function importOsMemories(limit = 2000): Promise<ImportResult> {
  if (!osEnabled()) return { ok: false, imported: 0, skipped: 0, error: "orion not connected — visit /api/os/auth" };

  let rows: OsMemoryRow[];
  try {
    const content = await osClient.callTool("clara_memories_list", { limit });
    rows = extractRows(content);
  } catch (e) {
    return { ok: false, imported: 0, skipped: 0, error: String(e).slice(0, 300) };
  }

  const dir = await targetDir();
  const importedAt = new Date().toISOString();
  let imported = 0, skipped = 0;
  for (const row of rows) {
    if (!row.id) { skipped++; continue; }
    await fs.writeFile(path.join(dir, `${slug(row)}.md`), toMd(row, importedAt), "utf8");
    imported++;
  }
  if (imported > 0) await reindexAll();
  return { ok: true, imported, skipped };
}
