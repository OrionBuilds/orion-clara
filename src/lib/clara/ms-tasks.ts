// Clara ↔ Microsoft To Do, two-way.
//
// Replaces google-tasks.ts. Same marker-in-notes trick, same adapter shape, new wire format:
//
//  - STATUS: Microsoft To Do's `status` is a 5-value enum (notStarted/inProgress/completed/
//    waitingOnOthers/deferred), not Google's binary needsAction/completed. Clara's own model is
//    already richer than either (open/doing/done/cancelled) and already resolves that richness
//    through the `⟦clara:...⟧` marker, not through the remote status field — so on write we only
//    ever emit two of Graph's five values: "completed" for done/cancelled, "notStarted" for
//    everything else (open AND doing). inProgress/waitingOnOthers/deferred are never written by
//    Clara; if a human sets one of those directly in the To Do app, it's read back exactly like
//    "notStarted" (not completed → fall through to the marker's open/doing distinction), so no
//    information is lost, it just doesn't get a dedicated bucket.
//
//  - DUE DATE PRECISION: Graph's `dueDateTime` is a `{ dateTime, timeZone }` pair, which LOOKS
//    like it carries real time-of-day (unlike Google's bare `due` string, which is contractually
//    date-only). In practice it is not: Microsoft's own To Do clients always write the wall-clock
//    time as midnight in the given zone, and the To Do UI has no control to set a due TIME at
//    all — only a due DATE (time-of-day reminders go through the separate `reminderDateTime`
//    field, which this adapter doesn't touch). So the *effective* precision is identical to
//    Google's: date-only. We preserve that by always writing `T00:00:00.0000000` in UTC and, on
//    read, taking just the date portion of `dueDateTime.dateTime` and ignoring `timeZone` — safe
//    because we always write UTC ourselves, and a human-entered due date from the To Do app is
//    also midnight-in-some-zone, so its calendar date is correct regardless of which zone Graph
//    reports.
//
//  - NO DELETED FLAG: Google's Tasks API returns soft-deleted items in-list with `deleted: true`
//    (hence the old `.filter((t) => !t.deleted)`). Graph's `todoTask` resource has no equivalent
//    property — a removed task is simply absent from `GET /tasks`; deletions only surface via
//    delta-query's `@removed` annotation, which this adapter doesn't use. So that filter has no
//    Graph equivalent and is simply gone below, not faked with an always-false field.
//
// Clara's extra state (status nuance, assignee, tags) still rides a marker line appended to the
// task body, exactly as it rode in `notes` under Google — just at `body.content` instead of
// `notes`, since Graph's task body is the same kind of free-text field. The marker is stripped on
// read so it never leaks into what the owner sees on their phone. Those fields are still declared
// localOnly, so Microsoft can never clear them.

import { mfetch, type MAccount } from "./ms-auth";
import { listAll as listAllTasks, add as addTask, update as updateTask, isAgentTask, type Task, type TaskStatus } from "./tasks";
import { hashRecord, withRetry, runSync, type SyncAdapter, type SyncReport } from "./sync-engine";

const BASE = "https://graph.microsoft.com/v1.0/me/todo";
const LIST_TITLE = "Clara";

export type GraphTaskStatus = "notStarted" | "inProgress" | "completed" | "waitingOnOthers" | "deferred";

export interface GTask {
  id: string;
  title?: string;
  body?: { content?: string; contentType?: "text" | "html" };
  status?: GraphTaskStatus;
  dueDateTime?: { dateTime?: string; timeZone?: string };
  lastModifiedDateTime?: string;
}

