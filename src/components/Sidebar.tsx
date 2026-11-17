"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { motion } from "framer-motion";
import {
  LayoutGrid, Mail, CalendarDays,
  Plane, Receipt, ClipboardList, Plug, Activity, FileText, Phone, RefreshCw,
  GripVertical, Eye, EyeOff, SlidersHorizontal, Check, Menu, X, Microscope, ListChecks, BookOpen, Inbox,
} from "lucide-react";
import { useState, useEffect, type ReactNode } from "react";
import { useSidebarNav } from "@autom8ionlab/agent-core";
import { useOwner } from "./useOwner";

interface NavItem {
  href: string;
  label: string;
  icon: ReactNode;
  accent: string;
  dim: string;
}

// Clara — one flat NAV array, section computed by sectionOf() rather than stored per item, one
// shared brand accent (matches FRIDAY's current "brand purity" convention — a single hue for the
// whole nav, not one per item). Drag/reorder/hide/persist state lives in the shared
// useSidebarNav() hook (@autom8ionlab/agent-core) — this file only owns the nav content and
// markup.
const ACCENT = "#0891b2";                  // cyan-600 — Clara brand primary
const DIM = "rgba(8,145,178,0.16)";        // cyan-600 @ 16%
const NAV: NavItem[] = [
  { href: "/",            label: "Home",          icon: <LayoutGrid size={16} />,     accent: ACCENT, dim: DIM },
  { href: "/inbox",       label: "Inbox",         icon: <Inbox size={16} />,          accent: ACCENT, dim: DIM },
  // Daily
  { href: "/mail",        label: "Mail",          icon: <Mail size={16} />,           accent: ACCENT, dim: DIM },
  { href: "/tasks",       label: "Tasks",         icon: <ListChecks size={16} />,     accent: ACCENT, dim: DIM },
  { href: "/calendar",    label: "Calendar",      icon: <CalendarDays size={16} />,   accent: ACCENT, dim: DIM },
  // Life Ops
  { href: "/travel",      label: "Travel",        icon: <Plane size={16} />,          accent: ACCENT, dim: DIM },
  { href: "/research",    label: "Deep Research", icon: <Microscope size={16} />,     accent: ACCENT, dim: DIM },
  { href: "/calls",       label: "Business Calls", icon: <Phone size={16} />,         accent: ACCENT, dim: DIM },
  { href: "/legal",       label: "Legal & Tax",   icon: <Receipt size={16} />,        accent: ACCENT, dim: DIM },
  { href: "/documents",   label: "Documents",     icon: <FileText size={16} />,       accent: ACCENT, dim: DIM },
  { href: "/vault",       label: "Vault",         icon: <BookOpen size={16} />,       accent: ACCENT, dim: DIM },
  { href: "/ledger",      label: "Ledger",        icon: <Receipt size={16} />,        accent: ACCENT, dim: DIM },
  // System
  { href: "/onboarding",       label: "Onboarding",  icon: <ClipboardList size={16} />, accent: ACCENT, dim: DIM },
  { href: "/settings/connect", label: "Connect",     icon: <Plug size={16} />,          accent: ACCENT, dim: DIM },
  { href: "/sync",             label: "Google Sync", icon: <RefreshCw size={16} />,     accent: ACCENT, dim: DIM },
  { href: "/system",           label: "System",      icon: <Activity size={16} />,      accent: ACCENT, dim: DIM },
];

const BY_HREF: Record<string, NavItem> = Object.fromEntries(NAV.map((n) => [n.href, n]));
const DAILY_ROUTES = new Set(["/mail", "/tasks", "/calendar"]);
const LIFE_OPS_ROUTES = new Set(["/travel", "/research", "/calls", "/legal", "/documents", "/vault", "/ledger"]);

function sectionOf(href: string): string {
  if (DAILY_ROUTES.has(href)) return "Daily";
  if (LIFE_OPS_ROUTES.has(href)) return "Life Ops";
  if (href === "/onboarding" || href === "/settings/connect" || href === "/sync" || href === "/system") return "System";
  return "Command";
}
const SECTION_ORDER = ["Command", "Daily", "Life Ops", "System"];

