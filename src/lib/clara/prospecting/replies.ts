// replies.ts — PR 16: reply detection + classification + routing (plan Part 6 §4), for both
// channels a prospect can answer on.
//
// Gmail tick (every 10 min, scheduler.ts): search `newer_than:2d -label:Clara/Prospects`, resolve
// each candidate to its enrollment via outreachEventsLookup (provider_message_id from
// In-Reply-To/References, else the sender's own address), classify, route, then label the thread
// Clara/Prospects so it's never re-processed.
//
// SMS: the Twilio inbound route (src/app/api/channels/twilio/sms/route.ts) calls
// handleInboundSmsReply() directly for a number that resolves to an active enrollment — same
// classifier, same routing table.
//
// Classification: deterministic first (DSN/bounce, Auto-Submitted/OOO, the CAN-SPAM opt-out
// pattern already in compliance.ts), then tier-1 local JSON, escalating to tier-3 once when tier-1
// confidence is under 0.7, else "unknown". Routing then runs off ROUTING_TABLE — a single pure data
// structure, directly assertable in tests — never a scattered if/else per class.

import { runTier as runTierReal } from "./llm";
import { OPTOUT_RE } from "./compliance";
import {
  outreachEventsLookup as outreachEventsLookupReal, outreachEventsAdd as outreachEventsAddReal,
  suppressionsAdd as suppressionsAddReal, factsAdd as factsAddReal,
  type OutreachEventsLookupResult,
} from "./osBridge";
import { osClient } from "../osClient";
import { textOwnerImportant as textOwnerImportantReal } from "../importantText";
import { searchMessages as searchMessagesReal, fetchMessageFull as fetchMessageFullReal, createReplyDraft as createReplyDraftReal, ensureLabel as ensureLabelReal, addLabel as addLabelReal, type GmailFullMessage } from "../ms-mail";
import { isOnDnc as isOnDncReal, addToDnc as addToDncReal } from "../dnc";

export const PROSPECTS_LABEL = "Clara/Prospects";
export const REVIEW_LABEL = "Clara/Review";

// ── Classification ───────────────────────────────────────────────────────────────────────────

export type ReplyClass =
  | "interested" | "question" | "not_now" | "not_interested" | "unsubscribe"
  | "ooo" | "bounce" | "referral" | "wrong_person" | "unknown";

export interface ClassifyResult {
  class: ReplyClass;
  confidence: number;
  meetingIntent: boolean;
}

const DSN_RE = /mail delivery (failed|subsystem)|undeliverable|delivery status notification|returned mail|address not found|mailbox (unavailable|full)/i;
const OOO_RE = /out of office|automatic reply|away from (my )?(email|desk)|on vacation|on leave|currently out/i;

/** Pure. The three deterministic paths — these never need a model and are checked BEFORE tier-1,
 *  both for cost and because a model has no business "interpreting" a DSN or an Auto-Submitted
 *  header. Returns undefined when none match, telling the caller to escalate to tier-1. */
export function classifyDeterministic(input: { from: string; subject: string; body: string; autoSubmitted?: string }): ClassifyResult | undefined {
  const fromLower = input.from.toLowerCase();
  const subjectAndBody = `${input.subject} ${input.body}`;
  if (fromLower.includes("mailer-daemon") || fromLower.includes("postmaster") || DSN_RE.test(subjectAndBody)) {
    return { class: "bounce", confidence: 1, meetingIntent: false };
  }
  if (input.autoSubmitted === "auto-replied" || OOO_RE.test(subjectAndBody)) {
    return { class: "ooo", confidence: 1, meetingIntent: false };
  }
  if (OPTOUT_RE.test(subjectAndBody)) {
    return { class: "unsubscribe", confidence: 1, meetingIntent: false };
  }
  return undefined;
}

function buildClassifyPrompt(body: string): string {
  return [
    "Classify this reply to a cold outreach email. Pick exactly one class:",
    "- interested: wants to talk, asks for more info, positive tone",
    "- question: asks something specific before deciding (pricing, how it works, timeline)",
    "- not_now: polite no for now, maybe later",
    "- not_interested: clear no, don't contact again",
    "- referral: says to contact someone else instead",
    "- wrong_person: says this isn't their job / they don't work there anymore",
    "- unknown: anything else, or too ambiguous to tell",
    "",
    `Reply:\n${body.slice(0, 2000)}`,
    "",
    'Reply ONLY JSON: {"class": "...", "confidence": 0.0-1.0, "meeting_intent": true|false}',
  ].join("\n");
}

