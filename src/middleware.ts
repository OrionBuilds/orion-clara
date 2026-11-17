// Clara host gate (thin Next adapter) — Cloudflare Access verification + principal resolution.
//
// Clara's origin (127.0.0.1:3939) is never exposed to the network directly — it is reachable either
// (1) locally on this machine, or (2) through the Cloudflare Tunnel behind Cloudflare Access's
// owner-only policy on the public hostname. Previously the middleware TRUSTED that perimeter
// completely: it stamped a principal on every non-webhook request and did no in-app check. This gate
// now re-verifies the boundary inside the app — off-loopback requests must carry a Cloudflare Access
// assertion that VERIFIES cryptographically (signature + aud + iss), everything else 404s (not 403 —
// a 403 confirms the route exists). Twilio inbound webhooks stay reachable (they authenticate via
// their own request signature inside the route), and local access is unchanged.
//
// All the policy — loopback test, JWKS verification, the strip/set of the x-agent-access-verified
// marker and the x-clara-principal header — lives in ./lib/clara/hostGate so it can be unit-tested
// without Next's runtime (see hostGate.test.ts). This file is only the Next wiring.
//
// Runs in the Node.js middleware runtime (stable since Next 15.2).

import { NextResponse, type NextRequest } from "next/server";
import { evaluateGate } from "@/lib/clara/hostGate";

export const config = {
  runtime: "nodejs",
  matcher: [
    // Everything except Next internals and static files.
    "/((?!_next/static|_next/image|favicon.ico).*)",
  ],
};

export async function middleware(req: NextRequest): Promise<NextResponse> {
  const { allow, forwardHeaders } = await evaluateGate(req.headers, req.nextUrl.pathname);
  if (allow) return NextResponse.next({ request: { headers: forwardHeaders } });

  console.warn(`[host-gate] blocked ${req.method} ${req.nextUrl.pathname} from host=${req.headers.get("host") ?? "(none)"}`);
  return new NextResponse("Not Found", { status: 404 });
}
