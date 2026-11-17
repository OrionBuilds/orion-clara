// sequenceRunner.ts — PR 14: generalizes scorecardDrip.ts's RPC -> gate -> render -> send ->
// write-back shape to the full prospecting sequence state machine (plan §38/Part 6).
//
// Tick (every 5 min, scheduler.ts): sequence_due_enrollments(limit) hands back one row per
// enrollment, already joined to its NEXT due step (sequence/company/person/contact_method/template
// all in one call — see osBridge.ts's DueEnrollment). Per row, in order: skip_if conditions ->
// consent gate (sms/voice) -> suppression_check -> capacity (domain ramp + per-contact/company/
// global caps) -> render (personalize.ts, cached) -> channel send -> sequence_event write-back,
// which both records the event AND advances current_step_no/status on the OS side (see that RPC's
// own CASE statement, migration 20261001100200) — this module never patches sequence_enrollments
// directly, exactly like scorecardDrip.ts never patches scorecard state directly.
//
// Gated by CLARA_PROSPECT_SEQUENCES=off|shadow|active, default shadow (types.ts's
// prospectingMode() convention, same three states, SEPARATE env var — shadow here means "render
// and log what would send, write a 'rendered'/'skipped(shadow)' event, never actually send").
//
// Documented scope cuts (infra gaps, not laziness — see each inline comment where it bites):
//   - skip_if's `clicked:any`/`opened:none` conditions need a per-enrollment outreach_events read
//     this OS surface has no tool for (confirmed while building personalize.ts/this file) — only
//     `no_phone` and `no_consent:sms` are implemented; others are accepted but no-op (logged, never
//     silently misapplied).
//   - `exit_on` conditions beyond what sequence_due_enrollments' own status filter already excludes
//     (it only returns queued/active rows) are not independently re-checked here — an
//     "opp_stage>=Meeting Booked" style condition needs an opportunity-stage read this runner
//     doesn't have a tool for either.
//   - call steps always become an owner task (contact_tasks_create) in this PR, even when
//     prospect_settings.clara_calls_enabled is true — business-calls.ts's draft/approve flow is
//     built for a one-off approved call, not a per-sequence-step automated dialer; wiring that is
//     real scope for a later PR, not silently faked here.

import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { osClient } from "../osClient";
import { BOOKING_URL } from "./branding";
import { sendSMS as sendSMSReal } from "../channels";
import { isOnDnc as isOnDncReal } from "../dnc";
import {
  companiesGetFull as companiesGetFullReal, outreachEventsAdd as outreachEventsAddReal,
  prospectSettingsGet as prospectSettingsGetReal, type CompanyFactRow, type SignalRow,
  type ProspectSettings,
} from "./osBridge";
import { checkSuppressed as checkSuppressedReal, checkEmailQuota, sendGate, type SuppressionCheckInput } from "./compliance";
import { buildComplianceHeaders, mintUnsubscribeLink as mintUnsubscribeLinkReal, loadPhysicalAddress as loadPhysicalAddressReal, appendComplianceFooter } from "./complianceFooter";
import {
  pickSenderDomain as pickSenderDomainReal, listSenderIdentities as listSenderIdentitiesReal,
  isDomainPaused as isDomainPausedReal, domainBreakerShouldPause, type SenderDomainState,
} from "./senderRotation";
import { recordSend as recordSendReal, countsForTarget as countsForTargetReal, loadCapacityCounts as loadCapacityCountsReal } from "./sequenceCapacity";
import { renderStep as renderStepReal, type AiSlotSpec, type RenderStepResult } from "./personalize";

export type SequenceRunnerMode = "off" | "shadow" | "active";
export function sequenceRunnerMode(env: NodeJS.ProcessEnv = process.env): SequenceRunnerMode {
  const v = (env.CLARA_PROSPECT_SEQUENCES ?? "shadow").trim().toLowerCase();
  return v === "off" || v === "active" ? v : "shadow";
}

// ── The due-enrollment row (sequence_due_enrollments) ───────────────────────────────────────────