const VALID_CLASSES: ReadonlySet<string> = new Set(["interested", "question", "not_now", "not_interested", "referral", "wrong_person", "unknown"]);

export interface ClassifyDeps {
  runTier: typeof runTierReal;
}
export const defaultClassifyDeps: ClassifyDeps = { runTier: runTierReal };

/**
 * Full pipeline: deterministic -> tier-1 -> (tier-3 once, only if tier-1 confidence < 0.7) ->
 * "unknown" if nothing usable comes back. Never throws — a model failure at any tier just falls
 * through to the next one, and a total failure is "unknown", not a crash.
 */
export async function classifyReply(input: { from: string; subject: string; body: string; autoSubmitted?: string }, deps: ClassifyDeps = defaultClassifyDeps): Promise<ClassifyResult> {
  const deterministic = classifyDeterministic(input);
  if (deterministic) return deterministic;

  const prompt = buildClassifyPrompt(input.body);
  const tier1 = await runOneClassifyTier(1, prompt, deps);
  if (tier1 && tier1.confidence >= 0.7) return tier1;

  const tier3 = await runOneClassifyTier(3, prompt, deps);
  if (tier3) return tier3;

  return tier1 ?? { class: "unknown", confidence: 0, meetingIntent: false };
}

async function runOneClassifyTier(tier: 1 | 3, prompt: string, deps: ClassifyDeps): Promise<ClassifyResult | undefined> {
  const r = await deps.runTier(tier, prompt, { purpose: "prospect:classify_reply", json: true, maxTokens: 100 });
  if (!r.ok || !r.text) return undefined;
  try {
    const parsed = JSON.parse(r.text) as { class?: unknown; confidence?: unknown; meeting_intent?: unknown };
    const cls = typeof parsed.class === "string" && VALID_CLASSES.has(parsed.class) ? (parsed.class as ReplyClass) : "unknown";
    const confidence = typeof parsed.confidence === "number" ? Math.max(0, Math.min(1, parsed.confidence)) : 0.5;
    return { class: cls, confidence, meetingIntent: parsed.meeting_intent === true };
  } catch {
    return undefined;
  }
}

// ── Routing table (plan Part 6 §4) ──────────────────────────────────────────────────────────────

export type OwnerNotify = "important_if_meeting" | "brief" | "count_only" | "none";

export interface RoutingAction {
  /** sequence_event's event_type — the OS RPC's own CASE statement does the enrollment status
   *  transition (see sequenceRunner.ts's module doc for the same convention). */
  enrollmentEventType: "replied" | "stopped" | "unsubscribed" | "bounced" | "blocked" | "skipped" | null;
  /** Only meaningful for enrollmentEventType "blocked" (-> status 'paused') or "skipped" (stays
   *  active/queued, just reschedules) — both read p_next_run_at. */
  rescheduleHours?: number;
  snoozeDays?: number;
  companySuppressionDays?: number;
  ownerNotify: OwnerNotify;
  createTask: boolean;
  draftReply: boolean;
  gmailLabel?: string;
}

export const ROUTING_TABLE: Record<ReplyClass, RoutingAction> = {
  interested: { enrollmentEventType: "replied", ownerNotify: "important_if_meeting", createTask: true, draftReply: true },
  question: { enrollmentEventType: "blocked", rescheduleHours: 48, ownerNotify: "brief", createTask: true, draftReply: true },
  not_now: { enrollmentEventType: "stopped", snoozeDays: 90, ownerNotify: "brief", createTask: false, draftReply: false },
  not_interested: { enrollmentEventType: "stopped", companySuppressionDays: 180, ownerNotify: "brief", createTask: false, draftReply: false },
  unsubscribe: { enrollmentEventType: "unsubscribed", ownerNotify: "count_only", createTask: false, draftReply: false },
  ooo: { enrollmentEventType: "skipped", rescheduleHours: 24 * 7, ownerNotify: "none", createTask: false, draftReply: false },
  bounce: { enrollmentEventType: "bounced", ownerNotify: "count_only", createTask: false, draftReply: false },
  referral: { enrollmentEventType: "stopped", ownerNotify: "brief", createTask: true, draftReply: false },
  wrong_person: { enrollmentEventType: "stopped", ownerNotify: "brief", createTask: true, draftReply: false },
  unknown: { enrollmentEventType: "blocked", rescheduleHours: 48, ownerNotify: "brief", createTask: true, draftReply: false, gmailLabel: REVIEW_LABEL },
};

