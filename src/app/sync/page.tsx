"use client";
import { useEffect, useState, useCallback } from "react";

interface StoreStatus {
  kind: string;
  account: string;
  lastRunAt: string | null;
  linked: number;
  orphanLocal: number;
  orphanRemote: number;
  stuck: number;
  pending: number;
  pendingRows: { remoteId?: string; localId?: string; reason: string; preview: Record<string, unknown> }[];
}

interface SyncReport {
  kind: string; account: string; dryRun: boolean;
  createdRemote: number; updatedRemote: number; createdLocal: number; updatedLocal: number;
  linked: number; unchanged: number; conflicts: number; pending: number;
  orphanedLocal: number; orphanedRemote: number;
  errors: { id: string; op: string; message: string }[];
  plan: string[];
}

export default function SyncPage() {
  const [stores, setStores] = useState<StoreStatus[] | null>(null);
  const [reports, setReports] = useState<SyncReport[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await fetch("/api/sync/status");
    const j = await r.json();
    setStores(j.stores ?? []);
  }, []);
  useEffect(() => { load(); }, [load]);

  async function run(dryRun: boolean) {
    setBusy(true); setMsg(null); setReports(null);
    try {
      const r = await fetch("/api/sync/run", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "all", account: "work", dryRun }),
      });
      const j = await r.json();
      setReports(j.reports ?? []);
      if (j.errors?.length) setMsg(j.errors.map((e: { kind: string; message: string }) => `${e.kind}: ${e.message}`).join(" · "));
      else setMsg(dryRun ? "Dry run complete — nothing was written." : "Sync complete.");
      await load();
    } catch (e) {
      setMsg(`Failed: ${(e as Error).message}`);
    } finally { setBusy(false); }
  }

  async function resolve(kind: string, remoteId: string, action: "link" | "create" | "ignore", localId?: string) {
    await fetch("/api/sync/resolve", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind, account: "work", remoteId, localId, action }),
    });
    await load();
  }

  return (
    <div className="max-w-3xl space-y-6">
      <section className="action-card">
        <p className="text-sm mb-4" style={{ color: "var(--cream-dim)" }}>
          Two-way sync between Clara&apos;s vault and Google Tasks / Contacts. Deletions are never
          propagated in either direction, and ambiguous first-run matches are parked below for you
          rather than guessed at. Always dry-run first.
        </p>
        <div className="flex gap-2">
          <button onClick={() => run(true)} disabled={busy} className="copy-btn" style={{ opacity: busy ? 0.5 : 1 }}>
            {busy ? "Working…" : "Dry run"}
          </button>
          <button onClick={() => run(false)} disabled={busy} className="copy-btn" style={{ opacity: busy ? 0.5 : 1 }}>
            Sync for real
          </button>
        </div>
        {msg && <p className="mt-3 text-sm" style={{ color: "var(--cream)" }}>{msg}</p>}
      </section>

      <section className="panel p-5">
        <h2 className="text-lg font-medium mb-3">Status</h2>
        {stores === null ? <p style={{ color: "var(--cream-dim)" }}>Loading…</p> : (
          <ul className="text-sm space-y-2">
            {stores.map((s) => (
              <li key={`${s.kind}-${s.account}`}>
                <strong>{s.kind} · {s.account}</strong> — {s.linked} linked
                {s.orphanLocal > 0 && <span className="pill pill-warn ml-2">{s.orphanLocal} orphan local</span>}
                {s.orphanRemote > 0 && <span className="pill pill-warn ml-2">{s.orphanRemote} orphan remote</span>}
                {s.stuck > 0 && <span className="pill pill-err ml-2">{s.stuck} stuck</span>}
                <div style={{ color: "var(--cream-dim)" }}>
                  {s.lastRunAt ? `last run ${s.lastRunAt.replace("T", " ").slice(0, 19)}` : "never run"}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {(stores ?? []).some((s) => s.pending > 0) && (
        <section className="panel p-5">
          <h2 className="text-lg font-medium mb-1">Needs your call</h2>
          <p className="text-sm mb-3" style={{ color: "var(--cream-dim)" }}>
            Clara found a plausible but not certain match. Nothing has been touched.
          </p>
          {(stores ?? []).flatMap((s) => s.pendingRows.map((p) => (
            <div key={`${s.kind}-${p.remoteId}`} className="action-card mb-3">
              <div className="action-tag">{s.kind} · {p.reason}</div>
              <pre className="mt-2 whitespace-pre-wrap font-sans text-sm" style={{ color: "var(--cream-soft)" }}>
                {JSON.stringify(p.preview, null, 2)}
              </pre>
              <div className="flex gap-2 mt-3">
                <button onClick={() => resolve(s.kind, p.remoteId!, "create")} className="copy-btn">It&apos;s new</button>
                <button onClick={() => resolve(s.kind, p.remoteId!, "ignore")} className="copy-btn">Ignore</button>
              </div>
            </div>
          )))}
        </section>
      )}

      {reports && (
        <section className="panel p-5">
          <h2 className="text-lg font-medium mb-3">Last run</h2>
          {reports.map((r) => (
            <div key={`${r.kind}-${r.account}`} className="mb-4">
              <div className="action-tag">
                {r.kind} · {r.account} {r.dryRun && <span className="pill pill-info ml-2">dry run</span>}
              </div>
              <div className="text-sm mt-1">
                +{r.createdRemote} to Google · +{r.createdLocal} to Clara · {r.updatedRemote + r.updatedLocal} updated ·{" "}
                {r.linked} newly linked · {r.unchanged} unchanged
                {r.conflicts > 0 && <span className="pill pill-warn ml-2">{r.conflicts} conflicts</span>}
              </div>
              {r.plan.length > 0 && (
                <pre className="mt-2 whitespace-pre-wrap text-xs" style={{ color: "var(--cream-dim)" }}>
                  {r.plan.slice(0, 40).join("\n")}{r.plan.length > 40 ? `\n… ${r.plan.length - 40} more` : ""}
                </pre>
              )}
              {r.errors.length > 0 && (
                <pre className="mt-2 whitespace-pre-wrap text-xs" style={{ color: "var(--plum)" }}>
                  {r.errors.map((e) => `${e.op} ${e.id}: ${e.message}`).join("\n")}
                </pre>
              )}
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