export interface DueEnrollment {
  enrollment_id: string;
  sequence_id: string;
  company_id: string;
  person_id?: string;
  contact_id?: string;
  contact_method_id?: string;
  status: string;
  current_step_no: number;
  next_run_at?: string | null;
  variant?: number | null;
  personalization_snapshot?: { evidence_hash?: string; slots?: Record<string, string>; citations?: Record<string, string[]> } | null;
  sequence_name: string;
  stop_on_reply?: boolean;
  exit_on?: string[];
  max_touches_per_company_per_week?: number;
  allow_role_addresses?: boolean;
  step_id: string;
  step_no: number;
  channel: "email" | "sms" | "call" | "task" | "linkedin_task";
  template: { subject?: string; subject_variants?: { key: string; text: string }[]; body: string; task_title?: string };
  ai_slots?: AiSlotSpec[];
  conditions?: { skip_if?: string[] };
  requires_consent?: "sms" | "voice" | null;
  task_assignee?: string;
  company_name: string;
  city?: string;
  state?: string;
  website_url?: string;
  fit_score?: number;
  person_name?: string;
  person_first_name?: string;
  person_title?: string;
  method_kind?: "email" | "phone" | "mobile";
  method_value?: string;
  verification_status?: string;
}

// ── Pure: variant assignment ─────────────────────────────────────────────────────────────────

/** Pure, deterministic: `hash(enrollment_id) mod n` — the SAME enrollment always lands on the same
 *  variant across retried ticks (unlike Math.random(), which would re-roll on every call). */
export function variantIndex(enrollmentId: string, n: number): number {
  if (n <= 0) return 0;
  const digest = createHash("sha256").update(enrollmentId).digest();
  return digest.readUInt32BE(0) % n;
}

export function pickSubjectVariant(enrollmentId: string, variants: { key: string; text: string }[] | undefined, fallback: string | undefined): { key?: string; text?: string } {
  if (!variants?.length) return { text: fallback };
  const v = variants[variantIndex(enrollmentId, variants.length)];
  return { key: v.key, text: v.text };
}

// ── Pure: {{token}} rendering + missing-var detection ───────────────────────────────────────────

const TOKEN_RE = /\{\{\s*([a-zA-Z0-9_.:]+)\s*\}\}/g;

export interface RenderTemplateResult {
  text: string;
  missing: string[];
}

/** Pure. `tokens` must already include both static substitutions (contact.first_name, company.name,
 *  unsubscribe_url, book_url, fact.*, signal.latest.headline, ...) AND the `ai:<slotName>` entries
 *  from personalize.ts's render — this function doesn't know the difference, it just substitutes
 *  whatever key it's given and reports whichever `{{...}}` tokens had no entry at all. */
export function renderTemplate(body: string, tokens: Record<string, string>): RenderTemplateResult {
  const missing: string[] = [];
  const text = body.replace(TOKEN_RE, (whole, key: string) => {
    if (key in tokens) return tokens[key];
    missing.push(key);
    return whole;
  });
  return { text, missing };
}

// ── Pure: skip_if (the subset resolvable from the due row alone — see module doc) ──────────────

export interface SkipIfContext {
  hasPhone: boolean;
  smsConsentOk: boolean;
}
export function evaluateSkipIf(conditions: string[] | undefined, ctx: SkipIfContext): { skip: boolean; reason?: string } {
  for (const c of conditions ?? []) {
    if (c === "no_phone" && !ctx.hasPhone) return { skip: true, reason: "skip_if:no_phone" };
    if (c === "no_consent:sms" && !ctx.smsConsentOk) return { skip: true, reason: "skip_if:no_consent:sms" };
  }
  return { skip: false };
}

// ── Pure: TCPA SMS window (09:00-18:00 Mon-Fri, prospect's own timezone) ───────────────────────