// ── Routing execution ────────────────────────────────────────────────────────────────────────

function unwrapToolContent(content: unknown): unknown {
  if (Array.isArray(content)) {
    const first = content.find((c) => c && typeof c === "object" && "text" in (c as object));
    if (first && typeof (first as { text?: unknown }).text === "string") {
      try { return JSON.parse((first as { text: string }).text); } catch { return (first as { text: string }).text; }
    }
  }
  return content;
}
async function osContactTaskCreate(args: { contactId: string; title: string; description?: string }): Promise<void> {
  await osClient.callTool("contact_tasks_create", { contact_id: args.contactId, title: args.title, description: args.description }).catch(() => undefined);
}

export interface RouteReplyInput {
  enrollment: NonNullable<OutreachEventsLookupResult["enrollment"]>;
  companyName: string;
  classification: ClassifyResult;
  /** Email-channel context (undefined for an SMS reply). */
  email?: { from: string; subject: string; body: string; threadId: string; messageId: string };
}

export interface RouteReplyDeps {
  outreachEventsAdd: typeof outreachEventsAddReal;
  suppressionsAdd: typeof suppressionsAddReal;
  factsAdd: typeof factsAddReal;
  createContactTask: typeof osContactTaskCreate;
  textOwnerImportant: typeof textOwnerImportantReal;
  createReplyDraft: typeof createReplyDraftReal;
  now: () => Date;
}
export const defaultRouteReplyDeps: RouteReplyDeps = {
  outreachEventsAdd: outreachEventsAddReal,
  suppressionsAdd: suppressionsAddReal,
  factsAdd: factsAddReal,
  createContactTask: osContactTaskCreate,
  textOwnerImportant: textOwnerImportantReal,
  createReplyDraft: createReplyDraftReal,
  now: () => new Date(),
};

const MEETING_PRICING_CONTRACT_RE = /\b(meet|meeting|call|schedule|calendar|price|pricing|cost|quote|contract|sign)\b/i;

/** Executes ROUTING_TABLE[classification.class] against one resolved enrollment. Every OS write is
 *  best-effort (swallowed on failure, matching this whole codebase's convention) — a reply that
 *  can't be fully routed still gets the owner told about it via the notification step, which is the one
 *  side effect that must never silently disappear. */
export async function routeReply(input: RouteReplyInput, deps: RouteReplyDeps = defaultRouteReplyDeps): Promise<{ action: RoutingAction }> {
  const action = ROUTING_TABLE[input.classification.class];
  const now = deps.now();

  if (action.enrollmentEventType) {
    const nextRunAt = action.rescheduleHours ? new Date(now.getTime() + action.rescheduleHours * 3_600_000).toISOString() : undefined;
    await deps.outreachEventsAdd({
      enrollment_id: input.enrollment.enrollment_id,
      event_type: action.enrollmentEventType,
      channel: input.email ? "email" : "sms",
      payload: { class: input.classification.class, confidence: input.classification.confidence, source: "replies" },
      next_run_at: nextRunAt,
    }).catch(() => undefined);
  }

  if (action.companySuppressionDays) {
    const expires = new Date(now.getTime() + action.companySuppressionDays * 86_400_000).toISOString();
    await deps.suppressionsAdd({ kind: "company", value: input.enrollment.company_id, reason: "manual", expires_at: expires, notes: `not_interested reply, ${action.companySuppressionDays}d` }).catch(() => undefined);
  }
  if (action.snoozeDays) {
    const snoozeUntil = new Date(now.getTime() + action.snoozeDays * 86_400_000).toISOString();
    await deps.factsAdd({
      facts: [{ subject_type: "company", subject_id: input.enrollment.company_id, field_name: "snooze_until", value: snoozeUntil, source_type: "manual", confidence: 1 }],
    }).catch(() => undefined);
  }
  if (input.classification.class === "wrong_person") {
    await deps.factsAdd({
      facts: [{ subject_type: "person", subject_id: input.enrollment.person_id ?? input.enrollment.company_id, company_id: input.enrollment.company_id, field_name: "person_left", value: true, source_type: "manual", confidence: 0.8 }],
    }).catch(() => undefined);
  }

  if (action.createTask && input.enrollment.contact_id) {
    const titles: Partial<Record<ReplyClass, string>> = {
      interested: `Reply to ${input.companyName} — interested`,
      question: `Reply to ${input.companyName} — has a question`,
      referral: `${input.companyName} referred someone else — follow up`,
      wrong_person: `${input.companyName} — wrong contact, find the right person`,
      unknown: `Review reply from ${input.companyName} (couldn't auto-classify)`,
    };
    await deps.createContactTask({ contactId: input.enrollment.contact_id, title: titles[input.classification.class] ?? `Follow up: ${input.companyName}`, description: input.email?.body }).catch(() => undefined);
  }

  if (action.draftReply && input.email) {
    await deps.createReplyDraft({
      to: input.email.from, subject: input.email.subject.startsWith("Re:") ? input.email.subject : `Re: ${input.email.subject}`,
      body: `[Draft — review before sending]\n\n`, threadId: input.email.threadId, inReplyTo: input.email.messageId, references: input.email.messageId,
    }).catch(() => undefined);
  }

  if (action.ownerNotify === "important_if_meeting") {
    const hot = input.classification.meetingIntent || MEETING_PRICING_CONTRACT_RE.test(input.email?.body ?? "");
    if (hot) {
      await deps.textOwnerImportant({ contact: input.companyName, matter: "prospect-reply", text: `${input.companyName} replied interested and mentioned a meeting/price/contract — worth a look today.`, emergency: false }, now).catch(() => undefined);
    }
    // else: falls to the morning brief, same as every other non-urgent "brief" class below.
  }

  return { action };
}

