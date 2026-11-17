"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import CommandPalette from "./CommandPalette";

interface PageMeta { numeral: string; label: string; title: string; sub: string; }

// Roman numeral + chapter label per route — direct port of FRIDAY's TopBar.tsx pattern.
const TITLES: Record<string, PageMeta> = {
  "/":                   { numeral: "I.",    label: "Home",              title: "Clara",            sub: "Good to see you. Here's everything, in one place." },
  "/chat":               { numeral: "0.",    label: "Command",           title: "Talk to Clara",    sub: "Text or voice — she's listening." },
  "/inbox":              { numeral: "I.",    label: "Command · Inbox",   title: "Inbox",            sub: "Everything inbound — one stream, signal first." },
  "/approvals":          { numeral: "II.",   label: "Command · Approvals", title: "Approvals",      sub: "Vendor outreach, drafted emails, and business calls waiting on your OK." },
  "/brief":              { numeral: "III.",  label: "Daily · Brief",     title: "Morning Brief",    sub: "Calendar, priorities, and what's waiting on you today." },
  "/mail":               { numeral: "III.",  label: "Daily · Mail",      title: "Work Mail",        sub: "Triaged — VIPs starred, newsletters silenced, routine handled." },
  "/tasks":              { numeral: "III.",  label: "Daily · Tasks",     title: "Tasks",            sub: "Vault-backed, synced with Google Tasks both ways." },
  "/calendar":           { numeral: "III.",  label: "Daily · Calendar",  title: "Calendar",         sub: "Your schedule at a glance." },
  "/travel":             { numeral: "V.",    label: "Life Ops · Travel", title: "Plan Travel",      sub: "Ask Clara for an itinerary — she researches and emails you the options." },
  "/research":           { numeral: "V.",    label: "Life Ops · Research", title: "Deep Research",  sub: "Point Clara at the sources — she reads all of them and answers from what's actually in them." },
  "/calls":              { numeral: "V.",    label: "Life Ops · Business Calls", title: "Business Calls", sub: "Ask Clara to call a business — she drafts the ask, you approve, she reports back." },
  "/legal":              { numeral: "V.",    label: "Life Ops · Legal & Tax", title: "Legal & Tax", sub: "Contract review and tax notes — informational, not a substitute for your attorney or CPA." },
  "/documents":          { numeral: "V.",    label: "Life Ops · Documents", title: "Documents",     sub: "Itineraries, vendor confirmations, and contract reviews — generated as real PDFs." },
  "/vault":              { numeral: "V.",    label: "Life Ops · Vault",  title: "Vault",            sub: "Clara's memory on disk — browse, edit, and link any note." },
  "/ledger":             { numeral: "V.",    label: "Life Ops · Ledger", title: "Ledger",           sub: "Every booking, sent email, and call — logged." },
  "/onboarding":         { numeral: "VI.",   label: "System · Onboarding", title: "Guided Onboarding", sub: "Teach Clara about your world, five sessions at a time." },
  "/settings/connect":   { numeral: "VI.",   label: "System · Connect",  title: "Google Connections", sub: "Link your work Google account." },
  "/sync":               { numeral: "VI.",   label: "System · Sync",     title: "Google Sync",      sub: "Tasks and contacts, both directions. Deletions never propagate." },
  "/system":             { numeral: "VI.",   label: "System · Health",   title: "System Health",    sub: "Engines, integrations, and sensitivity routing." },
};

export default function TopBar() {
  const pathname = usePathname();
  const t = TITLES[pathname] ?? TITLES["/"];
  const [time, setTime] = useState<string>("");

  useEffect(() => {
    const set = () =>
      setTime(new Date().toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit" }));
    set();
    const i = setInterval(set, 1000 * 15);
    return () => clearInterval(i);
  }, []);

  return (
    <header className="flex items-start justify-between gap-6 mb-10">
      <motion.div
        key={pathname}
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35 }}
        className="min-w-0"
      >
        <div className="eyebrow">
          <span className="num">{t.numeral}</span>
          <span className="line" />
          <span className="label">{t.label}</span>
        </div>

        <h1 className="page-title">{t.title}</h1>
        <p className="page-subtitle">{t.sub}</p>

        <div className="mt-4 status-meta">
          <span className="hand">{time}</span>
          <span className="mx-2 opacity-40">·</span>
          Local · Office
        </div>
      </motion.div>

      <div className="flex items-center gap-3 pt-2 shrink-0">
        <CommandPalette />
        <div className="hidden lg:flex items-center gap-2 px-3 py-1.5 rounded-md border border-[var(--line-soft)] text-[11px]"
             style={{ color: "var(--cream-dim)", background: "rgba(231,229,228,0.02)" }}>
          <span className="inline-flex">
            <span className="tick live" style={{ color: "var(--gold)" }} />
            <span className="tick live" style={{ color: "var(--gold-soft)", animationDelay: ".15s" }} />
            <span className="tick live" style={{ color: "var(--emerald)", animationDelay: ".3s" }} />
            <span className="tick live" style={{ color: "var(--rust)", animationDelay: ".45s" }} />
          </span>
          <span className="uppercase tracking-widest" style={{ fontWeight: 600 }}>
            All systems
          </span>
        </div>
      </div>
    </header>
  );
}