const STATE_TZ: Record<string, string> = {
  CT: "America/New_York", DE: "America/New_York", FL: "America/New_York", GA: "America/New_York",
  IN: "America/New_York", ME: "America/New_York", MD: "America/New_York", MA: "America/New_York",
  NH: "America/New_York", NJ: "America/New_York", NY: "America/New_York", NC: "America/New_York",
  OH: "America/New_York", PA: "America/New_York", RI: "America/New_York", SC: "America/New_York",
  VT: "America/New_York", VA: "America/New_York", WV: "America/New_York", MI: "America/New_York",
  AL: "America/Chicago", AR: "America/Chicago", IL: "America/Chicago", IA: "America/Chicago",
  KS: "America/Chicago", LA: "America/Chicago", MN: "America/Chicago", MS: "America/Chicago",
  MO: "America/Chicago", NE: "America/Chicago", ND: "America/Chicago", OK: "America/Chicago",
  SD: "America/Chicago", TN: "America/Chicago", TX: "America/Chicago", WI: "America/Chicago",
  AZ: "America/Phoenix", CO: "America/Denver", ID: "America/Denver", MT: "America/Denver",
  NM: "America/Denver", UT: "America/Denver", WY: "America/Denver",
  CA: "America/Los_Angeles", NV: "America/Los_Angeles", OR: "America/Los_Angeles", WA: "America/Los_Angeles",
  AK: "America/Anchorage", HI: "Pacific/Honolulu",
};

/** A US state abbreviation to its predominant IANA zone — a documented heuristic (a handful of
 *  states split zones, e.g. west Texas; this picks the majority zone), not a geocoded lookup.
 *  Defaults to Eastern when the state is unknown/missing — the conservative choice since it's the
 *  EARLIEST zone to close its window (9-6 Eastern is 8-5 Central etc.), so a true cross-zone
 *  mismatch fails safe toward NOT sending rather than sending too early elsewhere. */
export function prospectTimezone(state: string | undefined): string {
  return (state && STATE_TZ[state.toUpperCase()]) || "America/New_York";
}

/** Pure given `now`. 09:00-18:00, Monday-Friday, in the prospect's own timezone (plan: TCPA
 *  window). */
export function withinSmsWindow(state: string | undefined, now: Date = new Date()): boolean {
  const tz = prospectTimezone(state);
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hourCycle: "h23", weekday: "short" }).formatToParts(now);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const weekday = parts.find((p) => p.type === "weekday")?.value ?? "";
  const isWeekday = !["Sat", "Sun"].includes(weekday);
  return isWeekday && hour >= 9 && hour < 18;
}

// ── Pure: capacity gate ──────────────────────────────────────────────────────────────────────

export interface CapacityInput {
  globalToday: number;
  globalPerDay: number;
  contactToday: number;
  companyToday: number;
  companyThisWeek: number;
  domainToday: number;
  domainCap: number;
}
export interface CapacityDecision {
  ok: boolean;
  reason?: string;
}
export function checkCapacity(input: CapacityInput): CapacityDecision {
  const quota = checkEmailQuota(
    { globalToday: input.globalToday, contactToday: input.contactToday, companyToday: input.companyToday, companyThisWeek: input.companyThisWeek },
    { globalPerDay: input.globalPerDay, contactPerDay: 1, companyPerDay: 1, companyPerWeek: 3 },
  );
  if (quota.blocked) return { ok: false, reason: quota.reason };
  if (input.domainToday >= input.domainCap) return { ok: false, reason: "domain_ramp_cap" };
  return { ok: true };
}

// ── Step outcome ─────────────────────────────────────────────────────────────────────────────

export type StepOutcome =
  | { kind: "sent"; channel: "email" | "sms"; providerMessageId?: string }
  | { kind: "task_created" }
  | { kind: "call_placed" }
  | { kind: "skipped"; reason: string }
  | { kind: "blocked"; reason: string };

// ── Deps ─────────────────────────────────────────────────────────────────────────────────────

function unwrapToolContent(content: unknown): unknown {
  if (Array.isArray(content)) {
    const first = content.find((c) => c && typeof c === "object" && "text" in (c as object));
    if (first && typeof (first as { text?: unknown }).text === "string") {
      try { return JSON.parse((first as { text: string }).text); } catch { return (first as { text: string }).text; }
    }
  }
  return content;
}

