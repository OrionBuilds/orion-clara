"use client";
import { useEffect, useState } from "react";
import { FileText } from "lucide-react";

interface Doc { name: string; sizeKb: number; modifiedAt: string }

export default function DocumentsPage() {
  const [docs, setDocs] = useState<Doc[] | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [merging, setMerging] = useState(false);
  const [mergeError, setMergeError] = useState<string | null>(null);

  function refresh() {
    fetch("/api/documents").then((r) => r.json()).then(setDocs);
  }
  useEffect(refresh, []);

  function toggle(name: string) {
    setSelected((s) => (s.includes(name) ? s.filter((n) => n !== name) : [...s, name]));
  }

  async function mergeSelected() {
    if (selected.length < 2) return;
    setMerging(true); setMergeError(null);
    try {
      const outFilename = `merged-${selected.length}-documents`;
      const r = await fetch("/api/documents/merge", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ files: selected, outFilename }),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) { setMergeError(j.error ?? "merge failed"); return; }
      setSelected([]);
      refresh();
    } finally { setMerging(false); }
  }

  return (
    <div className="max-w-3xl">
      <p className="text-sm mb-4" style={{ color: "var(--cream-dim)" }}>
        Travel itineraries, vendor confirmations, and contract reviews Clara has generated as real PDF files.
        Select two or more to merge them (via a local Stirling-PDF service) into one.
      </p>
      {selected.length >= 2 && (
        <div className="mb-3 flex items-center gap-3">
          <button onClick={mergeSelected} disabled={merging} className="copy-btn" style={{ opacity: merging ? 0.5 : 1 }}>
            {merging ? "Merging…" : `Merge ${selected.length} selected`}
          </button>
          {mergeError && <span className="text-sm" style={{ color: "var(--plum)" }}>{mergeError}</span>}
        </div>
      )}
      {docs === null ? <p style={{ color: "var(--cream-dim)" }}>Loading…</p>
       : docs.length === 0 ? <p style={{ color: "var(--cream-mute)" }}>Nothing generated yet.</p>
       : (
        <ul className="action-card divide-y p-0" style={{ borderColor: "var(--line-soft)" }}>
          {docs.map((d) => (
            <li key={d.name} className="py-3 px-5 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <input type="checkbox" checked={selected.includes(d.name)} onChange={() => toggle(d.name)} />
                <FileText size={18} style={{ color: "var(--gold)" }} />
                <div>
                  <div className="font-medium">{d.name}</div>
                  <div className="text-xs" style={{ color: "var(--cream-mute)" }}>{d.sizeKb} KB · {d.modifiedAt.slice(0, 19).replace("T", " ")}</div>
                </div>
              </div>
              <a href={`/api/documents/${encodeURIComponent(d.name)}`} target="_blank" rel="noreferrer" className="text-xs" style={{ color: "var(--gold)" }}>
                Open →
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
