"use client";

import { Command } from "cmdk";
import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Sunrise, Moon, CalendarRange, Inbox, ListChecks, Activity, Search } from "lucide-react";

interface ActionResult { label: string; ok: boolean; detail: string }

interface Action {
  id: string;
  label: string;
  icon: React.ReactNode;
  run: () => Promise<ActionResult>;
}

async function postJson(url: string): Promise<{ ok: boolean; detail: string }> {
  try {
    const r = await fetch(url, { method: "POST" });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, detail: j.error ?? `HTTP ${r.status}` };
    return { ok: true, detail: summarize(j) };
  } catch (e) {
    return { ok: false, detail: (e as Error).message };
  }
}
function summarize(j: unknown): string {
  if (j && typeof j === "object") {
    const o = j as Record<string, unknown>;
    if (typeof o.vaultPath === "string") return `saved to ${o.vaultPath}`;
    if (typeof o.count === "number") return `${o.count} processed`;
    if (typeof o.sent === "number") return `${o.sent} sent, ${o.failed ?? 0} failed`;
    if (Array.isArray(o.subs)) return `${o.subs.length} recurring merchants found`;
  }
  return "done";
}

export default function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<ActionResult | null>(null);
  const [running, setRunning] = useState<string | null>(null);
  const router = useRouter();

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      }
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const ACTIONS: Action[] = [
    { id: "morning", label: "Run morning brief now", icon: <Sunrise size={16} />, run: async () => {
      const r = await postJson("/api/brief/morning"); return { label: "Morning brief", ...r };
    } },
    { id: "evening", label: "Run evening brief now", icon: <Moon size={16} />, run: async () => {
      const r = await postJson("/api/brief/evening"); return { label: "Evening brief", ...r };
    } },
    { id: "weekly", label: "Run weekly review now", icon: <CalendarRange size={16} />, run: async () => {
      const r = await postJson("/api/brief/weekly"); return { label: "Weekly review", ...r };
    } },
    { id: "triage", label: "Triage inbox now", icon: <Inbox size={16} />, run: async () => {
      const r = await postJson("/api/mail/triage"); return { label: "Inbox triage", ...r };
    } },
    { id: "followups", label: "Tick followups", icon: <ListChecks size={16} />, run: async () => {
      const r = await postJson("/api/followups/tick"); return { label: "Followup tick", ...r };
    } },
    { id: "system", label: "Check system health", icon: <Activity size={16} />, run: async () => {
      setOpen(false); router.push("/system"); return { label: "System health", ok: true, detail: "opened" };
    } },
  ];

  async function runAction(a: Action) {
    setRunning(a.id);
    setResult(null);
    const r = await a.run();
    setRunning(null);
    setResult(r);
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="hidden md:flex items-center gap-2 px-3 py-1.5 rounded-md border text-[11px] transition hover:border-[var(--line)]"
        style={{ borderColor: "var(--line-soft)", color: "var(--cream-dim)", background: "rgba(231,229,228,0.02)" }}
      >
        <Search size={13} />
        <span>⌘K Command palette</span>
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-[200] flex items-start justify-center pt-[12vh]"
            style={{ background: "rgba(0,0,0,0.5)", backdropFilter: "blur(2px)" }}
            onClick={() => setOpen(false)}
          >
            <motion.div
              initial={{ opacity: 0, y: -12, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -8, scale: 0.98 }}
              transition={{ type: "spring", stiffness: 400, damping: 32 }}
              className="w-[min(640px,92vw)] rounded-xl overflow-hidden panel panel-hot"
              onClick={(e) => e.stopPropagation()}
            >
              <Command>
                <Command.Input autoFocus placeholder="Ask Clara to do something…" className="cmdk-input" />
                <Command.List className="max-h-80 overflow-y-auto p-2">
                  <Command.Empty className="px-4 py-6 text-sm" style={{ color: "var(--cream-dim)" }}>
                    No matching action.
                  </Command.Empty>
                  {ACTIONS.map((a) => (
                    <Command.Item
                      key={a.id}
                      value={a.label}
                      onSelect={() => runAction(a)}
                      className="cmdk-item"
                    >
                      <span style={{ color: "var(--gold)" }}>{a.icon}</span>
                      <span className="flex-1">{a.label}</span>
                      {running === a.id && <span className="text-xs" style={{ color: "var(--cream-dim)" }}>running…</span>}
                    </Command.Item>
                  ))}
                </Command.List>
                {result && (
                  <div className="border-t px-4 py-3 text-sm" style={{ borderColor: "var(--line-soft)" }}>
                    <span style={{ color: result.ok ? "var(--emerald)" : "var(--plum)" }}>
                      {result.ok ? "✓" : "✗"} {result.label}
                    </span>
                    <span className="ml-2" style={{ color: "var(--cream-dim)" }}>{result.detail}</span>
                  </div>
                )}
              </Command>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
