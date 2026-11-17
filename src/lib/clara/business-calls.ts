// Clara — approved outbound business calls: draft, place, finalize.
//
// Clara has no purchase power, so this is the general-purpose replacement for the old
// vendor-hire/travel-book/event-book money paths: when the owner wants Clara to actually talk to
// an outside business (confirm availability, ask pricing, schedule an appointment), she drafts
// what she intends to ask, waits for the owner's approve/reject via the existing SMS short-code flow,
// then places the call and reports back what she learned. She never agrees to a price or commits
// anyone to anything beyond what the business itself offers.

import { draft as approvalDraft, get as getApproval } from "./approvals";
import type { Approval } from "./approvals";
import type { PrincipalId } from "./types";
import { placeCall, twilioConfig, sayAndHangup, gather } from "./channels";
import { findBusiness, pickBestCandidate, type BusinessCandidate } from "./places";
import { listVendors } from "./vendors";
import { listContacts } from "./contacts";
import { loadConfig } from "./config";
import { deliverToPrincipal } from "./deliver";
import { complete } from "./engines";
import { CLARA_IDENTITY } from "./persona";
import { append as ledgerAppend } from "./ledger";
import {
  createSession, getSession, appendTurn, updateLearned, setStatus, endSession,
  type BusinessCallObjective,
} from "./call-sessions";
import { nextTurn, openingLine } from "./business-call-brain";
import { RECORDING_DISCLOSURE } from "./recorder";
import { OWNER_FIRST, OWNER_NAME } from "./owner";

export interface DraftBusinessCallInput {
  requestor: PrincipalId;
  businessName?: string;
  businessPhone?: string;
  category?: string;
  locationHint?: string;
  goal: string;
  mustConfirm: string[];
  context?: string;
}

interface CallBusinessIntent {
  objective: BusinessCallObjective;
  candidate?: BusinessCandidate;
}

async function resolvePhone(input: DraftBusinessCallInput): Promise<{ name: string; phone: string; candidate?: BusinessCandidate } | { error: string }> {
  if (input.businessPhone) {
    return { name: input.businessName ?? input.businessPhone, phone: input.businessPhone };
  }

  if (input.businessName) {
    const nameLower = input.businessName.toLowerCase();
    const vendorHit = (await listVendors()).find((v) => v.phone && v.name.toLowerCase().includes(nameLower));
    if (vendorHit?.phone) return { name: vendorHit.name, phone: vendorHit.phone };
    const contactHit = (await listContacts()).find((c) => c.phone && c.name.toLowerCase().includes(nameLower));
    if (contactHit?.phone) return { name: contactHit.name, phone: contactHit.phone };
  }

  const query = [input.businessName ?? input.category, input.locationHint].filter(Boolean).join(" ");
  if (!query) return { error: "no business name, phone, or category given — can't look anything up" };

  const cfg = await loadConfig();
  const locationBias = cfg.homeLat != null && cfg.homeLng != null ? { lat: cfg.homeLat, lng: cfg.homeLng } : undefined;
  const res = await findBusiness(query, locationBias ? { locationBias } : undefined);
  if (!res.ok) return { error: res.error ?? "business lookup failed" };
  const best = pickBestCandidate(res.candidates);
  if (!best?.phoneE164) return { error: `couldn't find a phone number for "${query}" — try naming the business directly` };
  return { name: best.name, phone: best.phoneE164, candidate: best };
}

export async function draftBusinessCall(input: DraftBusinessCallInput): Promise<{ approvalId: string } | { error: string }> {
  const resolved = await resolvePhone(input);
  if ("error" in resolved) return { error: resolved.error };

  const objective: BusinessCallObjective = {
    businessName: resolved.name,
    phoneE164: resolved.phone,
    goal: input.goal,
    mustConfirm: input.mustConfirm,
    context: input.context,
    requestor: input.requestor,
  };

  const summary = [
    `**Business**: ${resolved.name} (${resolved.phone})`,
    `**Why**: ${input.goal}`,
    input.mustConfirm.length ? `**Clara will ask/confirm**:\n${input.mustConfirm.map((m, i) => `${i + 1}. ${m}`).join("\n")}` : "",
    resolved.candidate ? `\n_Found via Google Places (top match). Clara won't agree to any price or schedule beyond confirming what's offered — she'll report back with what she learns._` : "",
  ].filter(Boolean).join("\n");

  const a = await approvalDraft({
    kind: "call.business",
    title: `Call ${resolved.name} — ${input.goal.slice(0, 60)}`,
    summary,
    requestor: input.requestor,
    intent: { objective, candidate: resolved.candidate } satisfies CallBusinessIntent,
  });
  return { approvalId: a.id };
}