export default function Sidebar() {
  const owner = useOwner();
  const pathname = usePathname();
  const {
    list, customize, setCustomize, isHidden, isOver, toggleHidden, reset,
    onDragStart, onDragEnter, onDrop, onDragEnd, onDragEnterEnd, onDropEnd, sectionLabelAt,
  } = useSidebarNav(NAV, sectionOf, SECTION_ORDER, "clara");

  return (
    <aside className="hidden md:flex flex-col w-[244px] shrink-0 h-full overflow-hidden py-6 border-r border-[var(--line-soft)]"
           style={{ background: "var(--bg-mid)" }}>
      <Link href="/" className="block mb-7 px-5 shrink-0">
        <div className="text-[10px] uppercase tracking-[0.25em] mb-1" style={{ color: "var(--cream-mute)", fontWeight: 600 }}>
          {owner.name || "\u00A0"}
        </div>
        <div className="text-xl tracking-tight" style={{ fontWeight: 500, color: "var(--cream)" }}>
          Clara
        </div>
      </Link>

      <div className="flex-1 min-h-0 overflow-y-auto scroll">
        <div className="px-5 pb-1.5 flex items-center justify-between">
          <span className="sidebar-section-label">Command</span>
          <div className="flex items-center gap-2">
            {customize && (
              <button onClick={reset} title="Reset to default order" className="text-[9px] uppercase tracking-[0.15em] hover:opacity-100 opacity-70 transition" style={{ color: "var(--cream-dim)" }}>
                Reset
              </button>
            )}
            <button
              onClick={() => setCustomize((c) => !c)}
              title={customize ? "Done customizing" : "Customize sidebar — drag to reorder, hide items"}
              className="grid place-items-center w-6 h-6 rounded-md transition"
              style={{ color: customize ? "var(--gold)" : "var(--cream-dim)", background: customize ? "rgba(8,145,178,0.14)" : "transparent" }}
            >
              {customize ? <Check size={14} /> : <SlidersHorizontal size={14} />}
            </button>
          </div>
        </div>
        {customize && (
          <div className="px-5 pb-2 text-[10px] leading-snug" style={{ color: "var(--cream-mute)" }}>
            Drag <GripVertical size={10} className="inline -mt-0.5" /> to reorder · tap the eye to hide
          </div>
        )}

        <nav className="flex flex-col gap-0.5 relative">
          {list.map((href, i) => {
            const item = BY_HREF[href];
            if (!item) return null;
            const sectionLabel = sectionLabelAt(i);
            const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
            const hiddenItem = isHidden(href);
            const over = isOver(href);

            return (
              <div key={href}>
                {sectionLabel && (
                  <div className="sidebar-section-label mt-5 mb-1.5 px-5">{sectionLabel}</div>
                )}

                {customize ? (
                  <div
                    draggable
                    onDragStart={() => onDragStart(href)}
                    onDragEnter={() => onDragEnter(href)}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={() => onDrop(href)}
                    onDragEnd={onDragEnd}
                    className="sidebar-item relative group flex items-center gap-2 py-2.5 px-3 mx-2 rounded-lg cursor-grab active:cursor-grabbing"
                    style={{
                      opacity: hiddenItem ? 0.4 : 1,
                      borderTop: over ? "2px solid var(--gold)" : "2px solid transparent",
                      background: over ? "rgba(8,145,178,0.08)" : "transparent",
                    }}
                  >
                    <GripVertical size={14} style={{ color: "var(--cream-mute)" }} className="shrink-0" />
                    <span className="shrink-0 grid place-items-center w-7 h-7 rounded-md" style={{ color: "var(--cream-dim)" }}>{item.icon}</span>
                    <span className="flex-1 truncate" style={{ textDecoration: hiddenItem ? "line-through" : "none" }}>{item.label}</span>
                    <button
                      onClick={() => toggleHidden(href)}
                      title={hiddenItem ? "Show" : "Hide"}
                      className="shrink-0 grid place-items-center w-6 h-6 rounded-md transition hover:bg-[rgba(255,255,255,0.06)]"
                      style={{ color: hiddenItem ? "var(--cream-mute)" : "var(--gold)" }}
                    >
                      {hiddenItem ? <EyeOff size={14} /> : <Eye size={14} />}
                    </button>
                  </div>
                ) : (
                  <Link href={href} className={`sidebar-item relative group flex items-center gap-3 py-2.5 px-5 ${active ? "active" : ""}`}>
                    {active && (
                      <motion.span
                        layoutId="nav-indicator"
                        className="absolute left-0 top-1/2 -translate-y-1/2 w-[2px] h-[22px]"
                        style={{ background: "var(--gold)", boxShadow: "0 0 10px var(--gold)" }}
                        transition={{ type: "spring", stiffness: 380, damping: 30 }}
                      />
                    )}
                    <span className="shrink-0 grid place-items-center w-7 h-7 rounded-md transition" style={{ color: active ? "var(--gold)" : "var(--cream-dim)" }}>
                      {item.icon}
                    </span>
                    <span>{item.label}</span>
                  </Link>
                )}
              </div>
            );
          })}
          {customize && (
            <div
              onDragEnter={onDragEnterEnd}
              onDragOver={(e) => e.preventDefault()}
              onDrop={onDropEnd}
              className="h-6 mx-2 rounded-lg"
              style={{ borderTop: isOver("__end__") ? "2px solid var(--gold)" : "2px solid transparent" }}
            />
          )}
        </nav>
      </div>

      <div className="shrink-0 pt-6 mx-5 border-t border-[var(--line-soft)]">
        <div className="sidebar-section-label mt-4 mb-2">Wired</div>
        <div className="text-[11px] leading-relaxed mono" style={{ color: "var(--cream-dim)" }}>
          claude · lm studio<br />
          twilio · elevenlabs · google<br />
          + Obsidian vault
        </div>
      </div>
    </aside>
  );
}