// ── Gmail tick ───────────────────────────────────────────────────────────────────────────────

export interface RepliesTickDeps {
  searchMessages: typeof searchMessagesReal;
  fetchMessageFull: typeof fetchMessageFullReal;
  outreachEventsLookup: typeof outreachEventsLookupReal;
  classify: typeof classifyReply;
  routeReply: typeof routeReply;
  ensureLabel: typeof ensureLabelReal;
  addLabel: typeof addLabelReal;
  companyNameFor: (companyId: string) => Promise<string>;
}
async function companiesGetNameReal(companyId: string): Promise<string> {
  const { companiesGet } = await import("./osBridge");
  const c: Record<string, unknown> = await companiesGet(companyId).catch(() => ({}));
  return typeof c.name === "string" ? c.name : "a prospect";
}
export const defaultRepliesTickDeps: RepliesTickDeps = {
  searchMessages: searchMessagesReal,
  fetchMessageFull: fetchMessageFullReal,
  outreachEventsLookup: outreachEventsLookupReal,
  classify: classifyReply,
  routeReply: routeReply,
  ensureLabel: ensureLabelReal,
  addLabel: addLabelReal,
  companyNameFor: companiesGetNameReal,
};

function extractAddress(headerValue: string): string {
  const m = headerValue.match(/<([^>]+)>/);
  return (m ? m[1] : headerValue).trim().toLowerCase();
}

export interface RepliesTickResult {
  scanned: number;
  matched: number;
  routed: Record<ReplyClass, number>;
  notes: string[];
}

