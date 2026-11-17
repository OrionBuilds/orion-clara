"use client";
import { useState } from "react";

export default function LegalPage() {
  const [tab, setTab] = useState<"contract" | "tax">("contract");

  return (
    <div className="max-w-3xl">
      <div className="flex gap-2 mb-6">
        <TabButton active={tab === "contract"} onClick={() => setTab("contract")}>Contract review</TabButton>
        <TabButton active={tab === "tax"} onClick={() => setTab("tax")}>Tax notes</TabButton>
      </div>
      {tab === "contract" ? <ContractTab /> : <TaxTab />}
    </div>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className="rounded px-3 py-1.5 text-sm"
      style={{ background: active ? "var(--gold)" : "var(--bg-elev)", color: active ? "var(--bg-deep)" : "var(--cream-dim)" }}
    >
      {children}
    </button>
  );
}

function ContractTab() {
  const [text, setText] = useState("");
  const [context, setContext] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ analysis: string; riskLevel: string; savedPath: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true); setError(null); setResult(null);
    try {
      let r: Response;
      if (file) {
        const form = new FormData();
        form.append("file", file);
        form.append("context", context);
        r = await fetch("/api/legal/review-scan", { method: "POST", body: form });
      } else {
        r = await fetch("/api/legal/review", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text, context }),
        });
      }
      const j = await r.json();
      if (r.ok) setResult(j); else setError(j.error);
    } finally { setBusy(false); }
  }

  return (
    <div className="action-card">
      <label className="block mb-3">
        <div className="text-sm mb-1" style={{ color: "var(--cream-dim)" }}>Context (optional)</div>
        <input value={context} onChange={(e) => setContext(e.target.value)} placeholder="e.g. apartment lease, freelance service agreement"
               className="w-full rounded border px-3 py-2" style={{ borderColor: "var(--line-soft)", background: "var(--bg-elev)", color: "var(--cream)" }} />
      </label>
      <label className="block mb-3">
        <div className="text-sm mb-1" style={{ color: "var(--cream-dim)" }}>Paste the contract text</div>
        <textarea value={text} onChange={(e) => { setText(e.target.value); setFile(null); }} disabled={!!file}
                  style={{ minHeight: 200, borderColor: "var(--line-soft)", background: "var(--bg-elev)", color: "var(--cream)", opacity: file ? 0.5 : 1 }}
                  className="w-full rounded border px-3 py-2 outline-none" />
      </label>
      <label className="block mb-3">
        <div className="text-sm mb-1" style={{ color: "var(--cream-dim)" }}>…or upload a scanned/photographed PDF instead (OCR'd locally)</div>
        <input type="file" accept="application/pdf" onChange={(e) => { setFile(e.target.files?.[0] ?? null); if (e.target.files?.[0]) setText(""); }}
               className="text-sm" style={{ color: "var(--cream-dim)" }} />
      </label>
      <button onClick={submit} disabled={busy || (!text.trim() && !file)} className="copy-btn" style={{ opacity: busy || (!text.trim() && !file) ? 0.5 : 1 }}>
        {busy ? "Reviewing…" : "Review contract"}
      </button>
      {error && <p className="mt-3 text-sm" style={{ color: "var(--plum)" }}>{error}</p>}
      {result && (
        <div className="mt-4 panel p-4">
          <span className={`pill ${result.riskLevel === "high" ? "pill-err" : result.riskLevel === "medium" ? "pill-warn" : "pill-ok"}`}>
            risk: {result.riskLevel}
          </span>
          <pre className="mt-3 whitespace-pre-wrap font-sans text-sm" style={{ color: "var(--cream-soft)" }}>{result.analysis}</pre>
          <p className="mt-2 text-xs" style={{ color: "var(--cream-mute)" }}>Saved to vault/{result.savedPath}</p>
        </div>
      )}
    </div>
  );
}

function TaxTab() {
  const [months, setMonths] = useState(3);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ notes: string; savedPath: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true); setError(null); setResult(null);
    try {
      const r = await fetch("/api/legal/tax-notes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ periodMonths: months }),
      });
      const j = await r.json();
      if (r.ok) setResult(j); else setError(j.error);
    } finally { setBusy(false); }
  }

  return (
    <div className="action-card">
      <label className="block mb-3">
        <div className="text-sm mb-1" style={{ color: "var(--cream-dim)" }}>Look back how many months?</div>
        <select value={months} onChange={(e) => setMonths(Number(e.target.value))}
                className="rounded border px-3 py-2" style={{ borderColor: "var(--line-soft)", background: "var(--bg-elev)", color: "var(--cream)" }}>
          {[1, 3, 6, 12].map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
      </label>
      <button onClick={submit} disabled={busy} className="copy-btn" style={{ opacity: busy ? 0.5 : 1 }}>
        {busy ? "Analyzing…" : "Get tax notes"}
      </button>
      {error && <p className="mt-3 text-sm" style={{ color: "var(--plum)" }}>{error}</p>}
      {result && (
        <div className="mt-4 panel p-4">
          <pre className="whitespace-pre-wrap font-sans text-sm" style={{ color: "var(--cream-soft)" }}>{result.notes}</pre>
          <p className="mt-2 text-xs" style={{ color: "var(--cream-mute)" }}>Saved to vault/{result.savedPath}</p>
        </div>
      )}
    </div>
  );
}