export interface SequenceRunnerDeps {
  fetchDueEnrollments: (limit: number) => Promise<DueEnrollment[]>;
  companiesGetFull: typeof companiesGetFullReal;
  checkSuppressed: typeof checkSuppressedReal;
  consentsOk: (args: { contactId?: string; phone?: string; channel: "sms" | "voice" }) => Promise<boolean>;
  renderStep: typeof renderStepReal;
  mintUnsubscribeLink: typeof mintUnsubscribeLinkReal;
  loadPhysicalAddress: typeof loadPhysicalAddressReal;
  prospectSettingsGet: typeof prospectSettingsGetReal;
  listSenderIdentities: typeof listSenderIdentitiesReal;
  pickSenderDomain: typeof pickSenderDomainReal;
  isDomainPaused: typeof isDomainPausedReal;
  recordSend: typeof recordSendReal;
  countsForTarget: typeof countsForTargetReal;
  loadCapacityCounts: typeof loadCapacityCountsReal;
  sendEmail: (args: { toEmail: string; fromAddressId: string; subject: string; htmlBody: string; headers: Record<string, string> }) => Promise<{ ok: boolean; messageId?: string; error?: string }>;
  sendSMS: typeof sendSMSReal;
  isOnDnc: typeof isOnDncReal;
  createContactTask: (args: { contactId: string; title: string; description?: string }) => Promise<{ ok: boolean; error?: string }>;
  outreachEventsAdd: typeof outreachEventsAddReal;
  now: () => Date;
}

async function osEmailSend(args: { toEmail: string; fromAddressId: string; subject: string; htmlBody: string; headers: Record<string, string> }): Promise<{ ok: boolean; messageId?: string; error?: string }> {
  const r = unwrapToolContent(await osClient.callTool("email_send", {
    to_email: args.toEmail, from_address_id: args.fromAddressId, subject: args.subject, html_body: args.htmlBody, headers: args.headers,
  }).catch((e) => ({ success: false, error: e instanceof Error ? e.message : String(e) }))) as { success?: boolean; messageId?: string; error?: string };
  return { ok: r.success === true, messageId: r.messageId, error: r.error };
}
async function osContactTaskCreate(args: { contactId: string; title: string; description?: string }): Promise<{ ok: boolean; error?: string }> {
  const r = unwrapToolContent(await osClient.callTool("contact_tasks_create", { contact_id: args.contactId, title: args.title, description: args.description }).catch((e) => ({ error: e instanceof Error ? e.message : String(e) }))) as { error?: string };
  return { ok: !r.error, error: r.error };
}
async function osConsentsOk(args: { contactId?: string; phone?: string; channel: "sms" | "voice" }): Promise<boolean> {
  const r = unwrapToolContent(await osClient.callTool("consents_list", { contact_id: args.contactId, phone: args.phone, channel: args.channel }).catch(() => ({}))) as { sms_ok?: boolean; voice_ok?: boolean };
  return args.channel === "sms" ? r.sms_ok === true : r.voice_ok === true;
}
async function fetchDueEnrollmentsReal(limit: number): Promise<DueEnrollment[]> {
  const r = unwrapToolContent(await osClient.callTool("sequence_enrollments_due", { limit }).catch(() => ({ due: [] }))) as { due?: DueEnrollment[] };
  return Array.isArray(r.due) ? r.due : [];
}

export const defaultSequenceRunnerDeps: SequenceRunnerDeps = {
  fetchDueEnrollments: fetchDueEnrollmentsReal,
  companiesGetFull: companiesGetFullReal,
  checkSuppressed: checkSuppressedReal,
  consentsOk: osConsentsOk,
  renderStep: renderStepReal,
  mintUnsubscribeLink: mintUnsubscribeLinkReal,
  loadPhysicalAddress: loadPhysicalAddressReal,
  prospectSettingsGet: prospectSettingsGetReal,
  listSenderIdentities: listSenderIdentitiesReal,
  pickSenderDomain: pickSenderDomainReal,
  isDomainPaused: isDomainPausedReal,
  recordSend: recordSendReal,
  countsForTarget: countsForTargetReal,
  loadCapacityCounts: loadCapacityCountsReal,
  sendEmail: osEmailSend,
  sendSMS: sendSMSReal,
  isOnDnc: isOnDncReal,
  createContactTask: osContactTaskCreate,
  outreachEventsAdd: outreachEventsAddReal,
  now: () => new Date(),
};

