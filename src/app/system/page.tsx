"use client";
import { useEffect, useState } from "react";

interface DeepHealth { configured: boolean; authed: boolean | null; detail?: string }
interface Health {
  engines: { lmstudio: { reachable: boolean; note?: string; chatModel?: string; embedModel?: string }; anthropic: { configured: boolean }; elevenlabs: { configured: boolean } };
  engineRoster: Record<"claude" | "codex" | "antigravity" | "hermes" | "lmstudio" | "ollama", DeepHealth>;
  integrations: { googleWork: boolean; twilio: boolean; places: boolean; weather: boolean; drive: { ok: boolean; detail?: string }; sync: { kind: string; account: string; lastRunAt: string | null; linked: number; pending: number }[]; friday: { ok: boolean; base: string; error?: string }; stirlingPdf: boolean; whisper: { binFound: boolean; modelFound: boolean; ffmpegFound: boolean } };
  vault: { root: string; sizeMb: number; fileCount: number };
  sensitivity: { testCases: { name: string; verdictSensitive: boolean; enginePicked: string; blocked: boolean }[]; ok: boolean };
}

const ROSTER_LABELS: Record<string, string> = {
  claude: "Claude", codex: "Codex", antigravity: "Antigravity (agy)", hermes: "Hermes", lmstudio: "LM Studio",
};

function statusDot(h: DeepHealth): string {
  return h.authed === true ? "status-dot ok" : h.authed === false ? "status-dot err" : h.configured ? "status-dot warn" : "status-dot";
}
interface DrillResult {
  name: string; simulated: { fromE164: string; ownerFocusMode: boolean; isWhitelisted: boolean };
  verdict: { route: string; urgency: string; reason: string };
  interruptLanded: boolean; executed: boolean; notes: string[];
}

const DRILLS = [
  { name: "unknown-focus",   label: "Stranger, focus on", desc: "Should route to Clara." },
  { name: "unknown-open",    label: "Stranger, focus off",desc: "Should ring the owner's line." },
];

interface SearchHit { relPath: string; snippet: string; score: number; updatedAt: string }

