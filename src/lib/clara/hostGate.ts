// Host-gate policy for Clara's middleware — Cloudflare Access verification + principal resolution.
//
// Extracted from middleware.ts so the strip / verify / set-marker / set-principal logic is
// unit-testable WITHOUT Next's runtime (next/server does not resolve in plain node). middleware.ts
// is the thin Next adapter that wraps evaluateGate() below.
//
// WHY THIS CHANGED. Clara previously trusted the perimeter completely: the middleware stamped
// x-clara-principal="owner" on every non-webhook request and did NO in-app check, on the assumption
// that "nothing downstream of Cloudflare Access/localhost can present [a request] from outside the
// owner's own devices." That assumption is a single point of failure — the moment the tunnel topology changes
// (a second ingress, a misconfigured proxy, a direct bind) any client that reaches the origin is
// treated as the owner and handed full access. This gate re-verifies the trust boundary INSIDE the
// app: off-loopback requests must carry a Cloudflare Access assertion that VERIFIES cryptographically
// (signature against the team JWKS + aud + iss), and everything else is blocked.
//
// TWO forgeable trust headers are stripped from every inbound request BEFORE anything else runs and
// only re-set after the request has actually earned them:
//   • x-agent-access-verified  — the cross-agent marker agent-core's verifyInteragentSecret reads;
//                                set to "1" only after JWKS verification succeeds.
//   • x-clara-principal        — Clara's identity header route handlers read instead of a
//                                client-supplied `requestor` field; set to "owner" only for a
//                                request that is loopback-local or a verified owner.
// If either were trusted from the client, a caller could assert it directly and bypass the boundary.

import { jwtVerify, createRemoteJWKSet } from "jose";
import { PRINCIPAL_HEADER } from "@/lib/clara/session";

// The cross-agent trusted marker. MUST match agent-core's exported ACCESS_VERIFIED_HEADER.
export const ACCESS_VERIFIED_HEADER = "x-agent-access-verified";

// Twilio calls these directly — authenticated by twilioSignatureValid() inside the route, not by a
// verified principal (there is no logged-in owner on the other end of these calls). They
// must stay reachable off-loopback (Twilio has no Cloudflare Access assertion) and never receive a
// principal header.
const TWILIO_INBOUND_PATHS = new Set<string>([
  "/api/channels/twilio/voice",
  "/api/channels/twilio/voice/whisper",      // warm-transfer whisper (Autonomy Spec v0.1 #10)
  "/api/channels/twilio/voice/dial-status",  // warm-transfer dial action callback
  "/api/channels/twilio/screen",
  "/api/channels/twilio/sms",
  "/api/channels/twilio/tts",       // signed via its own HMAC'd URL — Twilio doesn't sign media fetches
  "/api/channels/twilio/recording", // signature-checked inside the route (see fix for finding #2)
  "/api/channels/twilio/business-call",        // outbound business-call conversation webhook
  "/api/channels/twilio/business-call/status", // outbound business-call status callback
  "/api/channels/twilio/owner-call",           // the 08:30 morning call to the owner (owner-call.ts)
  "/api/channels/twilio/owner-call/status",    // its end-of-call status callback (retry / finalize)
  "/api/channels/twilio/voice/status",         // end-of-call status callback (files the lead / work-line message)
  "/api/channels/twilio/voice/whisper/accept", // The owner's press-1 on a warm-transfer whisper (workLine.ts)
  "/api/channels/twilio/connect",              // "connect me to X" — the owner's leg of a click-to-call (clickToCall.ts)
  // Text-to-accept hold transfer on the work line (holdTransfer.ts, 2026-09-29): the caller's hold
  // loop and queue exit, where they land when the owner passes, and the leg to their cell.
  "/api/channels/twilio/voice/hold/wait",
  "/api/channels/twilio/voice/hold/done",
  "/api/channels/twilio/voice/hold/return",
  "/api/channels/twilio/voice/hold/answer",
  "/api/channels/twilio/voice/hold/bridged",
  "/api/channels/twilio/voice/hold/owner-done",
  "/api/channels/twilio/voice/hold/owner-status",
  "/api/channels/twilio/hold-audio",           // The owner's hold audio — <Play> fetches media unsigned; open by design
  // Not Twilio: BlueBubbles on a Mac (work-phone texts). Authenticated by the shared
  // secret in its URL inside the route, and 404s when no secret is configured.
  "/api/channels/imessage",
]);

// Google's (and Wispr Flow's MCP) OAuth redirects hit these directly with no prior session — the
// code-exchange itself is the authentication event.
const OAUTH_PATHS = new Set<string>(["/api/google/callback", "/api/meetings/wispr/callback"]);