// ── Tokens for template rendering ───────────────────────────────────────────────────────────────

// Exported (not just used by processEmailStep below) so PR 15's sequencePreview.ts can narrow a
// company's facts/signals to the exact same top-15/last-5 set the live runner would use — a
// preview that scored against a different evidence slice than a real send would be misleading.
export function topFacts(facts: CompanyFactRow[], n = 15): CompanyFactRow[] {
  return [...facts].sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0)).slice(0, n);
}
export function recentSignals(signals: SignalRow[], n = 5): SignalRow[] {
  return [...signals].sort((a, b) => Date.parse(b.observed_at) - Date.parse(a.observed_at)).slice(0, n);
}

function staticTokens(e: DueEnrollment, facts: CompanyFactRow[], signals: SignalRow[], unsubscribeUrl: string | undefined): Record<string, string> {
  const crm = facts.find((f) => f.field_name === "crm");
  const tokens: Record<string, string> = {
    "contact.first_name": e.person_first_name || e.person_name?.split(" ")[0] || "there",
    "company.name": e.company_name,
    "fact.crm": typeof crm?.value === "string" ? crm.value : "",
    "signal.latest.headline": signals[0]?.headline ?? "",
    "book_url": BOOKING_URL,
  };
  if (unsubscribeUrl) tokens.unsubscribe_url = unsubscribeUrl;
  return tokens;
}

// ── Step handler ─────────────────────────────────────────────────────────────────────────────

export interface ProcessEnrollmentResult {
  enrollmentId: string;
  outcome: StepOutcome;
}

