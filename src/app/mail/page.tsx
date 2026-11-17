"use client";
import { useEffect, useState } from "react";

interface Msg { id: string; from: string; subject: string; snippet: string; date: string; labelIds: string[]; unread: boolean }
interface TriageResult { msg: Msg; verdict: string; action: string; reason: string }

export default function MailPage() {
  const [inbox, setInbox] = useState<Msg[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [triaging, setTriaging] = useState(false);
  const [results, setResults] = useState<TriageResult[] | null>(null);

  async function loadInbox() {
    setError(null);
    const r = await fetch("/api/mail/inbox");
    const j = await r.json();
    if (r.ok) setInbox(j);
    else { setError(j.error ?? "failed"); setInbox([]); }
  }
  useEffect(() => { loadInbox(); }, []);

  async function triage() {
    setTriaging(true);
    try {
      const r = await fetch("/api/mail/triage", { method: "POST" });
      const j = await r.json();
      if (r.ok) { setResults(j.results); await loadInbox(); }
      else setError(j.error ?? "failed");
    } finally { setTriaging(false); }
  }

  return (
    <div className="max-w-4xl">
      <div className="flex items-center justify-between mb-4">
        <span className="pill pill-info">work inbox</span>
        <button
          onClick={triage}
          disabled={triaging || !inbox?.length}
          className="copy-btn"
          style={{ opacity: triaging || !inbox?.length ? 0.5 : 1 }}
        >
          {triaging ? "Triaging…" : `Triage ${inbox?.length ?? 0} unread`}
        </button>
      </div>

      {error && (
        <div className="action-card mb-4" style={{ borderColor: "rgba(245,158,11,0.35)" }}>
          {error} — visit <a href="/settings/connect" style={{ color: "var(--gold)" }}>Settings → Connect</a> to link your work Google account.
        </div>
      )}

      {results && (
        <div className="panel p-4 mb-4">
          <h2 className="font-medium mb-2">Triage complete — {results.length} processed</h2>
          <ul className="text-sm space-y-1">
            {tally(results).map(([verdict, count]) => (
              <li key={verdict}>
                <span className="pill pill-info">{verdict}</span> <span style={{ color: "var(--cream-dim)" }}>{count}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {inbox === null ? <p style={{ color: "var(--cream-dim)" }}>Loading…</p> : (
        <ul className="action-card divide-y p-0" style={{ borderColor: "var(--line-soft)" }}>
          {inbox.map((m) => (
            <li key={m.id} className="py-3 px-5">
              <div className="flex items-baseline justify-between">
                <div className="font-medium truncate">{m.subject}</div>
                <div className="text-xs shrink-0 ml-4" style={{ color: "var(--cream-mute)" }}>{shortDate(m.date)}</div>
              </div>
              <div className="text-sm" style={{ color: "var(--cream-dim)" }}>{m.from}</div>
              <div className="text-sm mt-1 truncate" style={{ color: "var(--cream-dim)" }}>{m.snippet}</div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function tally(results: TriageResult[]): [string, number][] {
  const map = new Map<string, number>();
  for (const r of results) map.set(r.verdict, (map.get(r.verdict) ?? 0) + 1);
  return [...map.entries()];
}
function shortDate(s: string): string {
  const d = new Date(s);
  if (isNaN(d.getTime())) return s;
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
