"use client";
// Unified inbox — one triage queue over mail, SMS/calls, approvals, batched notifications, and
// open follow-ups. Signal/Noise tabs, keyboard triage (j/k select, Enter open, e done, a/r
// approve/reject, x flip bucket*). *x is a stretch — bucket is server-computed per source
// (rule-based, not AI-classified like the orion version), so it's read-only for v1.

import { useEffect, useState, useCallback, useRef } from "react";
import Link from "next/link";
import { Mail, MessageSquare, Phone, ShieldAlert, Bell, ListChecks, Check, X, ExternalLink, Bot } from "lucide-react";

interface InboxItem {
  id: string;
  source: "mail" | "sms" | "call" | "approval" | "notification" | "followup" | "friday-approval";
  ts: string;
  title: string;
  detail?: string;
  bucket: "signal" | "noise";
  reason: string;
  href?: string;
  actions: Array<"done" | "approve" | "reject">;
}

const SOURCE_ICON: Record<InboxItem["source"], React.ReactNode> = {
  mail: <Mail size={14} />, sms: <MessageSquare size={14} />, call: <Phone size={14} />,
  approval: <ShieldAlert size={14} />, notification: <Bell size={14} />, followup: <ListChecks size={14} />,
  "friday-approval": <Bot size={14} />,
};

export default function InboxPage() {
  const [items, setItems] = useState<InboxItem[]>([]);
  const [counts, setCounts] = useState({ signal: 0, noise: 0 });
  const [tab, setTab] = useState<"signal" | "noise">("signal");
  const [selected, setSelected] = useState(0);
  const [loading, setLoading] = useState(true);
  const listRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const j = await fetch("/api/inbox").then((r) => r.json());
      setItems(j.items ?? []);
      setCounts(j.counts ?? { signal: 0, noise: 0 });
    } finally { setLoading(false); }
  }, []);
  useEffect(() => {
    load();
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, [load]);

  const visible = items.filter((i) => i.bucket === tab);
  useEffect(() => { setSelected(0); }, [tab]);

  const act = useCallback(async (item: InboxItem, action: "done" | "approve" | "reject") => {
    // Optimistic — pull it out of the list immediately, reconcile on the next poll.
    setItems((prev) => prev.filter((i) => i.id !== item.id));
    await fetch("/api/inbox/item", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ item, action }) }).catch(() => {});
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const el = document.activeElement;
      const typing = el instanceof HTMLElement && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
      if (typing) return;

      const item = visible[selected];
      if (e.key === "j") { e.preventDefault(); setSelected((s) => Math.min(s + 1, visible.length - 1)); }
      else if (e.key === "k") { e.preventDefault(); setSelected((s) => Math.max(s - 1, 0)); }
      else if (e.key === "Tab") { e.preventDefault(); setTab((t) => (t === "signal" ? "noise" : "signal")); }
      else if (item && e.key === "Enter" && item.href) { window.location.href = item.href; }
      else if (item && e.key === "e") { e.preventDefault(); void act(item, "done"); }
      else if (item && e.key === "a" && item.actions.includes("approve")) { e.preventDefault(); void act(item, "approve"); }
      else if (item && e.key === "r" && item.actions.includes("reject")) { e.preventDefault(); void act(item, "reject"); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [visible, selected, act]);

  return (
    <div className="max-w-3xl space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex gap-2">
          {(["signal", "noise"] as const).map((t) => (
            <button key={t} onClick={() => setTab(t)} className="pill" style={tab === t ? { borderColor: "var(--gold)", color: "var(--gold)" } : undefined}>
              {t === "signal" ? "Signal" : "Noise"} · {counts[t]}
            </button>
          ))}
        </div>
        <p className="text-[11px]" style={{ color: "var(--cream-mute)" }}>j/k move · enter open · e done · a/r approve/reject · tab switch</p>
      </div>

      {loading ? (
        <p style={{ color: "var(--cream-dim)" }}>Loading…</p>
      ) : visible.length === 0 ? (
        <p style={{ color: "var(--cream-mute)" }}>{tab === "signal" ? "Nothing needs you right now." : "No noise."}</p>
      ) : (
        <div ref={listRef} className="action-card divide-y p-0" style={{ borderColor: "var(--line-soft)" }}>
          {visible.map((item, i) => (
            <div key={item.id} className="py-3 px-5 flex items-start gap-3" style={i === selected ? { background: "rgba(8,145,178,0.08)" } : undefined}>
              <span className="mt-0.5" style={{ color: "var(--cream-dim)" }}>{SOURCE_ICON[item.source]}</span>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium truncate">{item.title}</span>
                  <span className="pill text-[10px]">{item.reason}</span>
                </div>
                {item.detail && <p className="text-sm truncate mt-0.5" style={{ color: "var(--cream-dim)" }}>{item.detail}</p>}
                <p className="text-[11px] mt-1" style={{ color: "var(--cream-mute)" }}>{new Date(item.ts).toLocaleString()}</p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {item.href && (
                  <Link href={item.href} className="grid place-items-center w-7 h-7 rounded-lg" style={{ color: "var(--cream-dim)" }} title="Open">
                    <ExternalLink size={14} />
                  </Link>
                )}
                {item.actions.includes("approve") && (
                  <button onClick={() => act(item, "approve")} className="grid place-items-center w-7 h-7 rounded-lg" style={{ color: "var(--emerald)" }} title="Approve"><Check size={15} /></button>
                )}
                {item.actions.includes("reject") && (
                  <button onClick={() => act(item, "reject")} className="grid place-items-center w-7 h-7 rounded-lg" style={{ color: "var(--plum)" }} title="Reject"><X size={15} /></button>
                )}
                {item.actions.includes("done") && (
                  <button onClick={() => act(item, "done")} className="grid place-items-center w-7 h-7 rounded-lg" style={{ color: "var(--cream-dim)" }} title="Mark done"><Check size={15} /></button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