// Escape hatch for extra public paths, comma-separated. NOTE: Next inlines process.env in the
// middleware bundle at BUILD time — changing this needs a rebuild, not just a restart.
const EXTRA = (process.env.CLARA_PUBLIC_PATHS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function isPublicPath(pathname: string): boolean {
  return TWILIO_INBOUND_PATHS.has(pathname) || OAUTH_PATHS.has(pathname) || EXTRA.includes(pathname);
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

// Strip the port and any IPv6 brackets, then test against the loopback set.
export function isLoopbackHost(raw: string | null): boolean {
  if (!raw) return false;
  const host = raw.trim().toLowerCase();
  const hostname = host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.split(":")[0];
  return LOOPBACK.has(hostname);
}

// ── Cloudflare Access JWT verification ──────────────────────────────────────
// Verify the assertion is a valid JWT for THIS Access application: signature vs the team JWKS,
// `aud` === this app's AUD tag, `iss` === the team domain. Presence alone is never enough.
const CF_ACCESS_TEAM_DOMAIN = process.env.CF_ACCESS_TEAM_DOMAIN?.trim();
const CF_ACCESS_AUD = process.env.CF_ACCESS_AUD?.trim();
const CF_ISSUER = CF_ACCESS_TEAM_DOMAIN ? `https://${CF_ACCESS_TEAM_DOMAIN}` : "";

// createRemoteJWKSet fetches the keys once and caches them (refetching only on an unknown kid, with
// a cooldown) — so we do not hit Cloudflare on every request.
let cfJwks: ReturnType<typeof createRemoteJWKSet> | null = null;
function cfKeySet() {
  if (!cfJwks) cfJwks = createRemoteJWKSet(new URL(`${CF_ISSUER}/cdn-cgi/access/certs`));
  return cfJwks;
}

async function accessJwtValid(token: string): Promise<boolean> {
  // Fail closed when unconfigured: without both values we cannot verify, so we must NOT fall back to
  // trusting the header's presence.
  if (!CF_ACCESS_TEAM_DOMAIN || !CF_ACCESS_AUD) return false;
  try {
    await jwtVerify(token, cfKeySet(), { issuer: CF_ISSUER, audience: CF_ACCESS_AUD });
    return true;
  } catch {
    return false; // bad signature, wrong aud/iss, expired, or JWKS fetch failed
  }
}

/**
 * Decide whether a request may pass, and produce the request headers to forward to route handlers.
 *
 * SECURITY: `forwardHeaders` always has BOTH client-supplied trust headers (ACCESS_VERIFIED_HEADER
 * and PRINCIPAL_HEADER) **stripped** first — they are never trusted from the client. The access
 * marker is set to "1" ONLY after JWKS verification succeeds; the principal is set to "owner" ONLY
 * for a loopback-local request or a verified owner (Cloudflare Access enforces the owner-only policy
 * on the public hostname, so a verified assertion proves the caller is the owner). Twilio/OAuth public
 * paths pass through with their own auth and never receive a principal. `allow: false` means the
 * caller should return 404.
 */
export async function evaluateGate(
  headers: Headers,
  pathname: string,
): Promise<{ allow: boolean; forwardHeaders: Headers }> {
  const forwardHeaders = new Headers(headers);
  forwardHeaders.delete(ACCESS_VERIFIED_HEADER);
  forwardHeaders.delete(PRINCIPAL_HEADER);

  const publicPath = isPublicPath(pathname);

  // Both Host and X-Forwarded-Host must be loopback-or-absent (fail-closed against a proxy that
  // preserves Host while signalling the real origin via X-Forwarded-Host).
  const host = headers.get("host");
  const forwarded = headers.get("x-forwarded-host");
  const local = isLoopbackHost(host) && (forwarded === null || isLoopbackHost(forwarded));
  if (local) {
    // Local access already implies full access to the machine; the dashboard is the owner-only.
    if (!publicPath) forwardHeaders.set(PRINCIPAL_HEADER, "owner");
    return { allow: true, forwardHeaders };
  }

  // Off-loopback: Twilio/OAuth authenticate themselves inside the route; no principal is stamped.
  if (publicPath) return { allow: true, forwardHeaders };

  // Off-loopback, non-public: require a cryptographically verified Cloudflare Access assertion.
  const assertion = headers.get("cf-access-jwt-assertion");
  if (assertion && (await accessJwtValid(assertion))) {
    forwardHeaders.set(ACCESS_VERIFIED_HEADER, "1");
    forwardHeaders.set(PRINCIPAL_HEADER, "owner"); // Access owner-only policy ⇒ the verified caller is the owner
    return { allow: true, forwardHeaders };
  }

  return { allow: false, forwardHeaders };
}
