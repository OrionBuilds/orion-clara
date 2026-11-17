"use client";
import { useEffect, useState } from "react";

interface CalEvent {
  id: string; summary: string; start: string; end: string;
  attendees?: string[]; hangoutLink?: string; calendarOwner: "work";
}

export default function CalendarPage() {
  const [events, setEvents] = useState<CalEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [days, setDays] = useState(7);

  useEffect(() => {
    setError(null);
    fetch(`/api/calendar/events?days=${days}`)
      .then((r) => r.json())
      .then((j) => Array.isArray(j) ? setEvents(j) : setError(j.error ?? "failed"))
      .catch((e) => setError(String(e)));
  }, [days]);

  const grouped = groupByDay(events ?? []);

  return (
    <div className="max-w-3xl">
      <div className="flex items-center justify-between mb-4">
        <span className="pill pill-info">next {days} days</span>
        <select
          value={days}
          onChange={(e) => setDays(Number(e.target.value))}
          className="rounded border px-2 py-1 text-sm"
          style={{ borderColor: "var(--line)", background: "var(--bg-elev)", color: "var(--cream)" }}
        >
          {[1, 3, 7, 14, 30].map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
      </div>

      {error && (
        <div className="action-card mb-4" style={{ borderColor: "rgba(245,158,11,0.35)" }}>
          {error} — visit <a href="/settings/connect" style={{ color: "var(--gold)" }}>Settings → Connect</a>.
        </div>
      )}

      {events === null ? <p style={{ color: "var(--cream-dim)" }}>Loading…</p> : events.length === 0 && !error ? (
        <p style={{ color: "var(--cream-mute)" }}>Nothing scheduled.</p>
      ) : (
        <div className="space-y-6">
          {grouped.map(([day, dayEvents]) => (
            <div key={day}>
              <div className="sidebar-section-label mb-2">{day}</div>
              <ul className="space-y-2">
                {dayEvents.map((e) => (
                  <li key={e.id} className="action-card py-3"
                      style={{ borderColor: "var(--line)" }}>
                    <div className="flex items-baseline justify-between">
                      <span className="font-medium">{e.summary}</span>
                      <span className="text-xs" style={{ color: "var(--cream-mute)" }}>
                        {fmtTime(e.start)} – {fmtTime(e.end)}
                      </span>
                    </div>
                    {e.attendees?.length ? (
                      <div className="text-xs mt-1" style={{ color: "var(--cream-dim)" }}>
                        with {e.attendees.slice(0, 4).join(", ")}{e.attendees.length > 4 ? "…" : ""}
                      </div>
                    ) : null}
                    {e.hangoutLink && (
                      <a href={e.hangoutLink} target="_blank" rel="noreferrer"
                         className="text-xs mt-1 inline-block" style={{ color: "var(--gold)" }}>
                        Meet link
                      </a>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function groupByDay(events: CalEvent[]): [string, CalEvent[]][] {
  const groups = new Map<string, CalEvent[]>();
  for (const e of events) {
    const day = new Date(e.start).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
    if (!groups.has(day)) groups.set(day, []);
    groups.get(day)!.push(e);
  }
  return [...groups.entries()];
}
function fmtTime(iso: string): string {
  const d = new Date(iso); if (isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}
