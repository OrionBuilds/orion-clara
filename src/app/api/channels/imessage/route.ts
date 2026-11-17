// BlueBubbles webhook — texts to the owner's WORK phone, relayed by a Mac (bluebubbles.ts).
// In BlueBubbles Server › API & Webhooks, add a webhook for "New Messages" pointing at:
//   <public base>/api/channels/imessage?secret=<BLUEBUBBLES_WEBHOOK_SECRET>
//
// BlueBubbles can't sign a request or add a header, so the shared secret in the URL is the whole
// authentication; it's compared in constant time and the route 404s without it — including when the
// secret isn't configured at all, so an unconfigured install exposes nothing.
//
// Instant 200, real work detached: BlueBubbles doesn't retry, and replies wait up to a minute on
// purpose (the owner may answer first — workLineTexts.ts).

import { ensureBootstrapped } from "@/lib/clara/bootstrap";
import { webhookSecretOk } from "@/lib/clara/bluebubbles";
import { handleRelayEvent } from "@/lib/clara/workLineTexts";
import { handleInboundSms } from "../twilio/sms/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const url = new URL(req.url);
  const provided = url.searchParams.get("secret") ?? req.headers.get("x-clara-secret");
  if (!webhookSecretOk(provided)) return new Response("Not Found", { status: 404 });

  let body: unknown = null;
  try { body = await req.json(); } catch { return new Response("bad json", { status: 400 }); }

  await ensureBootstrapped();
  void handleRelayEvent(body, { onOwner: handleInboundSms }).catch(() => {});
  return new Response("ok", { status: 200 });
}
