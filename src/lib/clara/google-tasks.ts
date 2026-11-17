// Clara ↔ Google Tasks, two-way.
//
// Clara's task model is richer than Google's: she has open/doing/done/cancelled, an assignee, and
// tags; Google has only needsAction/completed plus free-text notes. The extra state rides along in
// a marker line appended to `notes`, which is stripped on read so it never leaks into what the owner
// sees on their phone. Those fields are also declared localOnly, so Google can never clear them.
//
// Known-lossy, accepted: Google's `due` is DATE-ONLY (it silently truncates any time-of-day to
// UTC midnight). Clara keeps the real local time and only pushes when the calendar DATE differs,
// so a round-trip can't quietly reset a 3pm reminder to midnight.

import { gfetch, type GAccount } from "./google-auth";
import { listAll as listAllTasks, add as addTask, update as updateTask, isAgentTask, type Task, type TaskStatus } from "./tasks";
import { hashRecord, withRetry, runSync, type SyncAdapter, type SyncReport } from "./sync-engine";

const BASE = "https://tasks.googleapis.com/tasks/v1";
const LIST_TITLE = "Clara";

export interface GTask {
  id: string;
  title?: string;
  notes?: string;
  status?: "needsAction" | "completed";
  due?: string;
  updated?: string;
  deleted?: boolean;
  hidden?: boolean;
}

// The normalized projection both sides are compared through. Deliberately excludes every volatile
// field (updated timestamps, etags) — that exclusion is what makes hash-based change detection
// immune to echo loops.
export interface NTask {
  title: string;
  detail?: string;
  status: TaskStatus;
  dueDate?: string;          // YYYY-MM-DD — date only, matching Google's real precision
  assignee?: string;         // localOnly
  tags?: string[];           // localOnly
}

const MARKER_RX = /\n?⟦clara:[^⟧]*⟧\s*$/;

function buildMarker(t: NTask, localId: string): string {
  const bits = [`id=${localId}`];
  if (t.status === "doing" || t.status === "cancelled") bits.push(`status=${t.status}`);
  if (t.assignee) bits.push(`assignee=${t.assignee}`);
  if (t.tags?.length) bits.push(`tags=${t.tags.join(",")}`);
  return `⟦clara:${bits.join("|")}⟧`;
}

function readMarker(notes?: string): Record<string, string> {
  const m = notes?.match(/⟦clara:([^⟧]*)⟧/);
  if (!m) return {};
  return Object.fromEntries(m[1].split("|").map((p) => {
    const i = p.indexOf("=");
    return i < 0 ? [p, "true"] : [p.slice(0, i), p.slice(i + 1)];
  }));
}

function stripMarker(notes?: string): string | undefined {
  const s = (notes ?? "").replace(MARKER_RX, "").trim();
  return s || undefined;
}

function dateOnly(iso?: string): string | undefined {
  if (!iso) return undefined;
  return iso.slice(0, 10);
}

// ── REST ─────────────────────────────────────────────────────────────────
async function gjson<T>(url: string, init?: RequestInit, account: GAccount = "work"): Promise<T> {
  const r = await gfetch(url, init ?? {}, account);
  if (!r.ok) throw new Error(`Google Tasks ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}`);
  return await r.json() as T;
}

// Clara keeps her tasks in a dedicated list rather than scattering them through the owner's own lists.
export async function ensureClaraList(account: GAccount = "work"): Promise<string> {
  const j = await gjson<{ items?: { id: string; title: string }[] }>(`${BASE}/users/@me/lists?maxResults=100`, {}, account);
  const found = (j.items ?? []).find((l) => l.title === LIST_TITLE);
  if (found) return found.id;
  const made = await gjson<{ id: string }>(`${BASE}/users/@me/lists`, {
    method: "POST", body: JSON.stringify({ title: LIST_TITLE }),
  }, account);
  return made.id;
}

export async function listTasks(listId: string, account: GAccount = "work"): Promise<GTask[]> {
  const out: GTask[] = [];
  let pageToken: string | undefined;
  do {
    const url = `${BASE}/lists/${encodeURIComponent(listId)}/tasks?maxResults=100&showCompleted=true&showHidden=true`
      + (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : "");
    const j = await gjson<{ items?: GTask[]; nextPageToken?: string }>(url, {}, account);
    out.push(...(j.items ?? []).filter((t) => !t.deleted));
    pageToken = j.nextPageToken;
  } while (pageToken);
  return out;
}

export async function insertTask(listId: string, body: Partial<GTask>, account: GAccount = "work"): Promise<GTask> {
  return gjson<GTask>(`${BASE}/lists/${encodeURIComponent(listId)}/tasks`, {
    method: "POST", body: JSON.stringify(body),
  }, account);
}

