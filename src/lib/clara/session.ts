// Clara — principal header.
//
// No password/session layer (see middleware.ts for why). The middleware resolves every web
// request to "owner" and stamps it on this header; route handlers read it here instead of
// trusting a client-supplied `requestor` field, which is what actually matters for closing the
// client-asserted-identity finding — the header itself doesn't need to be secret, since nothing
// downstream of Cloudflare Access/localhost can present it from outside anyway.

import type { PrincipalId } from "./types";

export const PRINCIPAL_HEADER = "x-clara-principal";

export function principalFromHeaders(headers: Headers): PrincipalId | null {
  const v = headers.get(PRINCIPAL_HEADER);
  // Executive-assistant-only: the owner is the only
  // principal the web/header path recognizes.
  return v === "owner" ? v : null;
}
