"use client";
import { useState, useEffect, useCallback } from "react";
import { ChevronDown, ChevronRight, RefreshCw, Loader2 } from "lucide-react";
import MarkdownView from "@/components/MarkdownView";

interface Transcript {
  callSid: string; dateDir: string; relPath: string; audioRelPath: string;
  pending: boolean; from?: string; to?: string; durationSec?: string;
}

function TranscriptsSection() {
  const [rows, setRows] = useState<Transcript[] | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [bodies, setBodies] = useState<Record<string, string>>({});
  const [transcribing, setTranscribing] = useState(false);

  const load = useCallback(async () => {
    const j = await fetch("/api/calls/transcripts").then((r) => r.json()).catch(() => ({ transcripts: [] }));
    setRows(j.transcripts ?? []);
  }, []);
  useEffect(() => { load(); }, [load]);

  async function toggle(t: Transcript) {
    if (expanded === t.callSid) { setExpanded(null); return; }
    setExpanded(t.callSid);
    if (!bodies[t.callSid]) {
      const j = await fetch(`/api/vault/file?path=${encodeURIComponent(t.relPath)}`).then((r) => r.json()).catch(() => null);
      if (j?.content) setBodies((b) => ({ ...b, [t.callSid]: j.content }));
    }
  }

  async function transcribeNow() {
    setTranscribing(true);
    try {
      await fetch("/api/calls/transcripts", { method: "POST" });
      await load();
      setBodies({}); // stale cached bodies for anything that just got filled in
    } finally { setTranscribing(false); }
  }

  const grouped = (rows ?? []).reduce<Record<string, Transcript[]>>((acc, t) => {
    (acc[t.dateDir] ??= []).push(t);
    return acc;
  }, {});
  const pendingCount = (rows ?? []).filter((t) => t.pending).length;

  return (
    <div className="action-card max-w-2xl mt-6">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-lg font-medium">Transcripts</h2>
        {pendingCount > 0 && (
          <button onClick={transcribeNow} disabled={transcribing} className="flex items-center gap-1.5 text-[12px] pill pill-warn">
            {transcribing ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
            {transcribing ? "Transcribing…" : `Transcribe now (${pendingCount} pending)`}
          </button>
        )}
      </div>
      {rows === null ? (
        <p className="text-sm" style={{ color: "var(--cream-mute)" }}>Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-sm" style={{ color: "var(--cream-mute)" }}>No recorded calls yet.</p>
      ) : (
        Object.entries(grouped).map(([date, items]) => (
          <div key={date} className="mb-3">
            <div className="text-[11px] uppercase tracking-[0.15em] mb-1.5" style={{ color: "var(--cream-mute)" }}>{date}</div>
            <ul className="space-y-1">
              {items.map((t) => (
                <li key={t.callSid}>
                  <button onClick={() => toggle(t)} className="w-full flex items-center gap-2 py-1.5 px-2 rounded-lg text-left text-[13px] hover:bg-[rgba(255,255,255,0.04)]">
                    {expanded === t.callSid ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                    <span style={{ color: "var(--cream)" }}>{t.from ?? "?"} → {t.to ?? "?"}</span>
                    {t.durationSec && <span style={{ color: "var(--cream-mute)" }}>· {t.durationSec}s</span>}
                    {t.pending && <span className="pill pill-warn ml-auto">pending</span>}
                  </button>
                  {expanded === t.callSid && (
                    <div className="ml-6 mt-1 mb-2 p-3 rounded-lg" style={{ background: "rgba(255,255,255,0.02)", border: "1px solid var(--line-soft)" }}>
                      <audio controls src={`/api/vault/file?path=${encodeURIComponent(t.audioRelPath)}&raw=1`} className="w-full mb-3" style={{ height: 32 }} />
                      {bodies[t.callSid] ? <MarkdownView raw={bodies[t.callSid]} /> : <p className="text-[12px]" style={{ color: "var(--cream-mute)" }}>Loading transcript…</p>}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))
      )}
    </div>
  );
}

export default function CallsPage() {
  const [f, setF] = useState({
    businessName: "", category: "", businessPhone: "", locationHint: "",
    goal: "", mustConfirm: "", context: "",
  });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function submit() {
    setBusy(true); setMsg(null);
    try {
      const r = await fetch("/api/calls/business", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          businessName: f.businessName || undefined,
          category: f.category || undefined,
          businessPhone: f.businessPhone || undefined,
          locationHint: f.locationHint || undefined,
          goal: f.goal,
          mustConfirm: f.mustConfirm.split("\n").map((s) => s.trim()).filter(Boolean),
          context: f.context || undefined,
          requestor: "owner",
        }),
      });
      const j = await r.json();
      if (r.ok) setMsg(`Drafted — check your phone to approve or reject the call (id: ${j.approvalId.slice(0, 8)}).`);
      else setMsg(`Failed: ${j.error}`);
    } finally { setBusy(false); }
  }

  return (
    <>
    <div className="action-card max-w-2xl">
      <p className="text-sm mb-4" style={{ color: "var(--cream-dim)" }}>
        Ask Clara to call a business — inquire about hours/pricing, or try to book an appointment.
        Name the business if you know it, or give a category + area and she&apos;ll look one up.
        She never pays for anything; every call needs your OK first.
      </p>
      <div className="space-y-3">
        {[
          { k: "businessName", label: "Business (optional)", ph: "Joe's Plumbing" },
          { k: "category",     label: "Category (if no name)", ph: "plumber" },
          { k: "businessPhone", label: "Phone (if you already know it)", ph: "+18135551234" },
          { k: "locationHint", label: "Area", ph: "City, ST" },
        ].map((row) => (
          <label key={row.k} className="block">
            <div className="text-sm mb-1" style={{ color: "var(--cream-dim)" }}>{row.label}</div>
            <input
              type="text"
              placeholder={row.ph}
              value={(f as Record<string, string>)[row.k]}
              onChange={(e) => setF({ ...f, [row.k]: e.target.value })}
              className="w-full rounded border px-3 py-2"
              style={{ borderColor: "var(--line-soft)", background: "var(--bg-elev)", color: "var(--cream)" }}
            />
          </label>
        ))}
        <label className="block">
          <div className="text-sm mb-1" style={{ color: "var(--cream-dim)" }}>What should she ask/try to do?</div>
          <textarea
            rows={2}
            placeholder="Ask if they can send someone out this week for a leaking kitchen sink"
            value={f.goal}
            onChange={(e) => setF({ ...f, goal: e.target.value })}
            className="w-full rounded border px-3 py-2"
            style={{ borderColor: "var(--line-soft)", background: "var(--bg-elev)", color: "var(--cream)" }}
          />
        </label>
        <label className="block">
          <div className="text-sm mb-1" style={{ color: "var(--cream-dim)" }}>What she needs to confirm (one per line)</div>
          <textarea
            rows={3}
            placeholder={"Earliest availability this week\nRough cost estimate for a diagnostic visit"}
            value={f.mustConfirm}
            onChange={(e) => setF({ ...f, mustConfirm: e.target.value })}
            className="w-full rounded border px-3 py-2"
            style={{ borderColor: "var(--line-soft)", background: "var(--bg-elev)", color: "var(--cream)" }}
          />
        </label>
        <label className="block">
          <div className="text-sm mb-1" style={{ color: "var(--cream-dim)" }}>Extra context (optional)</div>
          <textarea
            rows={2}
            placeholder="Address, symptom, prior history with this vendor, etc."
            value={f.context}
            onChange={(e) => setF({ ...f, context: e.target.value })}
            className="w-full rounded border px-3 py-2"
            style={{ borderColor: "var(--line-soft)", background: "var(--bg-elev)", color: "var(--cream)" }}
          />
        </label>
      </div>

      <button
        onClick={submit}
        disabled={busy || !f.goal || (!f.businessName && !f.category)}
        className="copy-btn mt-6"
        style={{ opacity: busy || !f.goal ? 0.5 : 1 }}
      >
        {busy ? "Drafting…" : "Draft the call"}
      </button>

      {msg && <p className="mt-4 text-sm" style={{ color: "var(--cream)" }}>{msg}</p>}
    </div>
      <TranscriptsSection />
    </>
  );
}
