// Clara — "connect me to X". 
//
// The owner's work number stays on their iPhone, but when they're out with only their personal cell they still
// want people to see a work number. Clara rings their personal cell first; when they answer she dials
// X and bridges them, with the caller ID set to:
//   * their real work number, once it is verified in Twilio as an outgoing caller ID (Twilio won't
//     present an unverified number) — flagged with OWNER_WORK_PHONE_VERIFIED=1;
//   * otherwise the work-line number (CLARA_WORKLINE_NUMBER), which forwards back to Clara if they
//     call it later;
//   * otherwise Clara's own number.

import { esc } from "./channels";
import { normalizeE164 } from "./ownerPhones";

type Env = Record<string, string | undefined>;

export function connectCallerId(env: Env = process.env): string | undefined {
  const work = env.OWNER_WORK_PHONE?.trim();
  if (work && /^(1|true|yes)$/i.test(env.OWNER_WORK_PHONE_VERIFIED?.trim() ?? "")) return work;
  return env.CLARA_WORKLINE_NUMBER?.trim() || env.CLARA_TWILIO_NUMBER?.trim() || undefined;
}

/** Pure: a dialable number from free text, or null. "813-555-0100" → "+18135550100"; "ext 12" → null. */
export function toE164(raw: string): string | null {
  return normalizeE164(raw);
}

/**
 * What the owner's leg hears first: who they're being connected to, and "press 1". Their voicemail can't press
 * a key, so a call that rolls to voicemail never dials the other person into it.
 */
export function connectPromptTwiml(opts: { acceptUrl: string; speakXml: string }): string {
  return `<Response><Gather input="dtmf" numDigits="1" timeout="8" action="${esc(opts.acceptUrl)}" method="POST">${opts.speakXml}</Gather><Hangup/></Response>`;
}

/** After they press 1: dial them in with the chosen caller ID. */
export function connectDialTwiml(opts: { number: string; callerId?: string; speakXml?: string }): string {
  return `<Response>${opts.speakXml ?? ""}` +
    `<Dial timeout="30"${opts.callerId ? ` callerId="${esc(opts.callerId)}"` : ""}><Number>${esc(opts.number)}</Number></Dial></Response>`;
}

/** Resolve a name or number to someone Clara can dial: the owner's contacts first, then the OS. */
export async function resolveCallee(query: string): Promise<{ number: string; label: string } | null> {
  const direct = toE164(query);
  if (direct) return { number: direct, label: query.trim() };
  const q = query.trim().toLowerCase();
  if (!q) return null;
  const { listContacts } = await import("./contacts");
  // Only contacts whose number actually dials — an "ext 123" or a short number would ring the owner for nothing.
  const local = (await listContacts().catch(() => []))
    .filter((c) => c.name.toLowerCase().includes(q))
    .map((c) => ({ number: toE164(c.phone ?? ""), label: c.name }))
    .filter((c): c is { number: string; label: string } => c.number !== null);
  if (local.length === 1) return local[0];
  if (local.length > 1) return null;
  const { osClient, osEnabled } = await import("./osClient");
  if (!osEnabled()) return null;
  const { unwrap, rowsOf } = await import("./osUnwrap");
  const rows = rowsOf<{ first_name?: string; last_name?: string; phone?: string | null }>(
    unwrap(await osClient.callTool("contacts_list", { search: query, limit: 5 }).catch(() => [])),
  );
  const dialable = rows
    .map((r) => ({ number: toE164(r.phone ?? ""), label: `${r.first_name ?? ""} ${r.last_name ?? ""}`.trim() || query }))
    .filter((r): r is { number: string; label: string } => r.number !== null);
  return dialable.length === 1 ? dialable[0] : null;
}

/** Place the call to the owner's personal cell that then connects them to `query`. */
export async function connectMeTo(query: string): Promise<{ ok: boolean; line: string }> {
  const callee = await resolveCallee(query);
  if (!callee) return { ok: false, line: `Call: I couldn't find a single number for "${query}". Give me the number or the full name.` };
  const { ownerDeliveryPhone } = await import("./ownerPhones");
  const me = await ownerDeliveryPhone();
  if (!me) return { ok: false, line: "Call: no number on file to reach you on." };
  const { twilioConfig, placeCall } = await import("./channels");
  const base = twilioConfig()?.publicBase;
  if (!base) return { ok: false, line: "Call: CLARA_PUBLIC_WEBHOOK_BASE isn't set, so Twilio can't reach me to connect the call." };
  const qs = new URLSearchParams({ to: callee.number, label: callee.label.slice(0, 60) });
  const r = await placeCall(me, { url: `${base}/api/channels/twilio/connect?${qs.toString()}` }, { timeoutSec: 25 });
  return r.ok
    ? { ok: true, line: `Call: ringing you now — answer, press 1, and I'll connect you to ${callee.label}.` }
    : { ok: false, line: `Call: couldn't place it — ${r.error ?? "unknown error"}.` };
}
