// Live operational picture across all three agents — the same data Clara answers "status" with
// over SMS, exposed as JSON so it can be read from the OS, a dashboard, or a terminal without
// sending a text to find out.
//
// Sits beside /api/system/health and follows its guard model. That model is the tunnel plus
// Cloudflare Access, not per-route auth: this box binds to 127.0.0.1 and the only public path in
// is the Access-gated tunnel. Worth stating because this endpoint reports pending-approval counts
// and which agents are down, which is more than health/ exposes.
//
// `?format=sms` returns exactly the string Clara would text, so the phone reply can be verified
// without waiting on Twilio.

import { NextResponse } from "next/server";
import { ensureBootstrapped } from "@/lib/clara/bootstrap";
import { gatherSitrep, formatSitrepSms } from "@/lib/clara/sitrep";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  await ensureBootstrapped();
  const sitrep = await gatherSitrep();
  if (new URL(req.url).searchParams.get("format") === "sms") {
    return new NextResponse(formatSitrepSms(sitrep), {
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
  return NextResponse.json({ ...sitrep, sms: formatSitrepSms(sitrep) });
}
