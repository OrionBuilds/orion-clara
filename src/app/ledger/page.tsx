"use client";
import { useEffect, useMemo, useState } from "react";

interface Entry { id: string; ts: string; kind: string; actor: string; amountUsd?: number; what: string; ref?: string }

const KINDS = ["all", "charge", "booking", "email.sent", "sms.sent", "call", "action"];
const ACTORS = ["all", "clara", "owner"];

export default function LedgerPage() {
  const [rows, setRows] = useState<Entry[] | null>(null);
  const [kind, setKind] = useState("all");
  const [actor, setActor] = useState("all");
  const [days, setDays] = useState<number>(7);
  const [q, setQ] = useState("");

  useEffect(() => { fetch("/api/ledger").then((r) => r.json()).then(setRows); }, []);

  const cutoff = useMemo(() => Date.now() - days * 86_400_000, [days]);
  const filtered = (rows ?? []).filter((r) => {
    if (kind !== "all" && r.kind !== kind) return false;
    if (actor !== "all" && r.actor !== actor) return false;
    if (new Date(r.ts).getTime() < cutoff) return false;
    if (q && !`${r.what} ${r.kind} ${r.actor}`.toLowerCase().includes(q.toLowerCase())) return false;
    return true;
  });

  const totalUsd = filtered.filter((r) => r.kind === "charge").reduce((s, r) => s + (r.amountUsd ?? 0), 0);
  const countBy = filtered.reduce<Record<string, number>>((acc, r) => { acc[r.kind] = (acc[r.kind] ?? 0) + 1; return acc; }, {});

  return (
    <div className="max-w-5xl">
      <div className="flex flex-wrap items-end gap-3 text-sm mb-3">
        <Field label="Kind">
          <select value={kind} onChange={(e) => setKind(e.target.value)}
                  className="rounded border px-2 py-1" style={boxStyle}>
            {KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
          </select>
        </Field>
        <Field label="Actor">
          <select value={actor} onChange={(e) => setActor(e.target.value)}
                  className="rounded border px-2 py-1" style={boxStyle}>
            {ACTORS.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
        </Field>
        <Field label="Window">
          <select value={days} onChange={(e) => setDays(Number(e.target.value))}
                  className="rounded border px-2 py-1" style={boxStyle}>
            {[1, 3, 7, 30, 90, 3650].map((d) => <option key={d} value={d}>{d === 3650 ? "all time" : `${d}d`}</option>)}
          </select>
        </Field>
        <Field label="Search">
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="text…"
                 className="rounded border px-2 py-1" style={boxStyle} />
        </Field>
        <div className="ml-auto text-xs" style={{ color: "var(--cream-mute)" }}>
          {filtered.length} entries · charges ${totalUsd.toFixed(2)}
        </div>
      </div>

      <div className="flex flex-wrap gap-3 text-xs mb-6" style={{ color: "var(--cream-dim)" }}>
        {Object.entries(countBy).map(([k, n]) => <span key={k} className="pill">{k}: {n}</span>)}
      </div>

      {rows === null ? <p style={{ color: "var(--cream-dim)" }}>Loading…</p> : filtered.length === 0 ? (
        <p style={{ color: "var(--cream-mute)" }}>No matches.</p>
      ) : (
        <div className="panel overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left" style={{ color: "var(--cream-dim)" }}>
              <th className="py-2 pl-5 pr-4">When</th>
              <th className="py-2 pr-4">Kind</th>
              <th className="py-2 pr-4">Actor</th>
              <th className="py-2 pr-4">$</th>
              <th className="py-2 pr-5">What</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => (
              <tr key={r.id} className="border-t align-top" style={{ borderColor: "var(--line-soft)" }}>
                <td className="py-2 pl-5 pr-4 whitespace-nowrap" style={{ color: "var(--cream-mute)" }}>{r.ts.replace("T", " ").slice(0, 19)}</td>
                <td className="py-2 pr-4">{r.kind}</td>
                <td className="py-2 pr-4">{r.actor}</td>
                <td className="py-2 pr-4">{r.amountUsd ? `$${r.amountUsd.toFixed(2)}` : "—"}</td>
                <td className="py-2 pr-5">{r.what}</td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}
    </div>
  );
}

function Field(props: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs" style={{ color: "var(--cream-mute)" }}>{props.label}</span>
      {props.children}
    </label>
  );
}
const boxStyle: React.CSSProperties = { borderColor: "var(--line-soft)", background: "var(--bg-elev)", color: "var(--cream)" };