// Mobile bottom bar: desktop sidebar hidden below `md` — 4 primary destinations + a "More" sheet.
export function MobileNav() {
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => { setMenuOpen(false); }, [pathname]);

  const isActive = (href: string) => (href === "/" ? pathname === "/" : pathname.startsWith(href));
  const primary = ["/", "/inbox", "/mail", "/tasks"].map((h) => BY_HREF[h]).filter(Boolean);

  return (
    <>
      <nav className="md:hidden z-40 panel panel-hot px-2 py-1.5 flex gap-1"
        style={{ position: "fixed", bottom: 12, left: "50%", transform: "translateX(-50%)", maxWidth: "calc(100vw - 1.5rem)" }}>
        {primary.map((item) => {
          const active = isActive(item.href);
          return (
            <Link key={item.href} href={item.href}
              className="grid place-items-center w-12 h-11 rounded-lg transition"
              style={{ background: active ? item.dim : "transparent", color: active ? item.accent : "var(--fg-dim)" }}>
              {item.icon}
            </Link>
          );
        })}
        <button onClick={() => setMenuOpen(true)} aria-label="More navigation"
          className="grid place-items-center w-12 h-11 rounded-lg transition"
          style={{ color: menuOpen ? "var(--gold)" : "var(--fg-dim)" }}>
          <Menu size={18} />
        </button>
      </nav>

      {menuOpen && (
        <div className="md:hidden fixed inset-0 z-50" onClick={() => setMenuOpen(false)}>
          <div className="absolute inset-0" style={{ background: "rgba(0,0,0,0.55)", backdropFilter: "blur(2px)" }} />
          <div className="absolute bottom-0 left-0 right-0 max-h-[82vh] overflow-y-auto rounded-t-2xl p-4 pb-8"
            style={{ background: "var(--bg-mid)", borderTop: "1px solid var(--line-soft)" }}
            onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3">
              <span className="sidebar-section-label">Navigate</span>
              <button onClick={() => setMenuOpen(false)} aria-label="Close menu"
                className="grid place-items-center w-8 h-8 rounded-lg" style={{ color: "var(--cream-dim)" }}>
                <X size={16} />
              </button>
            </div>
            {["Command", "Daily", "Life Ops", "System"].map((sec) => {
              const secItems = NAV.filter((n) => sectionOf(n.href) === sec);
              if (!secItems.length) return null;
              return (
                <div key={sec} className="mb-3">
                  <div className="sidebar-section-label mb-1.5">{sec}</div>
                  <div className="grid grid-cols-2 gap-1.5">
                    {secItems.map((item) => {
                      const active = isActive(item.href);
                      return (
                        <Link key={item.href} href={item.href} onClick={() => setMenuOpen(false)}
                          className="flex items-center gap-2.5 py-2.5 px-3 rounded-lg transition"
                          style={{ background: active ? item.dim : "rgba(255,255,255,0.03)", color: active ? item.accent : "var(--cream)" }}>
                          <span className="shrink-0 grid place-items-center w-6 h-6">{item.icon}</span>
                          <span className="text-[13px] truncate">{item.label}</span>
                        </Link>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </>
  );
}
