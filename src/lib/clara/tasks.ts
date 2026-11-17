// Clara — task/reminder store.
//
// Markdown files in vault/tasks/ are the source of truth, and are now genuinely READ as such:
// every list/get parses the .md files, so a task edited in Obsidian is picked up rather than
// silently overwritten. _index.json is a derived cache, rebuilt from the files on every load —
// it exists to keep the folder greppable/inspectable, not as an authority.

import { promises as fs } from "node:fs";
import path from "node:path";
import { loadConfig } from "./config";
import { parseMd, parseList } from "./frontmatter";

export type TaskStatus = "open" | "doing" | "done" | "cancelled";

export interface Task {
  id: string;
  title: string;
  detail?: string;
  status: TaskStatus;
  dueAt?: string;             // ISO
  assignee?: TaskAssignee;
  createdAt: string;
  updatedAt: string;
  tags?: string[];
  /** Receipt from the agent this task was handed to (friday) — e.g. "friday:task-ids…". */
  dispatchedRef?: string;
  /** Where the task came from when Clara made it herself — e.g. "clara-meeting:wispr:<id>". */
  source?: string;
}

// owner/clara are Clara's own book; friday tasks are ones she has HANDED to another agent and is
// tracking, not doing. Agent-owned rows never sync to Google Tasks (the owner's phone shows their own).
export type TaskAssignee = "owner" | "clara" | "friday";
export const TASK_ASSIGNEES: readonly TaskAssignee[] = ["owner", "clara", "friday"] as const;
export const AGENT_ASSIGNEES: readonly TaskAssignee[] = ["friday"] as const;
export function isAgentTask(t: Pick<Task, "assignee">): boolean {
  return AGENT_ASSIGNEES.includes(t.assignee ?? "clara");
}

async function dir(): Promise<string> {
  const cfg = await loadConfig();
  const d = path.join(cfg.vaultRoot, "tasks");
  await fs.mkdir(d, { recursive: true });
  return d;
}
const INDEX = "_index.json";

const STATUSES: TaskStatus[] = ["open", "doing", "done", "cancelled"];

function fromMd(raw: string, fallbackId: string): Task | null {
  const { fm, heading, body } = parseMd(raw);
  const title = heading ?? fm.title;
  if (!title) return null;
  const status = STATUSES.includes(fm.status as TaskStatus) ? (fm.status as TaskStatus) : "open";
  const assignee = TASK_ASSIGNEES.includes(fm.assignee as TaskAssignee) ? (fm.assignee as TaskAssignee) : "clara";
  return {
    id: fm.id || fallbackId,
    title,
    detail: body || undefined,
    status,
    dueAt: fm.due || undefined,
    assignee,
    createdAt: fm.created || new Date().toISOString(),
    updatedAt: fm.updated || fm.created || new Date().toISOString(),
    tags: parseList(fm.tags),
    dispatchedRef: fm.dispatchedRef || undefined,
    source: fm.source || undefined,
  };
}

// Reads every task .md and rebuilds the derived index. The markdown is authoritative; a file
// deleted by hand is genuinely gone, and a hand-edited file wins over whatever the cache said.
async function loadIndex(): Promise<Task[]> {
  const d = await dir();
  let files: string[] = [];
  try { files = await fs.readdir(d); } catch { return []; }
  const rows: Task[] = [];
  for (const f of files) {
    if (!f.endsWith(".md")) continue;
    const raw = await fs.readFile(path.join(d, f), "utf8").catch(() => null);
    if (raw == null) continue;
    const t = fromMd(raw, f.replace(/\.md$/, ""));
    if (t) rows.push(t);
  }
  rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  // Best-effort cache refresh — never let an index write failure break a read.
  await fs.writeFile(path.join(d, INDEX), JSON.stringify(rows, null, 2), "utf8").catch(() => {});
  return rows;
}

async function saveIndex(rows: Task[]): Promise<void> {
  await fs.writeFile(path.join(await dir(), INDEX), JSON.stringify(rows, null, 2), "utf8").catch(() => {});
}

// Normally `${id}.md`, but a task hand-created in Obsidian may carry its id in frontmatter while
// living under a different filename. Resolve the real file so we edit in place instead of writing
// a second file that parses to the same id.
async function fileForId(id: string): Promise<string> {
  const d = await dir();
  const direct = `${id}.md`;
  if (await fs.stat(path.join(d, direct)).catch(() => null)) return direct;
  const files = await fs.readdir(d).catch(() => [] as string[]);
  for (const f of files) {
    if (!f.endsWith(".md")) continue;
    const raw = await fs.readFile(path.join(d, f), "utf8").catch(() => "");
    if (fromMd(raw, f.replace(/\.md$/, ""))?.id === id) return f;
  }
  return direct;
}

function toMd(t: Task): string {
  const front = [
    "---",
    `id: ${t.id}`,
    `status: ${t.status}`,
    `assignee: ${t.assignee ?? "clara"}`,
    t.dueAt ? `due: ${t.dueAt}` : null,
    t.tags?.length ? `tags: [${t.tags.join(", ")}]` : null,
    t.dispatchedRef ? `dispatchedRef: ${t.dispatchedRef}` : null,
    t.source ? `source: ${t.source}` : null,
    `created: ${t.createdAt}`,
    `updated: ${t.updatedAt}`,
    "---",
    "",
    `# ${t.title}`,
    "",
    t.detail ?? "",
  ].filter(Boolean).join("\n");
  return front + "\n";
}

export async function add(input: Pick<Task, "title"> & Partial<Task>): Promise<Task> {
  const now = new Date().toISOString();
  const t: Task = {
    id: crypto.randomUUID(),
    title: input.title,
    detail: input.detail,
    status: input.status ?? "open",
    dueAt: input.dueAt,
    assignee: input.assignee ?? "clara",
    createdAt: now,
    updatedAt: now,
    tags: input.tags,
    dispatchedRef: input.dispatchedRef,
    source: input.source,
  };
  const rows = await loadIndex();
  rows.push(t);
  await saveIndex(rows);
  await fs.writeFile(path.join(await dir(), `${t.id}.md`), toMd(t), "utf8");
  return t;
}

export async function update(id: string, patch: Partial<Task>): Promise<Task | null> {
  const rows = await loadIndex();
  const i = rows.findIndex((r) => r.id === id);
  if (i < 0) return null;
  const next: Task = { ...rows[i], ...patch, updatedAt: new Date().toISOString() };
  rows[i] = next;
  await saveIndex(rows);
  await fs.writeFile(path.join(await dir(), await fileForId(next.id)), toMd(next), "utf8");
  return next;
}

export async function listOpen(): Promise<Task[]> {
  return (await loadIndex()).filter((t) => t.status === "open" || t.status === "doing");
}

export async function listAll(): Promise<Task[]> {
  return loadIndex();
}

export async function getTaskById(id: string): Promise<Task | null> {
  return (await loadIndex()).find((t) => t.id === id) ?? null;
}

// Removes the markdown file (the source of truth) and refreshes the derived index.
// Note this is a LOCAL delete only — sync never propagates deletions to Google.
export async function deleteTask(id: string): Promise<boolean> {
  const rows = await loadIndex();
  if (!rows.some((r) => r.id === id)) return false;
  await fs.unlink(path.join(await dir(), await fileForId(id))).catch(() => {});
  await saveIndex(rows.filter((r) => r.id !== id));
  return true;
}