export default function SystemPage() {
  const [h, setH] = useState<Health | null>(null);
  const [drills, setDrills] = useState<Record<string, DrillResult | undefined>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [memQuery, setMemQuery] = useState("");
  const [memHits, setMemHits] = useState<SearchHit[] | null>(null);
  const [memBusy, setMemBusy] = useState<"search" | "reindex" | "consolidate" | null>(null);
  const [memMsg, setMemMsg] = useState<string | null>(null);

  useEffect(() => { fetch("/api/system/health").then((r) => r.json()).then(setH); }, []);

  async function searchMemory() {
    if (!memQuery.trim()) return;
    setMemBusy("search");
    try {
      const r = await fetch(`/api/memory/search?q=${encodeURIComponent(memQuery)}`);
      setMemHits(await r.json());
    } finally { setMemBusy(null); }
  }
  async function reindex() {
    setMemBusy("reindex"); setMemMsg(null);
    try {
      const r = await fetch("/api/memory/reindex", { method: "POST" });
      const j = await r.json();
      setMemMsg(`Scanned ${j.scanned}, indexed ${j.indexed}, skipped ${j.skipped}`);
    } finally { setMemBusy(null); }
  }
  async function consolidate() {
    setMemBusy("consolidate"); setMemMsg(null);
    try {
      const r = await fetch("/api/memory/consolidate", { method: "POST" });
      const j = await r.json();
      setMemMsg(`Owner: ${j.owner.changed ? "updated" : j.owner.reason}.`);
    } finally { setMemBusy(null); }
  }

  async function runDrill(name: string, execute = false) {
    setBusy(name);
    try {
      const r = await fetch("/api/system/drill", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, execute }) });
      const j = await r.json();
      setDrills((d) => ({ ...d, [name]: j }));
    } finally { setBusy(null); }
  }

  return (
    <div className="max-w-4xl">
      {!h ? <p style={{ color: "var(--cream-dim)" }}>Loading…</p> : (
        <div className="space-y-6">
          <section className="panel p-5">
            <h2 className="text-lg font-medium mb-2">Engines</h2>
            <ul className="text-sm space-y-1">
              <li>
                {dot(h.engines.lmstudio.reachable)} LM Studio {h.engines.lmstudio.note ? `— ${h.engines.lmstudio.note}` : ""}
                {h.engines.lmstudio.chatModel && (
                  <div className="ml-5 mt-0.5 text-xs" style={{ color: "var(--cream-dim)" }}>
                    chat: {h.engines.lmstudio.chatModel} · embed: {h.engines.lmstudio.embedModel}
                  </div>
                )}
              </li>
              <li>{dot(h.engines.anthropic.configured)} Anthropic (ANTHROPIC_API_KEY)</li>
              <li>{dot(h.engines.elevenlabs.configured)} ElevenLabs</li>
            </ul>
          </section>

          <section className="panel p-5">
            <h2 className="text-lg font-medium mb-2">Engine roster</h2>
            <ul className="text-sm space-y-1">
              {(["claude", "codex", "antigravity", "hermes", "lmstudio"] as const).map((k) => {
                const eh = h.engineRoster?.[k];
                if (!eh) return null;
                return (
                  <li key={k} className="flex items-center gap-2">
                    <span className={statusDot(eh)} />
                    {ROSTER_LABELS[k]}
                    {eh.detail && <span style={{ color: "var(--cream-mute)" }}> — {eh.detail}</span>}
                  </li>
                );
              })}
            </ul>
          </section>

          <section className="panel p-5">
            <h2 className="text-lg font-medium mb-2">Integrations</h2>
            <ul className="text-sm space-y-1">
              <li>{dot(h.integrations.googleWork)} Google — work</li>
              <li>{dot(h.integrations.twilio)} Twilio (Clara's number)</li>
              <li>{dot(h.integrations.places)} Google Places (business lookup)</li>
              <li>{dot(h.integrations.weather)} Google Weather{h.integrations.weather ? "" : " — needs API key + CLARA_HOME_LAT/LNG"}</li>
              <li>{dot(h.integrations.drive.ok)} Google Drive{h.integrations.drive.detail ? ` — ${h.integrations.drive.detail}` : ""}</li>
              <li>{dot(h.integrations.friday.ok)} FRIDAY @ {h.integrations.friday.base}{h.integrations.friday.error ? ` — ${h.integrations.friday.error}` : ""}</li>
              <li>{dot(h.integrations.stirlingPdf)} Stirling-PDF (merge/OCR/redact/compress)</li>
              {/* Whisper needs BOTH the binary and a model — call out which is missing rather than
                  one blended red dot. */}
              <li>
                {dot(h.integrations.whisper.binFound && h.integrations.whisper.modelFound && h.integrations.whisper.ffmpegFound)} Whisper (call transcription)
                {!h.integrations.whisper.binFound
                  ? " — binary not found: set CLARA_WHISPER_BIN"
                  : !h.integrations.whisper.modelFound
                    ? " — model not found: set CLARA_WHISPER_MODEL"
                    : !h.integrations.whisper.ffmpegFound
                      ? " — ffmpeg not found: set CLARA_FFMPEG_BIN or add to PATH"
                      : ""}
              </li>
            </ul>
          </section>

          <section className="panel p-5">
            <div className="flex items-baseline justify-between mb-2">
              <h2 className="text-lg font-medium">Google sync</h2>
              <a href="/sync" className="text-xs" style={{ color: "var(--gold)" }}>Manage →</a>
            </div>
            <ul className="text-sm space-y-1">
              {(h.integrations.sync ?? []).map((s) => (
                <li key={`${s.kind}-${s.account}`}>
                  {dot(Boolean(s.lastRunAt))} {s.kind} · {s.account} — {s.linked} linked
                  {s.pending > 0 ? `, ${s.pending} awaiting review` : ""}
                  <span style={{ color: "var(--cream-dim)" }}>
                    {s.lastRunAt ? ` · last ${s.lastRunAt.replace("T", " ").slice(0, 16)}` : " · never run"}
                  </span>
                </li>
              ))}
            </ul>
          </section>

          <PhonePanel />

          <section className="panel p-5">
            <h2 className="text-lg font-medium mb-2">Vault</h2>
            <p className="text-sm">
              <code>{h.vault.root}</code> — {h.vault.fileCount} files · {h.vault.sizeMb} MB
            </p>
          </section>

          <section className="panel p-5">
            <h2 className="text-lg font-medium mb-2">Memory</h2>
            <div className="flex gap-2 mb-3">
              <input
                value={memQuery}
                onChange={(e) => setMemQuery(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") searchMemory(); }}
                placeholder="Search vault memory…"
                className="flex-1 rounded border px-2 py-1 text-sm"
                style={{ borderColor: "var(--line-soft)", background: "var(--bg-elev)", color: "var(--cream)" }}
              />
              <button onClick={searchMemory} disabled={memBusy !== null || !memQuery.trim()}
                      className="rounded px-3 py-1 text-sm" style={{ background: "var(--bg-elev)", color: "var(--gold)", opacity: memBusy ? 0.5 : 1 }}>
                {memBusy === "search" ? "…" : "Search"}
              </button>
            </div>
            {memHits && (
              <ul className="text-sm space-y-2 mb-3">
                {memHits.length === 0 ? <li style={{ color: "var(--cream-mute)" }}>No matches.</li> : memHits.map((hit) => (
                  <li key={hit.relPath}>
                    <span className="pill pill-info">{hit.score.toFixed(2)}</span> <code className="text-xs">{hit.relPath}</code>
                    <div style={{ color: "var(--cream-dim)" }}>{hit.snippet}</div>
                  </li>
                ))}
              </ul>
            )}
            <div className="flex gap-2">
              <button onClick={reindex} disabled={memBusy !== null} className="rounded px-2 py-1 text-xs" style={{ background: "var(--bg-elev)", color: "var(--gold)", opacity: memBusy ? 0.5 : 1 }}>
                {memBusy === "reindex" ? "Reindexing…" : "Reindex vault"}
              </button>
              <button onClick={consolidate} disabled={memBusy !== null} className="rounded px-2 py-1 text-xs" style={{ background: "var(--bg-elev)", color: "var(--gold)", opacity: memBusy ? 0.5 : 1 }}>
                {memBusy === "consolidate" ? "Consolidating…" : "Consolidate now"}
              </button>
            </div>
            {memMsg && <p className="mt-2 text-xs" style={{ color: "var(--cream-dim)" }}>{memMsg}</p>}
          </section>

          <section className="panel p-5">
            <h2 className="text-lg font-medium mb-2">
              Sensitivity routing <span className={`pill ${h.sensitivity.ok ? "pill-ok" : "pill-err"}`}>{h.sensitivity.ok ? "OK" : "LEAK"}</span>
            </h2>
            <table className="text-sm w-full mt-2">
              <thead><tr style={{ color: "var(--cream-dim)" }}>
                <th className="text-left py-1 pr-4">probe</th>
                <th className="text-left py-1 pr-4">sensitive?</th>
                <th className="text-left py-1 pr-4">picked</th>
                <th className="text-left py-1">gate</th>
              </tr></thead>
              <tbody>
                {h.sensitivity.testCases.map((t) => {
                  const localRouted = t.verdictSensitive && (t.enginePicked === "lmstudio" || t.enginePicked === "ollama");
                  const status = t.blocked ? "gate fired" : localRouted ? "routed local" : t.verdictSensitive ? "LEAK" : "n/a";
                  const color = localRouted || t.blocked ? "var(--emerald)"
                              : t.verdictSensitive ? "var(--plum)" : "var(--cream-mute)";
                  return (
                    <tr key={t.name} className="border-t" style={{ borderColor: "var(--line-soft)" }}>
                      <td className="py-1 pr-4">{t.name}</td>
                      <td className="py-1 pr-4">{t.verdictSensitive ? "yes" : "no"}</td>
                      <td className="py-1 pr-4">{t.enginePicked}</td>
                      <td className="py-1" style={{ color }}>{status}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>

          <section>
            <h2 className="text-lg font-medium mb-2">Emergency drills</h2>
            <div className="space-y-3">
              {DRILLS.map((d) => {
                const r = drills[d.name];
                return (
                  <div key={d.name} className="action-card">
                    <div className="flex items-baseline justify-between gap-3">
                      <div>
                        <div className="font-medium">{d.label}</div>
                        <div className="text-xs" style={{ color: "var(--cream-dim)" }}>{d.desc}</div>
                      </div>
                      <div className="flex gap-2">
                        <button onClick={() => runDrill(d.name)} disabled={busy === d.name}
                                className="rounded px-2 py-1 text-xs"
                                style={{ background: "var(--bg-elev)", color: "var(--gold)", opacity: busy === d.name ? 0.5 : 1 }}>
                          {busy === d.name ? "…" : "Dry run"}
                        </button>
                        <button onClick={() => runDrill(d.name, true)} disabled={busy === d.name}
                                className="copy-btn"
                                style={{ padding: "4px 12px", opacity: busy === d.name ? 0.5 : 1 }}
                                title="Also sends a real SMS to the owner if the drill would interrupt.">
                          Run for real
                        </button>
                      </div>
                    </div>
                    {r && (
                      <div className="mt-2 text-xs" style={{ color: r.interruptLanded ? "var(--emerald)" : "var(--rust)" }}>
                        route:{r.verdict.route} · urgency:{r.verdict.urgency} · {r.verdict.reason}
                        {r.executed && <span style={{ color: "var(--emerald)" }}> · SMS sent</span>}
                        {r.notes.length > 0 && <div style={{ color: "var(--cream-mute)" }} className="mt-1">{r.notes.map((n, i) => <div key={i}>· {n}</div>)}</div>}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

function dot(ok: boolean): string {
  return ok ? "🟢" : "⚪";
}

interface PhoneStatus {
  configured: boolean;
  from?: string | null;
  smsUrl?: string | null;
  voiceUrl?: string | null;
  pathWired?: boolean;
  reachable?: boolean;
  wired?: boolean;
  error?: string;
}

function PhonePanel() {
  const [status, setStatus] = useState<PhoneStatus | null>(null);
  const [baseUrl, setBaseUrl] = useState("https://clara.example.com");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  function refresh() {
    fetch("/api/system/phone").then((r) => r.json()).then(setStatus).catch(() => {});
  }
  useEffect(refresh, []);

  // Voice only. SMS lives on the OS edge rail (the CRM path: DNC, quiet hours, reply cap) and is
  // deliberately not re-pointed by this button — it used to be, as an invisible side effect of
  // wiring voice, which is how a working SMS rail gets moved by someone who only meant to fix a
  // tunnel URL.
  async function pointWebhooks() {
    setBusy(true); setMsg(null);
    try {
      const r = await fetch("/api/system/phone", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ baseUrl }),
      });
      const j = await r.json();
      setMsg(r.ok ? `Voice webhooks updated (${(j.changed ?? []).join(", ") || "none"}). SMS untouched.` : (j.error ?? "Failed."));
      refresh();
    } finally { setBusy(false); }
  }

  return (
    <section className="panel p-5">
      <h2 className="text-lg font-medium mb-2">Phone (Twilio)</h2>
      {!status ? <p style={{ color: "var(--cream-dim)" }}>Loading…</p>
       : !status.configured ? <p className="text-sm" style={{ color: "var(--cream-mute)" }}>Not configured — set CLARA_TWILIO_ACCOUNT_SID/AUTH_TOKEN/NUMBER in .env.local.</p>
       : (
        <div className="text-sm space-y-2">
          <div>{dot(Boolean(status.wired))} {status.wired ? "Live" : status.pathWired ? "Wired, but the tunnel isn't reachable" : "Webhooks not pointed at Clara"} — {status.from}</div>
          {status.smsUrl && <div className="text-xs" style={{ color: "var(--cream-mute)" }}>SMS: {status.smsUrl}</div>}
          {status.voiceUrl && <div className="text-xs" style={{ color: "var(--cream-mute)" }}>Voice: {status.voiceUrl}</div>}
          {status.error && <div className="text-xs" style={{ color: "var(--plum)" }}>{status.error}</div>}
          <div className="flex gap-2 mt-2">
            <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)}
                   className="flex-1 rounded border px-2 py-1 text-sm"
                   style={{ borderColor: "var(--line-soft)", background: "var(--bg-elev)", color: "var(--cream)" }} />
            <button onClick={pointWebhooks} disabled={busy} className="rounded px-3 py-1 text-sm"
                    style={{ background: "var(--bg-elev)", color: "var(--gold)", opacity: busy ? 0.5 : 1 }}>
              {busy ? "…" : "Point VOICE here"}
            </button>
          </div>
          {msg && <p className="text-xs" style={{ color: "var(--cream-dim)" }}>{msg}</p>}
        </div>
      )}
    </section>
  );
}
