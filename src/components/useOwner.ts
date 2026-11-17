"use client";
// Client-side owner display identity. The owner's name lives in the git-ignored owner profile
// (server-side); client components fetch it once and cache it in sessionStorage so the name
// doesn't flicker on navigation.

import { useEffect, useState } from "react";

export interface OwnerDisplay {
  name: string;
  firstName: string;
}

let inFlight: Promise<OwnerDisplay> | null = null;

function cached(): OwnerDisplay | null {
  try {
    const raw = sessionStorage.getItem("clara.owner");
    return raw ? (JSON.parse(raw) as OwnerDisplay) : null;
  } catch {
    return null;
  }
}

export function useOwner(): OwnerDisplay {
  // Start empty even when cached — reading sessionStorage in the initializer would make the
  // client's first render differ from the SSR markup (hydration mismatch).
  const [owner, setOwner] = useState<OwnerDisplay>({ name: "", firstName: "" });

  useEffect(() => {
    if (owner.name) return;
    const c = cached();
    if (c?.name) { setOwner(c); return; }
    inFlight ??= fetch("/api/owner")
      .then((r) => r.json())
      .then((j: OwnerDisplay) => {
        try { sessionStorage.setItem("clara.owner", JSON.stringify(j)); } catch { /* private mode */ }
        return j;
      })
      .catch(() => ({ name: "", firstName: "" }));
    let alive = true;
    inFlight.then((j) => { if (alive && j.name) setOwner(j); });
    return () => { alive = false; };
  }, [owner.name]);

  return owner;
}