export async function repliesTick(deps: RepliesTickDeps = defaultRepliesTickDeps): Promise<RepliesTickResult> {
  const res: RepliesTickResult = {
    scanned: 0, matched: 0,
    routed: { interested: 0, question: 0, not_now: 0, not_interested: 0, unsubscribe: 0, ooo: 0, bounce: 0, referral: 0, wrong_person: 0, unknown: 0 },
    notes: [],
  };

  let candidates: { id: string }[];
  try {
    candidates = await deps.searchMessages(`newer_than:2d -label:${PROSPECTS_LABEL}`, 30);
  } catch (e) {
    res.notes.push(`gmail search failed: ${e instanceof Error ? e.message : String(e)}`);
    return res;
  }
  res.scanned = candidates.length;
  if (!candidates.length) return res;

  const labelId = await deps.ensureLabel(PROSPECTS_LABEL).catch(() => null);
  const reviewLabelId = await deps.ensureLabel(REVIEW_LABEL).catch(() => null);

  for (const c of candidates) {
    const full: GmailFullMessage | null = await deps.fetchMessageFull(c.id).catch(() => null);
    if (!full) continue;
    // Microsoft Graph migration (ms-mail.ts): addLabel() moves the message to a different folder
    // and Graph reassigns it a NEW id on every move — Gmail's label-based version never did. This
    // loop can call addLabel TWICE on the same message (Prospects, then Review), so the second
    // call must use the id the first move came back with, not the original `full.id`, or it 404s
    // on a message that already moved — same hazard already found and fixed in inboxZero.ts.
    let id = full.id;
    // Always label, even on a miss — the whole point of `-label:Clara/Prospects` is to never
    // re-process the same message every tick.
    if (labelId) { const a = await deps.addLabel(id, labelId).catch(() => ({ ok: false as const })); if (a.ok && a.newId) id = a.newId; }

    const inReplyTo = full.headers.get("in-reply-to")?.replace(/[<>]/g, "");
    const fromAddress = extractAddress(full.from);
    const lookup = await deps.outreachEventsLookup({ provider_message_id: inReplyTo, email: fromAddress }).catch(() => ({ match: null, enrollment: null }) as OutreachEventsLookupResult);
    if (!lookup.enrollment) continue;
    res.matched++;

    const companyName = await deps.companyNameFor(lookup.enrollment.company_id).catch(() => "a prospect");
    const classification = await deps.classify({ from: full.from, subject: full.subject, body: full.body, autoSubmitted: full.headers.get("auto-submitted") });
    res.routed[classification.class]++;

    await deps.routeReply({
      enrollment: lookup.enrollment, companyName, classification,
      email: { from: full.from, subject: full.subject, body: full.body, threadId: full.threadId, messageId: full.headers.get("message-id") ?? id },
    }).catch((e) => res.notes.push(`route failed for ${id}: ${e instanceof Error ? e.message : String(e)}`));

    if (classification.class === "unknown" && reviewLabelId) await deps.addLabel(id, reviewLabelId).catch(() => undefined);
  }

  return res;
}

// ── SMS inbound hook ─────────────────────────────────────────────────────────────────────────

export interface SmsReplyDeps {
  outreachEventsLookup: typeof outreachEventsLookupReal;
  classify: typeof classifyReply;
  routeReply: typeof routeReply;
  companyNameFor: (companyId: string) => Promise<string>;
  recordInboundContactConsent: (phone: string) => Promise<void>;
  isOnDnc: typeof isOnDncReal;
  addToDnc: typeof addToDncReal;
}
async function osRecordInboundConsent(phone: string): Promise<void> {
  await osClient.callTool("consents_add", { channel: "sms", basis: "inbound_contact", source: "inbound_sms", phone, captured_at: new Date().toISOString() }).catch(() => undefined);
}
export const defaultSmsReplyDeps: SmsReplyDeps = {
  outreachEventsLookup: outreachEventsLookupReal,
  classify: classifyReply,
  routeReply: routeReply,
  companyNameFor: companiesGetNameReal,
  recordInboundContactConsent: osRecordInboundConsent,
  isOnDnc: isOnDncReal,
  addToDnc: addToDncReal,
};

export interface HandleInboundSmsResult {
  matched: boolean;
  class?: ReplyClass;
}

/**
 * Called from the Twilio SMS inbound route for every inbound message (not just ones that turn out
 * to be prospecting replies — `matched:false` is the ordinary case for the owner's own texts, family,
 * other business SMS). ANY reply from a prospect is a TCPA "inbound contact" — consent is recorded
 * regardless of what the message says; a STOP-shaped reply additionally hits the existing DNC list
 * (dnc.ts already handles the keyword match elsewhere in the route — this only adds the belt-and-
 * suspenders prospecting-specific DNC write for a reply that resolved to an enrollment but wasn't
 * phrased as an exact STOP keyword, e.g. "please stop texting me").
 */
export async function handleInboundSmsReply(phone: string, body: string, deps: SmsReplyDeps = defaultSmsReplyDeps): Promise<HandleInboundSmsResult> {
  const lookup = await deps.outreachEventsLookup({ phone }).catch(() => ({ match: null, enrollment: null }) as OutreachEventsLookupResult);
  if (!lookup.enrollment) return { matched: false };

  await deps.recordInboundContactConsent(phone).catch(() => undefined);

  const companyName = await deps.companyNameFor(lookup.enrollment.company_id).catch(() => "a prospect");
  const classification = await deps.classify({ from: phone, subject: "", body });
  await deps.routeReply({ enrollment: lookup.enrollment, companyName, classification }).catch(() => undefined);

  if (classification.class === "unsubscribe" && !(await deps.isOnDnc(phone))) {
    await deps.addToDnc(phone, "prospecting reply — opt-out language").catch(() => undefined);
  }

  return { matched: true, class: classification.class };
}
