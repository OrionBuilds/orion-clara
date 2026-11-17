"use client";

import { motion } from "framer-motion";
import type { ReactNode } from "react";

interface Props {
  title: string;
  icon?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}

// Clara has one brand voice (unlike FRIDAY's per-agent accent variants), so this is a
// simplified port of FRIDAY's Panel.tsx — same shape, single accent color.
export default function Panel({ title, icon, actions, children, className = "" }: Props) {
  return (
    <motion.section
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.45, ease: "easeOut" }}
      className={`panel panel-hover flex flex-col ${className}`}
    >
      <header className="flex items-center justify-between px-5 pt-4 pb-3 border-b border-[var(--panel-border)]">
        <h2 className="heading-strip text-sm font-medium tracking-wide flex items-center gap-2" style={{ color: "var(--gold)" }}>
          {icon}
          <span>{title}</span>
        </h2>
        <div className="flex items-center gap-2">{actions}</div>
      </header>
      <div className="flex-1 min-h-0 p-5">{children}</div>
    </motion.section>
  );
}