export async function placeApprovedBusinessCall(row: Approval): Promise<{ ok: boolean; error?: string; ref?: string }> {
  const intent = row.intent as CallBusinessIntent;
  const cfg = twilioConfig();
  if (!cfg?.publicBase) return { ok: false, error: "Twilio public webhook base not configured" };
  const base = cfg.publicBase;

  const res = await placeCall(
    intent.objective.phoneE164,
    { url: `${base}/api/channels/twilio/business-call?approvalId=${encodeURIComponent(row.id)}` },
    {
      statusCallback: `${base}/api/channels/twilio/business-call/status?approvalId=${encodeURIComponent(row.id)}`,
      statusCallbackEvent: ["completed"],
      machineDetection: "Enable",
    },
  );
  if (!res.ok || !res.sid) return { ok: false, error: res.error };

  createSession(res.sid, intent.objective);
  await ledgerAppend({
    kind: "call",
    actor: "clara",
    what: `outbound business call placed to ${intent.objective.businessName} (${intent.objective.phoneE164}): ${intent.objective.goal}`,
    ref: res.sid,
    meta: { direction: "outbound", context: "business-call", approvalId: row.id },
  }).catch(() => {});
  return { ok: true, ref: res.sid };
}

// Rehydrates a session from the persisted approval if the in-memory one is missing (e.g. a
// process restart landed in the narrow window between placing the call and Twilio's first hit) —
// loses turn history, never the objective.
export async function rehydrateSession(callSid: string, approvalId: string | null) {
  const existing = getSession(callSid);
  if (existing) return existing;
  if (!approvalId) return null;
  const row = await getApproval(approvalId);
  if (!row) return null;
  const intent = row.intent as CallBusinessIntent;
  return createSession(callSid, intent.objective);
}

export function greetingTwiml(objective: BusinessCallObjective, base: string, actionPath: string): string {
  return gather(`${RECORDING_DISCLOSURE} ${openingLine(objective)}`, base, actionPath, "stranger");
}

export function voicemailTwiml(objective: BusinessCallObjective, base: string): string {
  return sayAndHangup(
    `Hi, this is Clara calling on behalf of ${OWNER_NAME} — ${objective.goal} No need to call back right away, I'll try again or ${OWNER_FIRST} will follow up. Thanks!`,
    base,
    "stranger",
  );
}

export async function handleBusinessTurn(callSid: string, businessUtterance: string, base: string, actionPath: string): Promise<string> {
  const session = getSession(callSid);
  if (!session) return sayAndHangup("Sorry, I lost track of this call — I'll follow up separately.", base, "stranger");

  appendTurn(callSid, { role: "business", text: businessUtterance, at: new Date().toISOString() });
  const result = await nextTurn(session, businessUtterance);
  appendTurn(callSid, { role: "clara", text: result.sayText, at: new Date().toISOString() });
  if (result.learnedPatch) updateLearned(callSid, result.learnedPatch);

  if (result.hangup) {
    setStatus(callSid, result.hardBlocked ? "injection-blocked" : "goal-met");
    return sayAndHangup(result.sayText, base, "stranger");
  }
  return gather(result.sayText, base, actionPath, "stranger");
}

export async function finalizeBusinessCall(callSid: string): Promise<void> {
  const session = endSession(callSid);
  if (!session) return;

  const transcript = session.turns.map((t) => `${t.role === "clara" ? "Clara" : session.objective.businessName}: ${t.text}`).join("\n");
  const prompt = `Clara just placed an outbound call to ${session.objective.businessName} to: ${session.objective.goal}
She needed to confirm: ${session.objective.mustConfirm.join("; ") || "(nothing specific)"}
Call status: ${session.status}
What was learned: ${JSON.stringify(session.learned)}

Transcript:
${transcript || "(no conversation captured — the call may have gone to voicemail or ended immediately)"}

Write a short (4-6 sentence) plain-language summary for the owner: was the objective achieved, what was confirmed for each "must confirm" item (or "not confirmed" if a gap), and any follow-up they need to do themselves. No markdown.`;

  const summary = await complete({ system: CLARA_IDENTITY, prompt, timeoutMs: 30_000 }).catch(
    () => `Call to ${session.objective.businessName} ended (${session.status}). Learned: ${JSON.stringify(session.learned)}.`,
  );

  await ledgerAppend({
    kind: "call",
    actor: "clara",
    what: summary,
    ref: callSid,
    meta: { objective: session.objective, learned: session.learned, status: session.status },
  }).catch(() => {});

  await deliverToPrincipal(
    session.objective.requestor,
    `Call outcome — ${session.objective.businessName}`,
    summary,
    `Clara's call to ${session.objective.businessName}: ${summary.slice(0, 300)}`,
  ).catch(() => {});
}
