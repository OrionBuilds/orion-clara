"use client";
import { useEffect, useState } from "react";

interface Q { id: string; text: string; category: string; session: number }
interface Progress { principal: string; answered: string[]; nextSession: number; questions: Q[] }

export default function OnboardingPage() {
  const [prog, setProg] = useState<Progress | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [saved, setSaved] = useState<Set<string>>(new Set());

  useEffect(() => { reload(); }, []);
  async function reload() {
    const r = await fetch("/api/onboarding/progress?principal=owner");
    setProg(await r.json());
  }

  async function submit(qid: string) {
    const text = answers[qid]?.trim();
    if (!text) return;
    setSaving(qid);
    await fetch("/api/onboarding/answer", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ principal: "owner", qid, text }),
    });
    setSaved(new Set([...saved, qid]));
    setSaving(null);
  }

  if (!prog) return <p style={{ color: "var(--cream-dim)" }}>Loading…</p>;

  if (prog.questions.length === 0) {
    return (
      <div className="action-card max-w-2xl">
        <p style={{ color: "var(--cream-dim)" }}>
          You've answered every onboarding question. I'll keep learning as we work together.
        </p>
      </div>
    );
  }

  return (
    <div className="max-w-2xl">
      <p className="mb-6 text-sm" style={{ color: "var(--cream-dim)" }}>
        Session {prog.nextSession} of 5 — answer what you can, come back to the rest anytime.
      </p>

      <div className="space-y-6">
        {prog.questions.map((q) => {
          const isSaved = saved.has(q.id) || prog.answered.includes(q.id);
          return (
            <div key={q.id} className="action-card">
              <div className="action-tag mb-2">{q.category}</div>
              <p className="mb-3">{q.text}</p>
              <textarea
                className="w-full rounded border px-3 py-2 outline-none"
                style={{ borderColor: "var(--line-soft)", background: "var(--bg-elev)", color: "var(--cream)", minHeight: 80 }}
                value={answers[q.id] ?? ""}
                onChange={(e) => setAnswers({ ...answers, [q.id]: e.target.value })}
                disabled={isSaved}
              />
              <div className="mt-2 flex items-center justify-between">
                {isSaved ? (
                  <span className="pill pill-ok">Saved</span>
                ) : (
                  <button
                    onClick={() => submit(q.id)}
                    disabled={saving === q.id || !answers[q.id]?.trim()}
                    className="copy-btn"
                    style={{ padding: "6px 16px", opacity: saving === q.id ? 0.5 : 1 }}
                  >
                    {saving === q.id ? "Saving…" : "Save"}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