async function processEmailStep(e: DueEnrollment, deps: SequenceRunnerDeps, mode: SequenceRunnerMode, settings: ProspectSettings | undefined): Promise<StepOutcome> {
  if (e.method_kind !== "email" || !e.method_value) return { kind: "skipped", reason: "no email method on this enrollment" };

  const gate = sendGate({
    email: e.method_value,
    verificationStatus: (e.verification_status as never) ?? "unknown",
    isOnlyAddress: true, // the enrollment's bound method IS its only recorded address for this send
    allowRole: e.allow_role_addresses ?? false,
  });
  if (!gate.ok) return { kind: "blocked", reason: `send_gate:${gate.reason}` };

  const suppressed = await deps.checkSuppressed({ channel: "email", email: e.method_value, companyId: e.company_id, contactId: e.contact_id });
  if (suppressed.blocked) return { kind: "blocked", reason: "suppressed" };

  const identities = await deps.listSenderIdentities();
  const domains: SenderDomainState[] = [];
  const counts = await deps.countsForTarget(e.method_value.toLowerCase(), e.company_id, deps.now().getTime());
  for (const id of identities) {
    if (await deps.isDomainPaused(id.domain)) continue;
    const sentToday = await (async () => 0)(); // placeholder overwritten just below (keeps the loop body free of an await inside the push for readability)
    domains.push({ id: id.fromAddressId, domain: id.domain, active: true, sentToday });
  }
  // Fill real per-domain counts (kept as a second pass so every domain's lookup runs off the same
  // snapshot rather than racing the loop above).
  for (const d of domains) d.sentToday = await (await import("./sequenceCapacity")).domainSentToday(d.domain, deps.now().getTime());

  const chosen = deps.pickSenderDomain(domains, { now: deps.now() });
  if (!chosen) return { kind: "blocked", reason: "no_eligible_sender_domain" };

  const globalCounts = await deps.loadCapacityCounts(deps.now().getTime());
  const capacity = checkCapacity({
    globalToday: globalCounts.globalToday,
    globalPerDay: settings?.global_email_per_day ?? 50,
    contactToday: counts.contactToday,
    companyToday: counts.companyToday,
    companyThisWeek: counts.companyThisWeek,
    domainToday: chosen.sentToday,
    domainCap: chosen.currentDailyLimit ?? Infinity,
  });
  if (!capacity.ok) return { kind: "blocked", reason: capacity.reason ?? "capacity" };

  const physicalAddress = await deps.loadPhysicalAddress();
  if (!physicalAddress) return { kind: "blocked", reason: "no_physical_address_configured" };

  const unsubscribeUrl = await deps.mintUnsubscribeLink({ email: e.method_value, companyId: e.company_id, contactId: e.contact_id, enrollmentId: e.enrollment_id });

  const full = await deps.companiesGetFull(e.company_id);
  const facts = topFacts(full.facts);
  const signals = recentSignals(full.signals as unknown as SignalRow[]);
  const rendered: RenderStepResult = await deps.renderStep(
    {
      contact: { fullName: e.person_name ?? e.company_name, firstName: e.person_first_name, title: e.person_title },
      company: { name: e.company_name, city: e.city, state: e.state },
      facts, signals,
      template: { subject: e.template.subject, body: e.template.body },
      aiSlots: e.ai_slots ?? [],
      priorTouches: [],
    },
    e.personalization_snapshot ?? undefined,
  );

  const tokens: Record<string, string> = { ...staticTokens(e, facts, signals, unsubscribeUrl) };
  for (const [name, text] of Object.entries(rendered.slots)) tokens[`ai:${name}`] = text;

  const subjectVariant = pickSubjectVariant(e.enrollment_id, e.template.subject_variants, e.template.subject);
  const subjectRender = renderTemplate(subjectVariant.text ?? "", tokens);
  const bodyRender = renderTemplate(e.template.body, tokens);
  if (subjectRender.missing.length || bodyRender.missing.length) {
    return { kind: "blocked", reason: `missing_var:${[...subjectRender.missing, ...bodyRender.missing].join(",")}` };
  }

  const footedBody = appendComplianceFooter(bodyRender.text, { physicalAddress, unsubscribeUrl });
  const headers = buildComplianceHeaders({ unsubscribeUrl, senderDomain: chosen.domain });

  if (mode !== "active") return { kind: "skipped", reason: `shadow:would_send_email via ${chosen.domain}` };

  const sent = await deps.sendEmail({ toEmail: e.method_value, fromAddressId: chosen.id, subject: subjectRender.text, htmlBody: footedBody.replace(/\n/g, "<br>"), headers });
  if (!sent.ok) return { kind: "blocked", reason: `send_failed:${sent.error ?? "unknown"}` };

  await deps.recordSend({ channel: "email", contactKey: e.method_value.toLowerCase(), companyId: e.company_id, domain: chosen.domain });
  return { kind: "sent", channel: "email", providerMessageId: sent.messageId };
}