export async function patchTask(listId: string, taskId: string, body: Partial<GTask>, account: GAccount = "work"): Promise<GTask> {
  return gjson<GTask>(`${BASE}/lists/${encodeURIComponent(listId)}/tasks/${encodeURIComponent(taskId)}`, {
    method: "PATCH", body: JSON.stringify(body),
  }, account);
}

// ── adapter ──────────────────────────────────────────────────────────────
function toGoogleBody(n: NTask, localId: string): Partial<GTask> {
  const detail = n.detail ? `${n.detail}\n\n` : "";
  return {
    title: n.title,
    notes: `${detail}${buildMarker(n, localId)}`,
    status: n.status === "done" || n.status === "cancelled" ? "completed" : "needsAction",
    // Google stores date-only; sending midnight UTC is the documented shape.
    due: n.dueDate ? `${n.dueDate}T00:00:00.000Z` : undefined,
  };
}

export function tasksAdapter(account: GAccount, listId: string): SyncAdapter<Task, GTask, NTask> {
  return {
    kind: "tasks",
    account,
    localOnlyFields: ["assignee", "tags"],

    // Tasks handed to FRIDAY are Clara's tracking rows, not the owner's to-dos — keep them off
    // the owner's phone. (They were never linked, so filtering them out here is a pure omission.)
    listLocal: async () => (await listAllTasks()).filter((t) => !isAgentTask(t)),
    localId: (t) => t.id,
    normalizeLocal: (t): NTask => ({
      title: t.title,
      detail: t.detail,
      status: t.status,
      dueDate: dateOnly(t.dueAt),
      assignee: t.assignee,
      tags: t.tags,
    }),

    listRemote: () => listTasks(listId, account),
    remoteId: (r) => r.id,
    normalizeRemote: (r): NTask => {
      const mk = readMarker(r.notes);
      // A "completed" Google task is `done` unless Clara's marker says she cancelled it. Only
      // trust that marker while the remote is otherwise unchanged — if the owner reopened and finished
      // the task themselves, `done` is the honest reading.
      const completed = r.status === "completed";
      const marked = mk.status as TaskStatus | undefined;
      const status: TaskStatus = completed
        ? (marked === "cancelled" ? "cancelled" : "done")
        : (marked === "doing" ? "doing" : "open");
      return {
        title: r.title ?? "(untitled)",
        detail: stripMarker(r.notes),
        status,
        dueDate: dateOnly(r.due),
        assignee: mk.assignee,
        tags: mk.tags ? mk.tags.split(",").filter(Boolean) : undefined,
      };
    },
    embeddedLocalId: (r) => readMarker(r.notes).id,

    createRemote: async (n, localId) => {
      const raw = await insertTask(listId, toGoogleBody(n, localId), account);
      return { remoteId: raw.id, raw };
    },
    updateRemote: async (remoteId, n, _etag, localId) => {
      const raw = await patchTask(listId, remoteId, toGoogleBody(n, localId), account);
      return { raw };
    },
    applyLocal: async (localId, n) => {
      const patch: Partial<Task> = {
        title: n.title,
        detail: n.detail,
        status: n.status,
        dueAt: n.dueDate ? `${n.dueDate}T00:00:00.000Z` : undefined,
        assignee: n.assignee as Task["assignee"],
        tags: n.tags,
      };
      if (localId) {
        await updateTask(localId, patch);
        return localId;
      }
      const made = await addTask({ title: n.title, ...patch });
      return made.id;
    },
    markLocalOrphaned: async (localId) => {
      // The remote copy is gone; reflect that locally rather than resurrecting it next run.
      await updateTask(localId, { status: "cancelled" });
    },

    matchCandidate: (n, pool) => {
      const norm = (s: string) => s.toLowerCase().trim().replace(/\s+/g, " ");
      const exact = pool.filter((p) => norm(p.n.title) === norm(n.title));
      if (exact.length !== 1) return null;             // ambiguous or none — don't guess
      const same = exact[0];
      const dueMatches = (same.n.dueDate ?? "") === (n.dueDate ?? "");
      return { id: same.id, confidence: dueMatches ? 0.95 : 0.75 };
    },
  };
}

export async function syncTasks(account: GAccount = "work", opts: { dryRun?: boolean } = {}): Promise<SyncReport> {
  const listId = await withRetry(() => ensureClaraList(account));
  return runSync(tasksAdapter(account, listId), opts);
}

// Re-exported so callers can hash without reaching into the engine.
export { hashRecord };