// The normalized projection both sides are compared through. Deliberately excludes every volatile
// field (lastModifiedDateTime, etc.) — that exclusion is what makes hash-based change detection
// immune to echo loops. IDENTICAL shape to google-tasks.ts's NTask; only the remote-side mapping
// changes.
export interface NTask {
  title: string;
  detail?: string;
  status: TaskStatus;
  dueDate?: string;          // YYYY-MM-DD — date only, matching Graph's effective precision
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

function readMarker(content?: string): Record<string, string> {
  const m = content?.match(/⟦clara:([^⟧]*)⟧/);
  if (!m) return {};
  return Object.fromEntries(m[1].split("|").map((p) => {
    const i = p.indexOf("=");
    return i < 0 ? [p, "true"] : [p.slice(0, i), p.slice(i + 1)];
  }));
}

function stripMarker(content?: string): string | undefined {
  const s = (content ?? "").replace(MARKER_RX, "").trim();
  return s || undefined;
}

function dateOnly(iso?: string): string | undefined {
  if (!iso) return undefined;
  return iso.slice(0, 10);
}

// ── REST ─────────────────────────────────────────────────────────────────
async function mjson<T>(url: string, init?: RequestInit, account: MAccount = "work"): Promise<T> {
  const r = await mfetch(url, init ?? {}, account);
  if (!r.ok) throw new Error(`Microsoft To Do ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}`);
  return await r.json() as T;
}

interface GListsPage { value?: { id: string; displayName?: string }[]; "@odata.nextLink"?: string }
interface GTasksPage { value?: GTask[]; "@odata.nextLink"?: string }

// Clara keeps her tasks in a dedicated list rather than scattering them through the owner's own lists.
export async function ensureClaraList(account: MAccount = "work"): Promise<string> {
  let url: string | undefined = `${BASE}/lists?$top=100`;
  let found: { id: string; displayName?: string } | undefined;
  while (url && !found) {
    // Explicitly typed (not just inferred from the call-site generic) — a bare `const j = await
    // mjson<...>(url)` here trips a TS inference quirk where `j`'s type becomes circular with the
    // `url`/`found` reassignment later in this same loop body.
    const j: GListsPage = await mjson<GListsPage>(url, {}, account);
    found = (j.value ?? []).find((l) => l.displayName === LIST_TITLE);
    url = found ? undefined : j["@odata.nextLink"];
  }
  if (found) return found.id;
  const made = await mjson<{ id: string }>(`${BASE}/lists`, {
    method: "POST", body: JSON.stringify({ displayName: LIST_TITLE }),
  }, account);
  return made.id;
}

export async function listTasks(listId: string, account: MAccount = "work"): Promise<GTask[]> {
  const out: GTask[] = [];
  // Graph pages via a full next-link URL, not a reconstructable token like Google's pageToken —
  // just follow whatever `@odata.nextLink` gives us.
  let url: string | undefined = `${BASE}/lists/${encodeURIComponent(listId)}/tasks?$top=100`;
  while (url) {
    const j: GTasksPage = await mjson<GTasksPage>(url, {}, account);
    out.push(...(j.value ?? []));
    url = j["@odata.nextLink"];
  }
  // No `.filter((t) => !t.deleted)` here — see header comment: Graph has no such flag, a deleted
  // task is simply absent already.
  return out;
}

export async function insertTask(listId: string, body: Partial<GTask>, account: MAccount = "work"): Promise<GTask> {
  return mjson<GTask>(`${BASE}/lists/${encodeURIComponent(listId)}/tasks`, {
    method: "POST", body: JSON.stringify(body),
  }, account);
}

export async function patchTask(listId: string, taskId: string, body: Partial<GTask>, account: MAccount = "work"): Promise<GTask> {
  return mjson<GTask>(`${BASE}/lists/${encodeURIComponent(listId)}/tasks/${encodeURIComponent(taskId)}`, {
    method: "PATCH", body: JSON.stringify(body),
  }, account);
}

// ── adapter ──────────────────────────────────────────────────────────────
function toGraphBody(n: NTask, localId: string): Partial<GTask> {
  const detail = n.detail ? `${n.detail}\n\n` : "";
  return {
    title: n.title,
    body: { content: `${detail}${buildMarker(n, localId)}`, contentType: "text" },
    // Only ever emit the two values Clara actually distinguishes remotely — see header comment
    // on Graph's richer 5-value enum. inProgress/waitingOnOthers/deferred are never written here.
    status: n.status === "done" || n.status === "cancelled" ? "completed" : "notStarted",
    // Graph's schema allows real time-of-day, but the effective convention is date-only — see
    // header comment. Midnight UTC is the shape that round-trips cleanly.
    dueDateTime: n.dueDate ? { dateTime: `${n.dueDate}T00:00:00.0000000`, timeZone: "UTC" } : undefined,
  };
}

export function tasksAdapter(account: MAccount, listId: string): SyncAdapter<Task, GTask, NTask> {
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
      const mk = readMarker(r.body?.content);
      // A "completed" To Do task is `done` unless Clara's marker says she cancelled it. Only
      // trust that marker while the remote is otherwise unchanged — if the owner reopened and finished
      // the task themselves, `done` is the honest reading. Any non-completed Graph status
      // (notStarted/inProgress/waitingOnOthers/deferred) falls into the same "not completed"
      // bucket Google's needsAction did.
      const completed = r.status === "completed";
      const marked = mk.status as TaskStatus | undefined;
      const status: TaskStatus = completed
        ? (marked === "cancelled" ? "cancelled" : "done")
        : (marked === "doing" ? "doing" : "open");
      return {
        title: r.title ?? "(untitled)",
        detail: stripMarker(r.body?.content),
        status,
        dueDate: dateOnly(r.dueDateTime?.dateTime),
        assignee: mk.assignee,
        tags: mk.tags ? mk.tags.split(",").filter(Boolean) : undefined,
      };
    },
    embeddedLocalId: (r) => readMarker(r.body?.content).id,

    createRemote: async (n, localId) => {
      const raw = await insertTask(listId, toGraphBody(n, localId), account);
      return { remoteId: raw.id, raw };
    },
    updateRemote: async (remoteId, n, _etag, localId) => {
      const raw = await patchTask(listId, remoteId, toGraphBody(n, localId), account);
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

export async function syncTasks(account: MAccount = "work", opts: { dryRun?: boolean } = {}): Promise<SyncReport> {
  const listId = await withRetry(() => ensureClaraList(account));
  return runSync(tasksAdapter(account, listId), opts);
}

// Re-exported so callers can hash without reaching into the engine.
export { hashRecord };
