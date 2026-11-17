"use client";
import { useEffect, useState } from "react";
import { useOwner } from "@/components/useOwner";

interface Status {
  clientConfigured: boolean;
  accounts: { account: "work"; connected: boolean; email: string | null }[];
}

export default function ConnectPage() {
  const { firstName: first } = useOwner();
  const [status, setStatus] = useState<Status | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  useEffect(() => {
    const url = new URL(window.location.href);
    const err = url.searchParams.get("err");
    const connected = url.searchParams.get("connected");
    if (err) setFlash(`Error: ${err}`);
    else if (connected) setFlash(`Connected ${connected}${url.searchParams.get("email") ? ` (${url.searchParams.get("email")})` : ""}`);
    fetch("/api/ms/status").then((r) => r.json()).then(setStatus);
  }, []);

  if (!status) return <p style={{ color: "var(--cream-dim)" }}>Loading…</p>;

  return (
    <div className="max-w-2xl">
      {flash && <div className="panel p-3 mb-4">{flash}</div>}

      {!status.clientConfigured && (
        <div className="action-card mb-4" style={{ borderColor: "rgba(245,158,11,0.35)" }}>
          <p><strong>Not yet configured.</strong> Set <code>MS_OAUTH_CLIENT_ID</code>, <code>MS_OAUTH_CLIENT_SECRET</code>,
          and <code>MS_OAUTH_TENANT_ID</code> in <code>.env.local</code> (reuse FRIDAY's Entra app registration
          if you have one — just add <code>https://clara.example.com/api/ms/callback</code> as an authorized
          redirect URI in the Entra admin center).</p>
        </div>
      )}

      <div className="space-y-4">
        {status.accounts.map((a) => (
          <div key={a.account} className="action-card flex items-center justify-between">
            <div>
              <div className="action-title">{`${first || "Owner"} — work`}</div>
              <div className="text-sm mt-1" style={{ color: "var(--cream-dim)" }}>
                {a.connected ? (a.email ?? "connected") : "not connected"}
              </div>
            </div>
            <a
              href={`/api/ms/auth?account=${a.account}`}
              className="copy-btn"
              style={{ opacity: status.clientConfigured ? 1 : 0.4, pointerEvents: status.clientConfigured ? "auto" : "none" }}
            >
              {a.connected ? "Reconnect" : "Connect"}
            </a>
          </div>
        ))}
      </div>

      <p className="mt-8 text-xs" style={{ color: "var(--cream-mute)" }}>
        The personal email and the owner's own work mailbox named in the owner profile are excluded by policy —
        Clara will refuse to store a refresh token for either.
      </p>
    </div>
  );
}
