"use client";

// Entry point for the one-time clara@ AGENT sign-in (vs /api/os/auth, which captures the owner's owner
// session). Supabase's redirect_to must stay byte-identical to the allowlisted capture URL, so the
// "which vault does this session belong in" choice can't ride the OAuth round-trip as a query
// param. Instead it rides sessionStorage: per-tab, survives the cross-site redirect chain, and is
// read + cleared by the capture page, which then tells the callback to persist into the agent
// vault (~/.agentic-os/clara/agent). Sign in with clara@example.com — use a private window if
// the browser is already signed into the owner's Google. See docs/os-agent-auth.md.
import { useEffect } from "react";

export default function OsAgentAuthStart() {
  useEffect(() => {
    sessionStorage.setItem("os-auth-target", "agent");
    window.location.replace("/api/os/auth");
  }, []);

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: 40, maxWidth: 560 }}>
      <h1 style={{ fontSize: 20, marginBottom: 12 }}>orion agent connection</h1>
      <p>Redirecting to Google sign-in — authenticate as clara@example.com…</p>
    </main>
  );
}
