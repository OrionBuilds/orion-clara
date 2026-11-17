"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useOwner } from "@/components/useOwner";
import {
  Mail, CalendarDays, Plane, Receipt, Activity, Phone,
  CheckCircle2, Inbox, CalendarClock, ListChecks,
} from "lucide-react";
import Panel from "@/components/Panel";
import ModuleCard from "@/components/ModuleCard";

interface Summary {
  stats: { pendingApprovals: number; vipMail: number; todayEvents: number; openTasks: number };
  latestBrief: { markdown: string; date: string } | null;
  health: {
    integrations: { googleWork: boolean; twilio: boolean; places: boolean; friday: { ok: boolean } };
  } | null;
  activity: { id: string; ts: string; kind: string; what: string }[];
}

export default function Home() {
  const { firstName: first } = useOwner();
  const [s, setS] = useState<Summary | null>(null);

  useEffect(() => { fetch("/api/home/summary").then((r) => r.json()).then(setS); }, []);

  return (
    <>
      {/* Hero */}
      <div className="flex items-center justify-between gap-6 mb-8">
        <div>
          <h2 className="text-2xl font-semibold" style={{ color: "var(--cream)" }}>Good to see you{first ? `, ${first}` : ""}.</h2>
          <p className="mt-1 text-sm" style={{ color: "var(--cream-dim)" }}>Here's everything, in one place.</p>
        </div>
        <Link href="/chat" className="copy-btn shrink-0">Talk to Clara</Link>
      </div>

      {/* Stat row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-8">
        <StatTile icon={<CheckCircle2 size={15} />} label="Pending approvals" value={s?.stats.pendingApprovals} href="/approvals" />
        <StatTile icon={<Inbox size={15} />} label="VIP mail" value={s?.stats.vipMail} href="/mail" />
        <StatTile icon={<CalendarClock size={15} />} label="Today's events" value={s?.stats.todayEvents} href="/calendar" />
        <StatTile icon={<ListChecks size={15} />} label="Open tasks" value={s?.stats.openTasks} href="/brief" />
      </div>

      {/* Two-column split */}
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-6 mb-8">
        <Panel title="Today's brief" icon={<CalendarDays size={15} />}>
          {s === null ? (
            <p style={{ color: "var(--cream-dim)" }}>Loading…</p>
          ) : s.latestBrief ? (
            <>
              <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed max-h-[360px] overflow-y-auto scroll" style={{ color: "var(--cream-soft)" }}>
                {s.latestBrief.markdown}
              </pre>
              <Link href="/brief" className="mt-4 inline-block text-xs" style={{ color: "var(--gold)" }}>Open full brief →</Link>
            </>
          ) : (
            <p style={{ color: "var(--cream-mute)" }}>
              No brief yet. <Link href="/brief" style={{ color: "var(--gold)" }}>Compose one</Link>.
            </p>
          )}
        </Panel>

        <div className="flex flex-col gap-4">
          <Panel title="Integrations" icon={<Activity size={15} />}>
            {s?.health ? (
              <ul className="text-sm space-y-1.5">
                <Dot ok={s.health.integrations.googleWork} label="Google — work" />
                <Dot ok={s.health.integrations.twilio} label="Twilio" />
                <Dot ok={s.health.integrations.places} label="Places" />
                <Dot ok={s.health.integrations.friday.ok} label="FRIDAY" />
              </ul>
            ) : (
              <p style={{ color: "var(--cream-dim)" }}>Loading…</p>
            )}
            <Link href="/system" className="mt-3 inline-block text-xs" style={{ color: "var(--gold)" }}>Full health →</Link>
          </Panel>

          <Panel title="Activity" icon={<Receipt size={15} />}>
            {s?.activity.length ? (
              <ul className="text-xs space-y-2 max-h-[220px] overflow-y-auto scroll">
                {s.activity.map((a) => (
                  <li key={a.id} style={{ color: "var(--cream-dim)" }}>
                    <span style={{ color: "var(--cream-mute)" }}>{a.ts.slice(11, 16)}</span> · {a.what}
                  </li>
                ))}
              </ul>
            ) : (
              <p style={{ color: "var(--cream-mute)" }}>Quiet so far.</p>
            )}
            <Link href="/ledger" className="mt-3 inline-block text-xs" style={{ color: "var(--gold)" }}>Full ledger →</Link>
          </Panel>
        </div>
      </div>

      {/* Module grid */}
      <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-4 gap-3">
        <ModuleCard href="/mail" title="Mail" tagline="Triaged inbox — VIPs starred, routine handled." icon={<Mail size={20} />}
          status={s?.health?.integrations.googleWork ? "ok" : "warn"}
          metrics={[{ label: "VIP", value: String(s?.stats.vipMail ?? "—") }, { label: "Status", value: s?.health?.integrations.googleWork ? "linked" : "not linked" }]} />
        <ModuleCard href="/calendar" title="Calendar" tagline="Your schedule at a glance." icon={<CalendarDays size={20} />}
          status={s?.health?.integrations.googleWork ? "ok" : "warn"}
          metrics={[{ label: "Today", value: String(s?.stats.todayEvents ?? "—") }, { label: "Status", value: s?.health?.integrations.googleWork ? "linked" : "not linked" }]} />
        <ModuleCard href="/travel" title="Travel" tagline="Ask Clara for an itinerary." icon={<Plane size={20} />}
          status="ok" metrics={[{ label: "Approvals", value: String(s?.stats.pendingApprovals ?? "—") }, { label: "Posture", value: "research→email" }]} />
        <ModuleCard href="/calls" title="Business Calls" tagline="Inquire or book with a local business." icon={<Phone size={20} />}
          status={s?.health?.integrations.twilio ? "ok" : "warn"} metrics={[{ label: "Posture", value: "ask-first" }, { label: "Twilio", value: s?.health?.integrations.twilio ? "connected" : "not set up" }]} />
        <ModuleCard href="/ledger" title="Ledger" tagline="Every booking, email, and call — logged." icon={<Receipt size={20} />}
          status={s?.health?.integrations.twilio ? "ok" : "warn"}
          metrics={[{ label: "Recent", value: String(s?.activity.length ?? "—") }, { label: "Twilio", value: s?.health?.integrations.twilio ? "connected" : "not set up" }]} />
        <ModuleCard href="/system" title="System" tagline="Engines, sensitivity routing, drills." icon={<Activity size={20} />}
          status="ok" metrics={[{ label: "FRIDAY", value: s?.health?.integrations.friday.ok ? "online" : "offline" }, { label: "Gate", value: "local-only" }]} />
      </div>
    </>
  );
}

function StatTile({ icon, label, value, href }: { icon: React.ReactNode; label: string; value: number | undefined; href: string }) {
  return (
    <Link href={href} className="vital-tile block">
      <div className="flex items-center gap-1.5 k" style={{ color: "var(--gold)" }}>{icon} {label}</div>
      <div className="v text-2xl">{value ?? "—"}</div>
    </Link>
  );
}

function Dot({ ok, label }: { ok: boolean; label: string }) {
  return (
    <li className="flex items-center gap-2">
      <span className={`status-dot ${ok ? "ok" : "err"}`} />
      <span style={{ color: "var(--cream-soft)" }}>{label}</span>
    </li>
  );
}
