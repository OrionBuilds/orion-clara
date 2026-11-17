"use client";
import { useState } from "react";

export default function TravelPage() {
  const [f, setF] = useState({ destination: "", origin: "", depart: "", nights: 2, purpose: "", preferences: "" });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function submit() {
    setBusy(true); setMsg(null);
    try {
      const r = await fetch("/api/travel/plan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...f, requestor: "owner" }),
      });
      const j = await r.json();
      if (r.ok) setMsg(`Researching options for ${f.destination} — check your email for the full write-up shortly.`);
      else setMsg(`Failed: ${j.error}`);
    } finally { setBusy(false); }
  }

  return (
    <div className="action-card max-w-2xl">
      <div className="space-y-3">
        {[
          { k: "destination", label: "Where to?", ph: "Austin, TX", type: "text" },
          { k: "origin",      label: "From", ph: "DTW (optional)", type: "text" },
          { k: "depart",      label: "Depart", ph: "next Tuesday", type: "text" },
          { k: "nights",      label: "Nights", ph: "2", type: "number" },
          { k: "purpose",     label: "Purpose", ph: "board meeting (optional)", type: "text" },
          { k: "preferences", label: "Preferences", ph: "aisle seat, no red-eyes, Marriott if possible", type: "text" },
        ].map((row) => (
          <label key={row.k} className="block">
            <div className="text-sm mb-1" style={{ color: "var(--cream-dim)" }}>{row.label}</div>
            <input
              type={row.type}
              placeholder={row.ph}
              value={(f as Record<string, string | number>)[row.k] as string | number}
              onChange={(e) => setF({ ...f, [row.k]: row.type === "number" ? Number(e.target.value) : e.target.value })}
              className="w-full rounded border px-3 py-2"
              style={{ borderColor: "var(--line-soft)", background: "var(--bg-elev)", color: "var(--cream)" }}
            />
          </label>
        ))}
      </div>

      <button
        onClick={submit}
        disabled={busy || !f.destination || !f.depart || !f.nights}
        className="copy-btn mt-6"
        style={{ opacity: busy || !f.destination ? 0.5 : 1 }}
      >
        {busy ? "Building itinerary…" : "Ask Clara to plan"}
      </button>

      {msg && <p className="mt-4 text-sm" style={{ color: "var(--cream)" }}>{msg}</p>}
    </div>
  );
}
