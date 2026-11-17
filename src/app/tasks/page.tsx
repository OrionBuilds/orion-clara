"use client";
// Tasks — UI over the vault-backed task store (lib/clara/tasks.ts). The store, API routes, and
// Google Tasks two-way sync all predate this page; until now the only surfaces were the home
// "Open tasks" tile (which linked to /brief) and the /sync resolver. Edits here land in
// vault/tasks/*.md and propagate to Google Tasks on the next 15-minute sync job.

import { useEffect, useState } from "react";

interface Task {
  id: string;
  title: string;
  detail?: string;
  status: "open" | "doing" | "done" | "cancelled";
  dueAt?: string;
  assignee?: "owner" | "clara";
  createdAt: string;
  updatedAt: string;
  tags?: string[];
}

const ASSIGNEES = ["clara", "owner"] as const;

function dueInfo(t: Task): { label: string; overdue: boolean } | null {
  if (!t.dueAt) return null;
  const due = new Date(t.dueAt);
  if (isNaN(due.getTime())) return null;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const dueDay = new Date(due); dueDay.setHours(0, 0, 0, 0);
  const days = Math.round((dueDay.getTime() - today.getTime()) / 86_400_000);
  const overdue = days < 0 && t.status !== "done" && t.status !== "cancelled";
  const label = days === 0 ? "today" : days === 1 ? "tomorrow" : days === -1 ? "yesterday"
    : days < 0 ? `${-days}d overdue` : due.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return { label, overdue };
}

export default function TasksPage() {
  const [rows, setRows] = useState<Task[] | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const [title, setTitle] = useState("");
  const [due, setDue] = useState("");
  const [assignee, setAssignee] = useState<(typeof ASSIGNEES)[number]>("clara");

  async function load() {
    const r = await fetch("/api/tasks");
    setRows(await r.json());
  }
  useEffect(() => { load(); }, []);

  async function create() {
    if (!title.trim()) return;
    setBusy(true);
    try {
      await fetch("/api/tasks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: title.trim(), assignee, dueAt: due ? new Date(due + "T12:00:00").toISOString() : undefined }),
      });
      setTitle(""); setDue("");
      await load();
    } finally { setBusy(false); }
  }

  async function setStatus(t: Task, status: Task["status"]) {
    await fetch(`/api/tasks/${t.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status }) });
    await load();
  }

  async function remove(t: Task) {
    if (!confirm(`Delete "${t.title}"? (Local only — never deletes from Google Tasks.)`)) return;
    await fetch(`/api/tasks/${t.id}`, { method: "DELETE" });
    await load();
  }

  const visible = (rows ?? [])
    .filter((t) => showAll || t.status === "open" || t.status === "doing")
    .sort((a, b) => {
      const ad = a.dueAt ?? "9999", bd = b.dueAt ?? "9999";
      return ad.localeCompare(bd) || a.createdAt.localeCompare(b.createdAt);
    });
  const openCount = (rows ?? []).filter((t) => t.status === "open" || t.status === "doing").length;

  return (
    <div className="max-w-3xl space-y-6">
      <div className="flex items-center justify-between">
        <p className="text-sm" style={{ color: "var(--cream-dim)" }}>
          {rows === null ? "…" : `${openCount} open`} · vault-backed, two-way synced with Google Tasks.
        </p>
        <div className="flex gap-2 text-xs">
          <button onClick={() => setShowAll(false)} className="pill" style={!showAll ? { borderColor: "var(--gold)", color: "var(--gold)" } : undefined}>open</button>
          <button onClick={() => setShowAll(true)} className="pill" style={showAll ? { borderColor: "var(--gold)", color: "var(--gold)" } : undefined}>all</button>
        </div>
      </div>

      <section className="action-card">
        <div className="flex flex-wrap items-center gap-2">
          <input
            placeholder="New task…"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") create(); }}
            className="flex-1 min-w-48 rounded border px-3 py-2"
            style={{ borderColor: "var(--line-soft)", background: "var(--bg-elev)", color: "var(--cream)" }}
          />
          <input type="date" value={due} onChange={(e) => setDue(e.target.value)}
                 className="rounded border px-2 py-2 text-sm"
                 style={{ borderColor: "var(--line-soft)", background: "var(--bg-elev)", color: "var(--cream)" }} />
          <select value={assignee} onChange={(e) => setAssignee(e.target.value as typeof assignee)}
                  className="rounded border px-2 py-2 text-sm"
                  style={{ borderColor: "var(--line-soft)", background: "var(--bg-elev)", color: "var(--cream)" }}>
            {ASSIGNEES.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
          <button onClick={create} disabled={busy || !title.trim()} className="copy-btn" style={{ opacity: busy || !title.trim() ? 0.5 : 1 }}>
            {busy ? "Adding…" : "Add"}
          </button>
        </div>
      </section>

      {rows === null ? (
        <p style={{ color: "var(--cream-dim)" }}>Loading…</p>
      ) : visible.length === 0 ? (
        <p style={{ color: "var(--cream-mute)" }}>{showAll ? "No tasks yet." : "No open tasks. Nicely done."}</p>
      ) : (
        <ul className="action-card divide-y p-0" style={{ borderColor: "var(--line-soft)" }}>
          {visible.map((t) => {
            const d = dueInfo(t);
            const closed = t.status === "done" || t.status === "cancelled";
            return (
              <li key={t.id} className="py-3 px-5 flex items-center gap-3">
                <input
                  type="checkbox"
                  checked={t.status === "done"}
                  onChange={(e) => setStatus(t, e.target.checked ? "done" : "open")}
                  className="cursor-pointer"
                />
                <div className="flex-1 min-w-0">
                  <div className="font-medium truncate" style={closed ? { color: "var(--cream-mute)", textDecoration: "line-through" } : undefined}>
                    {t.title}
                  </div>
                  {t.detail && <div className="text-sm truncate" style={{ color: "var(--cream-dim)" }}>{t.detail}</div>}
                </div>
                <div className="flex items-center gap-2 text-xs shrink-0">
                  {t.status === "doing" && <span className="pill pill-info">doing</span>}
                  {t.status === "cancelled" && <span className="pill">cancelled</span>}
                  {d && (
                    <span className="pill" style={d.overdue ? { borderColor: "var(--rust)", color: "var(--rust)" } : undefined}>
                      {d.label}
                    </span>
                  )}
                  <span className="pill">{t.assignee ?? "clara"}</span>
                  {!closed && t.status !== "doing" && (
                    <button onClick={() => setStatus(t, "doing")} title="Mark in progress" style={{ color: "var(--cream-dim)" }}>▸</button>
                  )}
                  <button onClick={() => remove(t)} title="Delete" style={{ color: "var(--plum)" }}>×</button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
