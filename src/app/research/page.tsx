"use client";
import { useState } from "react";

interface Result { ok: boolean; notebookId?: string; answer?: string; findings?: string; error?: string }

export default function ResearchPage() {
  const [f, setF] = useState({ title: "", destination: "", sources: "", question: "" });
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<Result | null>(null);

  const sourceList = f.sources.split("\n").map((s) => s.trim()).filter(Boolean);

  async function submit() {
    setBusy(true); setRes(null);
    try {
      const r = await fetch("/api/research/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: f.title,
          question: f.question,
          sources: sourceList,
          destination: f.destination || undefined,
        }),
      });
      setRes(await r.json());
    } catch (e) {
      setRes({ ok: false, error: (e as Error).message });
    } finally { setBusy(false); }
  }

  const answer = res?.answer ?? res?.findings;

  return (
    <div className="max-w-3xl space-y-6">
      <div className="action-card">
        <div className="space-y-3">
          <label className="block">
            <div className="text-sm mb-1" style={{ color: "var(--cream-dim)" }}>Topic</div>
            <input
              placeholder="Montessori vs. Reggio for a 4-year-old"
              value={f.title}
              onChange={(e) => setF({ ...f, title: e.target.value })}
              className="w-full rounded border px-3 py-2"
              style={{ borderColor: "var(--line-soft)", background: "var(--bg-elev)", color: "var(--cream)" }}
            />
          </label>

          <label className="block">
            <div className="text-sm mb-1" style={{ color: "var(--cream-dim)" }}>
              Sources <span style={{ color: "var(--cream-mute)" }}>— one URL or file path per line</span>
            </div>
            <textarea
              rows={5}
              placeholder={"https://example.com/guide\nvault/notes/vendor-comparison.md"}
              value={f.sources}
              onChange={(e) => setF({ ...f, sources: e.target.value })}
              className="w-full rounded border px-3 py-2 font-mono text-sm"
              style={{ borderColor: "var(--line-soft)", background: "var(--bg-elev)", color: "var(--cream)" }}
            />
            <div className="text-xs mt-1" style={{ color: "var(--cream-mute)" }}>
              {sourceList.length} source{sourceList.length === 1 ? "" : "s"}
            </div>
          </label>

          <label className="block">
            <div className="text-sm mb-1" style={{ color: "var(--cream-dim)" }}>Question</div>
            <textarea
              rows={3}
              placeholder="What are the real differences in cost and support, and which suits a ten-person team?"
              value={f.question}
              onChange={(e) => setF({ ...f, question: e.target.value })}
              className="w-full rounded border px-3 py-2"
              style={{ borderColor: "var(--line-soft)", background: "var(--bg-elev)", color: "var(--cream)" }}
            />
          </label>

          <label className="block">
            <div className="text-sm mb-1" style={{ color: "var(--cream-dim)" }}>
              Destination <span style={{ color: "var(--cream-mute)" }}>— optional; set this for trip research and Clara writes the travel question for you</span>
            </div>
            <input
              placeholder="Austin, TX"
              value={f.destination}
              onChange={(e) => setF({ ...f, destination: e.target.value })}
              className="w-full rounded border px-3 py-2"
              style={{ borderColor: "var(--line-soft)", background: "var(--bg-elev)", color: "var(--cream)" }}
            />
          </label>
        </div>

        <button
          onClick={submit}
          disabled={busy || !sourceList.length || (!f.destination && (!f.title || !f.question))}
          className="copy-btn mt-6"
          style={{ opacity: busy || !sourceList.length ? 0.5 : 1 }}
        >
          {busy ? "Researching — this takes a few minutes…" : "Run deep research"}
        </button>

        {busy && (
          <p className="mt-3 text-xs" style={{ color: "var(--cream-mute)" }}>
            Clara is creating a notebook, uploading {sourceList.length} source{sourceList.length === 1 ? "" : "s"}, and reading them before answering. Leave this tab open.
          </p>
        )}
      </div>

      {res && (
        <div className="action-card">
          {answer ? (
            <>
              <div className="flex items-baseline justify-between gap-3 mb-3">
                {/* Findings are synthesized from sources Clara didn't write — same untrusted-content
                    treatment (and same pill) as an approval built from external material. */}
                <span className="pill pill-warn">external content</span>
              </div>
              <pre className="whitespace-pre-wrap font-sans text-sm" style={{ color: "var(--cream-soft)" }}>{answer}</pre>
              <p className="mt-4 text-xs" style={{ color: "var(--cream-mute)" }}>
                Answered from the sources above. Verify anything you'd act on.
              </p>
            </>
          ) : (
            <p className="text-sm" style={{ color: "var(--rust)" }}>{res.error ?? "Research failed with no error detail."}</p>
          )}
        </div>
      )}
    </div>
  );
}
