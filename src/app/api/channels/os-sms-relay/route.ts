// OS → Clara SMS relay. The owner's control channel, after inbound SMS moved to the OS edge rail.
//
// Why this exists: Clara's business number now points its SmsUrl at the OS's twilio-sms-inbound so that
// texts from prospects become CRM contacts and get the clara-sms-responder guardrails (DNC, quiet
// hours, reply cap). But the owner's own texts are not leads — they are commands. sitrep, budget and
// run-cap grants, autonomy dials, remote restart, cross-agent routing: all of it lives in this app,
// behind resolveByPhone, and clara-sms-responder implements none of it. Without this route,
// "restart friday" would be answered by a sales bot.
//
// So twilio-sms-inbound splits on the sender: a principal's message is relayed here and never
// written to the CRM, everyone else takes the existing CRM path.
//
// AUTH IS FAIL-CLOSED, and deliberately does NOT use verifyInteragentSecret(). That helper returns
// TRUE when no secret is configured (auth intentionally off for local dev) and its documented trust
// boundary is "sibling agents on 127.0.0.1". Neither holds here: this request crosses the public
// internet from Supabase, and the endpoint can restart services. A misconfiguration must make the
// relay refuse, not make it open. Transport is additionally gated by Cloudflare Access on the
// tunnel; this check is the application layer under it.

import { ensureBootstrapped } from "@/lib/clara/bootstrap";
import { handleInboundSms } from "../twilio/sms/route";
import { append as ledgerAppend } from "@/lib/clara/ledger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const HEADER = "x-os-relay-secret";

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** True only when a secret IS configured and the header matches it. Unset secret → reject. */
function relayAuthorized(req: Request): { ok: boolean; reason?: string } {
  const secret = (process.env.OS_SMS_RELAY_SECRET || process.env.INTERAGENT_SHARED_SECRET || "").trim();
  if (!secret) return { ok: false, reason: "no relay secret configured on this side" };
  const presented = (req.headers.get(HEADER) || "").trim();
  if (!presented) return { ok: false, reason: "missing relay secret header" };
  return timingSafeEqual(presented, secret) ? { ok: true } : { ok: false, reason: "relay secret mismatch" };
}

export async function POST(req: Request) {
  await ensureBootstrapped();

  const auth = relayAuthorized(req);
  if (!auth.ok) {
    // Logged, because a rejected relay means the owner texted a command and it did not run — the kind
    // of silence that otherwise looks identical to "they didn't text".
    await ledgerAppend({
      kind: "action", actor: "clara",
      what: `OS SMS relay rejected: ${auth.reason}`,
      meta: { rejected: "relay-auth" },
    }).catch(() => {});
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const payload = await req.json().catch(() => null) as { From?: string; Body?: string; MessageSid?: string } | null;
  const from = (payload?.From ?? "").trim();
  const body = (payload?.Body ?? "").trim();
  if (!from || !body) {
    return Response.json({ ok: false, error: "From and Body are required" }, { status: 400 });
  }

  // Same brain as a direct Twilio webhook — literally the same function, not a reimplementation.
  // Fire-and-forget: the reply goes out as its own outbound SMS, so the OS gets an immediate ACK
  // rather than holding a connection open across a model call.
  handleInboundSms({ From: from, Body: body, MessageSid: payload?.MessageSid ?? "" });

  return Response.json({ ok: true, relayed: true });
}