async function processSmsStep(e: DueEnrollment, deps: SequenceRunnerDeps, mode: SequenceRunnerMode): Promise<StepOutcome> {
  const phone = e.method_kind === "mobile" || e.method_kind === "phone" ? e.method_value : undefined;
  if (!phone) return { kind: "skipped", reason: "no_phone" };
  if (await deps.isOnDnc(phone)) return { kind: "blocked", reason: "dnc" };

  const consentOk = await deps.consentsOk({ contactId: e.contact_id, phone, channel: "sms" });
  if (!consentOk) return { kind: "skipped", reason: "no_consent" };

  if (!withinSmsWindow(e.state, deps.now())) return { kind: "skipped", reason: "outside_tcpa_window" };

  const suppressed = await deps.checkSuppressed({ channel: "sms", phone, companyId: e.company_id, contactId: e.contact_id });
  if (suppressed.blocked) return { kind: "blocked", reason: "suppressed" };

  const counts = await deps.countsForTarget(phone, e.company_id, deps.now().getTime());
  const globalCounts = await deps.loadCapacityCounts(deps.now().getTime());
  const capacity = checkCapacity({ globalToday: globalCounts.globalToday, globalPerDay: 50, contactToday: counts.contactToday, companyToday: counts.companyToday, companyThisWeek: counts.companyThisWeek, domainToday: 0, domainCap: Infinity });
  if (!capacity.ok) return { kind: "blocked", reason: capacity.reason ?? "capacity" };

  const tokens = staticTokens(e, [], [], undefined);
  const bodyRender = renderTemplate(e.template.body, tokens);
  if (bodyRender.missing.length) return { kind: "blocked", reason: `missing_var:${bodyRender.missing.join(",")}` };

  if (mode !== "active") return { kind: "skipped", reason: "shadow:would_send_sms" };

  const sent = await deps.sendSMS(phone, bodyRender.text);
  if (!sent.ok) return { kind: "blocked", reason: `send_failed:${sent.error ?? "unknown"}` };

  await deps.recordSend({ channel: "sms", contactKey: phone, companyId: e.company_id });
  return { kind: "sent", channel: "sms", providerMessageId: sent.sid };
}

async function processTaskStep(e: DueEnrollment, deps: SequenceRunnerDeps, mode: SequenceRunnerMode, isCall: boolean): Promise<StepOutcome> {
  if (!e.contact_id) return { kind: "skipped", reason: "not_promoted" };
  const title = isCall ? `Call ${e.person_name ?? e.company_name} (${e.company_name})` : (e.template.task_title ?? `Follow up: ${e.company_name}`);
  if (mode !== "active") return { kind: "skipped", reason: `shadow:would_create_task "${title}"` };
  const r = await deps.createContactTask({ contactId: e.contact_id, title, description: e.template.body });
  if (!r.ok) return { kind: "blocked", reason: `task_failed:${r.error ?? "unknown"}` };
  return isCall ? { kind: "call_placed" } : { kind: "task_created" };
}

/** Manual LinkedIn touch: never sends anything. Renders the step's note/DM and files it as a CRM
 *  task for the owner to send by hand from their own LinkedIn (connect note ≤300 chars is LinkedIn's limit). */
export async function processLinkedinStep(e: DueEnrollment, deps: SequenceRunnerDeps, mode: SequenceRunnerMode): Promise<StepOutcome> {
  if (!e.contact_id) return { kind: "skipped", reason: "not_promoted" };
  const body = renderTemplate(e.template.body, staticTokens(e, [], [], undefined));
  if (body.missing.length) return { kind: "blocked", reason: `missing_var:${body.missing.join(",")}` };
  const who = e.person_name ?? e.company_name;
  const title = e.template.task_title ? renderTemplate(e.template.task_title, staticTokens(e, [], [], undefined)).text : `LinkedIn: ${who} (${e.company_name})`;
  if (mode !== "active") return { kind: "skipped", reason: `shadow:would_create_task "${title}"` };
  const r = await deps.createContactTask({ contactId: e.contact_id, title, description: body.text });
  if (!r.ok) return { kind: "blocked", reason: `task_failed:${r.error ?? "unknown"}` };
  return { kind: "task_created" };
}

/** Processes exactly one due enrollment's current step, writing the sequence_event back to the OS
 *  (the OS RPC advances current_step_no/status itself — see module doc). Never throws: any
 *  unexpected failure downgrades to a `blocked` outcome with the error as its reason so one bad
 *  enrollment never aborts the tick's loop over the rest. */
export async function processEnrollment(e: DueEnrollment, deps: SequenceRunnerDeps = defaultSequenceRunnerDeps): Promise<ProcessEnrollmentResult> {
  const mode = sequenceRunnerMode();
  try {
    const skip = evaluateSkipIf(e.conditions?.skip_if, {
      hasPhone: e.method_kind === "mobile" || e.method_kind === "phone",
      smsConsentOk: e.requires_consent !== "sms" || (await deps.consentsOk({ contactId: e.contact_id, phone: e.method_value, channel: "sms" })),
    });
    if (skip.skip) {
      await deps.outreachEventsAdd({ enrollment_id: e.enrollment_id, event_type: "skipped", channel: "system", step_id: e.step_id, payload: { reason: skip.reason } }).catch(() => undefined);
      return { enrollmentId: e.enrollment_id, outcome: { kind: "skipped", reason: skip.reason ?? "skip_if" } };
    }

    if (e.requires_consent) {
      const ok = await deps.consentsOk({ contactId: e.contact_id, phone: e.method_value, channel: e.requires_consent });
      if (!ok) {
        await deps.outreachEventsAdd({ enrollment_id: e.enrollment_id, event_type: "skipped", channel: "system", step_id: e.step_id, payload: { reason: "no_consent" } }).catch(() => undefined);
        return { enrollmentId: e.enrollment_id, outcome: { kind: "skipped", reason: "no_consent" } };
      }
    }

    const settings = await deps.prospectSettingsGet().catch(() => undefined);
    let outcome: StepOutcome;
    if (e.channel === "email") outcome = await processEmailStep(e, deps, mode, settings);
    else if (e.channel === "sms") outcome = await processSmsStep(e, deps, mode);
    else if (e.channel === "call") outcome = await processTaskStep(e, deps, mode, true);
    else if (e.channel === "linkedin_task") outcome = await processLinkedinStep(e, deps, mode);
    else outcome = await processTaskStep(e, deps, mode, false);

    const eventType = outcome.kind === "sent" ? "sent" : outcome.kind === "task_created" ? "task_created" : outcome.kind === "call_placed" ? "call_placed" : outcome.kind === "blocked" ? "blocked" : "skipped";
    await deps.outreachEventsAdd({
      enrollment_id: e.enrollment_id, event_type: eventType, channel: e.channel, step_id: e.step_id,
      payload: { reason: "reason" in outcome ? outcome.reason : undefined, mode },
      provider_message_id: "providerMessageId" in outcome ? outcome.providerMessageId : undefined,
    }).catch(() => undefined);

    return { enrollmentId: e.enrollment_id, outcome };
  } catch (err) {
    const reason = `error:${err instanceof Error ? err.message : String(err)}`;
    await deps.outreachEventsAdd({ enrollment_id: e.enrollment_id, event_type: "blocked", channel: "system", step_id: e.step_id, payload: { reason } }).catch(() => undefined);
    return { enrollmentId: e.enrollment_id, outcome: { kind: "blocked", reason } };
  }
}

// ── Tick ─────────────────────────────────────────────────────────────────────────────────────

export interface SequenceTickResult {
  mode: SequenceRunnerMode;
  due: number;
  sent: number;
  skipped: number;
  blocked: number;
  taskCreated: number;
  callPlaced: number;
  notes: string[];
}

const TICK_LIMIT = 50;

export async function sequenceRunnerTick(deps: SequenceRunnerDeps = defaultSequenceRunnerDeps): Promise<SequenceTickResult> {
  const mode = sequenceRunnerMode();
  const res: SequenceTickResult = { mode, due: 0, sent: 0, skipped: 0, blocked: 0, taskCreated: 0, callPlaced: 0, notes: [] };
  if (mode === "off") return res;

  let due: DueEnrollment[];
  try {
    due = await deps.fetchDueEnrollments(TICK_LIMIT);
  } catch (e) {
    res.notes.push(`fetch failed: ${e instanceof Error ? e.message : String(e)}`);
    return res;
  }
  res.due = due.length;

  for (const e of due) {
    const { outcome } = await processEnrollment(e, deps);
    if (outcome.kind === "sent") res.sent++;
    else if (outcome.kind === "task_created") res.taskCreated++;
    else if (outcome.kind === "call_placed") res.callPlaced++;
    else if (outcome.kind === "skipped") res.skipped++;
    else res.blocked++;
  }
  return res;
}

void randomUUID; // kept imported for a future idempotency-token use (send retries) — not yet wired
