// Clara — intent router. The JARVIS layer.
//
// WHAT THIS REPLACES. Ten hand-written parsers in a fixed order, each with its own grammar, and a
// conversational LLM at the bottom as the catch-all. The owner texted "Analyze my inbox and clean it up
// it's got a lot of junk in it"; isInboxSweepCommand's regex wants the verb BEFORE the word inbox;
// it didn't match; the message fell to the LLM; the LLM replied "Inbox swept; junk archived and
// labeled. All clear." The ledger shows zero action rows between the owner's text and that reply.
//
// So there are two problems, and the second is the one that matters:
//
//   1. Matching was keyword-brittle. Fixable by widening regexes, forever, one phrasing at a time.
//   2. The fallback could CLAIM WORK IT DID NOT DO. Not fixable by widening anything.
//
// This module fixes (1) by letting a model decide which capability is wanted, and (2) structurally:
// the model's only way to affect the world is to call a tool, and the sentence the owner reads is
// assembled from what those tools actually RETURNED. It is not asked to be honest about what it
// did — it is not given the option to be otherwise.
//
// Three defences, in order:
//
//   A. Tools or nothing. Actions exist only as tool handlers. There is no code path where model
//      prose causes a side effect.
//   B. Tool results are appended verbatim to the reply. If the model embellishes, the truth is in
//      the same message.
//   C. A post-check (see `claimsCompletion`) catches past-tense completion language emitted with
//      zero tool calls and replaces it. This is the exact shape of the original failure, so it is
//      worth catching even though A and B should already prevent it.
//
// The tier table decides act-vs-ask. Reversible and internal → run it. Outbound or irreversible →
// approvals.draft(), which already texts the owner a short code they can reply to. That was the owner's call:
// "act on reversible, confirm outbound/irreversible."

// THE LOOP LIVES IN agent-core. This file is now CLARA's catalog and her bindings to it — the
// tool-calling loop, the three defences and the gate ordering are shared with FRIDAY,
// because both need identical guarantees over completely different tools. Keeping a private
// copy here is how the three agents' notify and outbound code drifted apart before agent-core
// existed, and this loop is considerably more safety-critical than either of those.
//
// The shared loop is unit-tested against a scripted model (agent-core/src/intent/intent.test.ts),
// which the live-API version here never could be.
import path from "node:path";
import os from "node:os";
import {
  runIntentLoop, anthropicCaller, anthropicStreamingCaller, claimsCompletion as coreClaimsCompletion, ToolTelemetry,
  type IntentAdapter, type IntentContextBase, type IntentToolDef, type IntentGate,
  type ToolCallRecord, type IntentOutcome,
} from "@autom8ionlab/agent-core";
import type { ActionCategory, PrincipalId } from "./types";
import { can } from "./tiers";
import { draft as approvalDraft, shortCode } from "./approvals";
import { classify as classifySensitive } from "./sensitivity";
import { append as ledgerAppend } from "./ledger";
import { OWNER_FIRST } from "./owner";
import { PROSPECT_TOOLS } from "./prospecting/intentTools";
import {
  getAgentSettings, settingsFor, modelChain, narrowIntCap, filterTools, statusRefusal, takeModelCallSlot,
  ignoredModelReason, type EffectiveAgentSettings, type ModelTarget,
} from "./agentSettings";
import { geminiApiKey, geminiCaller } from "./gemini";

/** The router's built-in model. The OS per-agent setting (agentSettings.ts) overrides it when set. */
const MODEL = "claude-sonnet-5";
/** The router's built-in turn and token caps — OS limits may narrow them, never raise them. */
const ROUTER_MAX_TURNS = 6;
const ROUTER_MAX_TOKENS = 1200;

/**
 * Owner-originated dispatch runs without an approval row (owner decision 2026-09-14): when the owner
 * texts, emails, calls or types "have FRIDAY …", their ask is the approval. Other principals, other
 * tools, and other sources keep the queue. Pure so it's unit-tested.
 */
// Owner rule 2026-09-15: "if I ask an agent to do something then there should be no approval needed
// from me again — I asked for the task." Their own ask over a live channel runs any tool without an
// approval row, EXCEPT money-adjacent ones (their choice: spending still gets one confirmation) —
// business calls (Clara has no purchase power) and contracts/proposals out for signature. Blocked
// categories stay blocked (the gate checks those first). Any OTHER principal — e.g. an instruction
// inside a client's email — still hits the approval queue.
const OWNER_CONFIRM_TOOLS = new Set(["send_for_signature"]);
const OWNER_CONFIRM_CATEGORIES = new Set(["call.business"]);
// "office" (2026-09-30): the Office app's Prospects area writes through Clara's own
// /api/prospects/* routes, not this intent loop — IntentContextBase.source doesn't carry it today.
// Added here anyway, forward-wiring for whenever a later PR routes an Office-originated chat turn
// through this same gate; a plain string Set costs nothing to widen early.
const LIVE_OWNER_SOURCES = new Set(["sms", "voice", "chat", "email", "office"]);

export function delegationForce(toolName: string, ctx: { principal: string; source: string; scheduled?: unknown }, category?: string): boolean {
  if (ctx.principal !== "owner" || !LIVE_OWNER_SOURCES.has(ctx.source)) return false;
  // A scheduled run (OS clara.instruction) carries source "chat" for reply shaping, but nobody is
  // asking live: the owner confirmed a brief, not each send. No waiver — irreversible tools queue.
  if (ctx.scheduled) return false;
  if (OWNER_CONFIRM_TOOLS.has(toolName)) return false;
  if (category && OWNER_CONFIRM_CATEGORIES.has(category)) return false;
  return true;
}

export interface IntentContext extends IntentContextBase {
  principal: PrincipalId;
  /** Where the live turn came from (phone number / email address), non-web channels only. Tools
   *  that hand work off can use it to route the result back to the same place. */
  from?: string;
  /** Channel-native id of the live turn (MessageSid, CallSid, Gmail message id). */
  requestRef?: string;
  /** Narrowed from the base so handlers get CLARA's full ToolDef (with `run`), not a bare shape. */
  deferSlow?: (tool: ToolDef, args: Record<string, unknown>) => void;
  /**
   * P2.7 streaming: model text deltas forwarded as they generate, for the chat route to pipe to
   * the browser. Provisional — the loop's composed reply stays authoritative. Absent = the
   * non-streaming caller, byte-for-byte the old behaviour.
   */
  onToken?: (text: string) => void;
  /**
   * Set by the OS `clara.instruction` handler (an owner-described schedule). Never gets the
   * owner-ask waiver (see delegationForce). `readOnly` (shadow, or drafting for approval): only
   * READ_ONLY_TOOLS execute; every other call is blocked with PROPOSED_MARK and kept in
   * outcome.calls as the plan / the draft the owner approves.
   */
  scheduled?: { readOnly: boolean };
}

/**
 * Tools that only read. Allowlist, not denylist: a new tool stays out of read-only runs until
 * someone decides it is a pure read. Deliberately excluded although they look like reads:
 * whats_waiting_on_me (marks decisions as asked), work_queue (can cancel), put_through_list (can
 * add), run_subagent (open-ended), and every prospecting tool.
 */
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "get_weather", "find_local_business", "get_directions", "geocode_address", "web_search",
  "list_subscriptions", "find_email", "list_blocked", "read_thread",
  "drive_search", "drive_read",
  "list_calendar", "find_free_slot", "check_availability", "find_appointment",
  "list_tasks", "list_followups", "brief_me",
  "project_status", "client_status", "delegation_status", "agent_status",
  "pipelines_list", "stages_list", "pipeline_status", "deal_lookup", "invoice_status",
  "proposals_list", "contracts_list", "signature_status", "crm_lookup", "recall_sessions",
]);

/** The block reason a read-only scheduled run gives a non-read tool. Callers find the proposed
 *  actions by this marker in ToolCallRecord.resultLine. */
export const PROPOSED_MARK = "PROPOSED — read-only scheduled run, recorded for review and not executed";

/** Pure: does a read-only scheduled run refuse to execute this tool? */
export function readOnlyBlocks(toolName: string, ctx: { scheduled?: { readOnly: boolean } }): boolean {
  return ctx.scheduled?.readOnly === true && !READ_ONLY_TOOLS.has(toolName);
}

// Re-exported so the many callers that import these from here keep working. The shapes are the
// shared ones — a caller cannot end up holding a subtly different IntentOutcome.
export type { ToolCallRecord, IntentOutcome };

// ── Tool definitions ────────────────────────────────────────────────────────────────────────────

/**
 * The shared tool shape plus the one thing that is CLARA's alone: which tier-table row governs it.
 *
 * FRIDAY answers the same act-vs-ask question through its own authority model, so the
 * category cannot live in the shared type — but everything else about a tool is identical for
 * both, which is why only this one field is added here.
 */
export type ToolDef = IntentToolDef<IntentContext> & {
  /** Tier-table category. Every tool has one; this is what makes those rows real. */
  category: ActionCategory;
};

function s(v: unknown): string { return typeof v === "string" ? v : ""; }
function n(v: unknown, dflt: number): number { return typeof v === "number" && Number.isFinite(v) ? v : dflt; }

/** drive_read window per call. The ICP doc alone is ~7k chars; 2k (the old cap) hid most of it. */
const DRIVE_READ_WINDOW = 12_000;

/** Pure: one page of a long text. `next` is the offset to continue from, or null when done. */
export function pageText(full: string, offset: number, window: number): { text: string; next: number | null; total: number } {
  const start = Math.max(0, Math.min(Math.floor(offset), full.length));
  const end = Math.min(full.length, start + window);
  return { text: full.slice(start, end), next: end < full.length ? end : null, total: full.length };
}

const DRIVE_EDIT_OPS = ["docs-insert", "docs-replace", "sheets-write", "drive-replace-content"] as const;
type DriveEditOpName = (typeof DRIVE_EDIT_OPS)[number];

/**
 * Pure: turn drive_edit's flat tool args into the per-op payload object applyApprovedDriveEdit
 * expects. Until 2026-09-23 the tool passed one bare string for every op, which the executor could
 * not read (docs-insert sent no text; docs-replace threw) — every Doc edit failed. Exported for tests.
 */
export function buildDriveEditPayload(a: Record<string, unknown>): { op: DriveEditOpName; payload: unknown } {
  const op = (DRIVE_EDIT_OPS as readonly string[]).includes(s(a.op)) ? s(a.op) as DriveEditOpName : "docs-insert";
  switch (op) {
    case "docs-insert": return { op, payload: { text: s(a.text) } };
    case "docs-replace": return { op, payload: { replacements: Array.isArray(a.replacements) ? a.replacements : [] } };
    case "sheets-write": return { op, payload: { range: s(a.range), values: Array.isArray(a.values) ? a.values : [], mode: a.mode === "append" ? "append" : "overwrite" } };
    case "drive-replace-content": return { op, payload: { content: s(a.text) } };
  }
}

// Autonomy Spec v0.1, item #6: block dispatching new work for a client with a real overdue
// invoice, until it's paid or the owner explicitly overrides. Real Stripe-backed data via the same
// invoices_list call invoice_status already uses — resolves the name to a CRM contact the same
// way create_deal does (contacts_list search), refusing to block on an ambiguous or absent match
// rather than guessing who "the client" is.
async function overdueInvoiceBlock(clientName: string): Promise<string | null> {
  const { osClient, osEnabled } = await import("./osClient");
  if (!osEnabled()) return null;
  const people = (unwrapTool(await osClient.callTool("contacts_list", { search: clientName, limit: 5 })) ?? []) as
    Array<{ id?: string }>;
  const contacts = Array.isArray(people) ? people : [];
  if (contacts.length !== 1) return null;
  const rows = (unwrapTool(await osClient.callTool("invoices_list", { status: "eq.overdue", contact_id: String(contacts[0].id), limit: 5 })) ?? []) as
    Array<{ number?: string; total?: number }>;
  if (!Array.isArray(rows) || !rows.length) return null;
  const num = (v: unknown): number => { const x = Number(String(v ?? "")); return Number.isFinite(x) ? x : 0; };
  const r = rows[0];
  return `Blocked — ${clientName} has an overdue invoice (#${r.number ?? "?"}${num(r.total) ? `, $${num(r.total).toLocaleString()}` : ""}). Say "do it anyway" to override.`;
}

export const TOOLS: ToolDef[] = [
  {
    name: "deep_work",
    description:
      `THE tool for any request whose answer is a document, plan, or report — if ${OWNER_FIRST} asks for something that would take a person hours at a desk, this is it. Triggers include: 'I need a proposal for <client>', 'draft the contract/bylaws/agreement set', 'research X and write it up', 'turn this into a polished client PDF', 'build me a report/document package', or any ask for 'docs', 'documents', or 'deliverables'. Runs autonomously in the background — researches the subject, builds branded documents (PDF/DOCX/XLSX), files them in Drive, and pings ${OWNER_FIRST} with links plus anything needing their call. Do NOT fall through to the conversational engine for these — it talks about document work without producing files. NOT for quick questions, calendar/email reads, or single Drive lookups.`,
    input_schema: {
      type: "object",
      properties: {
        task: { type: "string", description: `The full work request in ${OWNER_FIRST}'s words, including the subject/client and the deliverables wanted.` },
        client: { type: "string", description: "Client or counterparty name, when the work is for one." },
        when: { type: "string", enum: ["now", "queue"], description: `'now' runs immediately; 'queue' hands it to the overnight shift (${OWNER_FIRST} saying 'tonight/overnight/queue it' means queue). Omit to choose by time of day — evening asks queue by default.` },
        override_overdue_gate: { type: "boolean", description: `Set true only if ${OWNER_FIRST} explicitly said to proceed despite an overdue invoice after being told about it (e.g. "do it anyway").` },
      },
      required: ["task"],
    },
    // drive.create is the honest tier row: the session's only externally-visible effect is new
    // files in the owner's own Drive. Reversible by construction — no sends, no edits to existing
    // documents; anything outbound the work implies is produced as a DRAFT deliverable.
    category: "drive.create",
    reversible: true,
    speed: "slow",
    describe: (a) => `Deep work${s(a.when) === "queue" ? " (overnight)" : ""}: ${s(a.task).slice(0, 100)}`,
    run: async (a) => {
      const task = s(a.task).trim();
      if (!task) return { ok: false, line: "deep_work: no task given." };
      const clientName = s(a.client).trim() || undefined;
      if (clientName && a.override_overdue_gate !== true) {
        const blocked = await overdueInvoiceBlock(clientName).catch(() => null);
        if (blocked) return { ok: false, line: blocked };
      }
      // Evening default: 21:00–07:00 queues unless the owner explicitly said now. Daytime runs now.
      const hour = new Date().getHours();
      const when = s(a.when) === "now" ? "now" : s(a.when) === "queue" ? "queue" : hour >= 21 || hour < 7 ? "queue" : "now";
      const dw = await import("./deepwork");
      if (when === "queue") {
        const { line } = await dw.enqueueDeepWork(task, { clientName });
        return { ok: true, line };
      }
      const { line } = dw.startDeepWork(task, { clientName });
      return { ok: true, line };
    },
  },
  {
    name: "run_subagent",
    description:
      `Hand ONE task to a member of your own department and return their report: front-desk (leads/CRM/screening), scheduler (calendar surgery), inbox-triage (mail sweeps/subscriptions), contracts-docs (document drafting/filing), researcher (deep research), advisor (${OWNER_FIRST}-facing strategy counsel). Each runs with its own narrow tool set; anything irreversible inside their run still queues for ${OWNER_FIRST}. Use when the task fits a specialist better than doing it yourself.`,
    input_schema: {
      type: "object",
      properties: {
        subagent: { type: "string", enum: ["front-desk", "scheduler", "inbox-triage", "contracts-docs", "researcher", "advisor"] },
        task: { type: "string", description: "The single task, fully stated — the specialist sees only this and its own tools." },
      },
      required: ["subagent", "task"],
    },
    category: "research.run",
    reversible: true,
    speed: "slow",
    describe: (a) => `Run ${s(a.subagent)} sub-agent: ${s(a.task).slice(0, 80)}`,
    run: async (a, ctx) => {
      const task = s(a.task).trim();
      if (!task) return { ok: false, line: "run_subagent: no task given." };
      const { subAgentById, SOULS_DIR, applySubagentSettings } = await import("./subagents");
      const def = subAgentById(s(a.subagent));
      if (!def) return { ok: false, line: `run_subagent: no such department member "${s(a.subagent)}".` };
      // OS per-agent settings: the subagent's own entry (`clara.<id>`) when it has one, else CLARA's.
      // The OS already resolves a subagent as parent-narrowed (status, tools, limits); the roster is
      // narrowed again here in code, so nothing can widen past CLARA's own settings.
      const snap = await getAgentSettings();
      const subS = settingsFor(snap, def.id);
      if (statusRefusal(subS, def.name)) return { ok: false, line: `run_subagent: ${def.name} is ${subS.status} in the OS settings — not started.` };
      const key = process.env.ANTHROPIC_API_KEY;
      if (!key && !usableGemini(modelChain(subS, MODEL))) return { ok: false, line: "run_subagent: no planning model available." };
      const scoped = applySubagentSettings(def, snap);
      const { runSubAgent, loadSubAgentSoul } = await import("@autom8ionlab/agent-core");
      const soul = withSubagentPersona(await loadSubAgentSoul(SOULS_DIR, def), subS);
      const out = await runSubAgent(task, { ...ctx, deferSlow: undefined }, adapter(key ?? "", undefined, subS, snap.root), scoped, soul);
      return { ok: !out.failed, line: `${def.name} reports:\n${out.reply.slice(0, 1200)}` };
    },
  },
  {
    name: "work_queue",
    description:
      "The overnight shift's queue — what's queued, running, done, or failed, and cancel a job by id. Use for 'what's queued for tonight', 'cancel that job', 'did the overnight work finish'.",
    input_schema: {
      type: "object",
      properties: {
        cancel: { type: "string", description: "Job id (or its #suffix) to cancel. Omit to just list." },
      },
    },
    category: "drive.read",
    reversible: true,
    speed: "fast",
    describe: (a) => (s(a.cancel) ? `Cancel queued job ${s(a.cancel)}` : "List the overnight queue"),
    run: async (a) => {
      const dw = await import("./deepwork");
      const wanted = s(a.cancel).replace(/^#/, "").trim();
      if (wanted) {
        const jobs = await dw.listQueue();
        const hit = jobs.find((j) => j.id === wanted || j.id.endsWith(wanted));
        if (!hit) return { ok: false, line: `work_queue: no job matching "${wanted}".` };
        const out = await dw.cancelQueued(hit.id);
        return { ok: true, line: out?.state === "cancelled" ? `Cancelled #${hit.id.slice(-5)} (${String((hit.payload as { task?: string }).task ?? "").slice(0, 60)}).` : `#${hit.id.slice(-5)} already ${out?.state} — nothing to cancel.` };
      }
      const jobs = await dw.listQueue();
      if (!jobs.length) return { ok: true, line: "The overnight queue is empty." };
      const lines = jobs.slice(-12).map((j) => {
        const task = String((j.payload as { task?: string }).task ?? "").slice(0, 70);
        return `· #${j.id.slice(-5)} [${j.state}${j.partial ? " partial" : ""}] ${task} (attempt ${j.attempts}/${j.maxAttempts})`;
      });
      return { ok: true, line: `Overnight queue:\n${lines.join("\n")}` };
    },
  },
  {
    name: "convene_meeting",
    description:
      `Call a meeting with ${OWNER_FIRST} in the Office War Room — use when something needs live discussion rather than a message: a decision with tradeoffs, a problem spanning agents, or news that warrants talking through. Creates the room with your topic on the record and pings ${OWNER_FIRST} with the link. Also use when ${OWNER_FIRST} says 'set up a meeting about X'.`,
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short meeting title." },
        topic: { type: "string", description: "Your opening statement — why you called this and what needs deciding." },
        include: { type: "array", items: { type: "string", enum: ["friday"] }, description: "Sibling agents who should be in the room too." },
      },
      required: ["title", "topic"],
    },
    // Internal coordination with the owner — creates a room in their own Office and pings them; nothing
    // reaches outside the company.
    category: "event.coordinate",
    reversible: true,
    speed: "fast",
    describe: (a) => `Convene meeting: ${s(a.title).slice(0, 60)}`,
    run: async (a) => {
      const base = (process.env.OFFICE_BASE_URL ?? "http://127.0.0.1:3636").replace(/\/$/, "");
      const include = Array.isArray(a.include) ? (a.include as string[]).filter((x) => x === "friday") : [];
      const r = await fetch(`${base}/api/room`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: s(a.title), topic: s(a.topic), convenedBy: "clara", participants: ["clara", ...include] }),
        signal: AbortSignal.timeout(10_000),
      }).catch(() => null);
      if (!r || !r.ok) return { ok: false, line: "convene_meeting: the Office isn't reachable — meeting not created." };
      const j = (await r.json()) as { room?: { id: string } };
      if (!j.room?.id) return { ok: false, line: "convene_meeting: the Office answered but no room came back." };
      const link = `${process.env.OFFICE_PUBLIC_URL ?? "https://office.example.com"}/room`;
      const { notifyOwner } = await import("./notify");
      await notifyOwner({ kind: "meeting.convened", text: `CLARA called a meeting: "${s(a.title)}" — ${link}` }).catch(() => {});
      return { ok: true, line: `convene_meeting: room "${s(a.title)}" is open and ${OWNER_FIRST}'s been pinged — ${link}` };
    },
  },
  {
    name: "get_weather",
    description:
      "Get the weather forecast for today or the next few days, at home or at a named place ('Central Park', 'Chicago IL'). Use for any weather question, including ones about a specific trip or destination.",
    input_schema: {
      type: "object",
      properties: {
        location: { type: "string", description: "Place name to look up. Omit for the owner's home." },
        days: { type: "number", description: "How many days ahead, including today. Default 1." },
      },
    },
    category: "travel.research",
    reversible: true,
    speed: "fast",
    describe: (a) => `Check the weather${s(a.location) ? ` at ${s(a.location)}` : ""}`,
    run: async (a) => {
      const { forecastDays, geocodePlace, weatherConfigured } = await import("./weather");
      if (!(await weatherConfigured())) return { ok: false, line: "Weather: not configured (needs the Google Maps API key and a home location)." };

      const place = s(a.location).trim();
      let at: { lat: number; lng: number } | undefined;
      let label = "home";
      if (place) {
        const hit = await geocodePlace(place);
        if (!hit) return { ok: false, line: `Weather: couldn't find a location matching "${place}".` };
        at = { lat: hit.lat, lng: hit.lng };
        label = hit.label;
      }

      const days = Math.min(Math.max(n(a.days, 1), 1), 10);
      const r = await forecastDays(days, at);
      if (!r.ok) return { ok: false, line: `Weather: ${r.error ?? "lookup failed"}` };
      if (!r.days.length) return { ok: false, line: `Weather: no forecast data for ${label}.` };

      const lines = r.days.map((d) => `${d.date}: ${d.description || d.conditionCode} — high ${d.highF}°/low ${d.lowF}°, ${d.precipProbPct}% chance of rain`);
      return { ok: true, line: `Weather at ${label}:\n${lines.join("\n")}` };
    },
  },
  {
    name: "find_local_business",
    description:
      "Look up a real-world local business by name or type and answer questions about it — hours, whether it's open right now, phone number, address, rating, or a Google Maps link. Use for 'what time does X open/close', 'is X open now', 'what's the phone number for X', 'find a Y near me', 'look up Z'. Read-only — does not contact or call the business. Backed by Google Places; answers reflect Google's current listing data, which can occasionally be stale or incomplete.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to look for, e.g. 'bowling alley', \"Joe's Plumbing\", 'pharmacy'. Include distinguishing details if known." },
        near: { type: "string", description: "Place name to search near, e.g. 'Austin TX' or 'downtown Chicago'. Omit to search near the owner's home." },
      },
      required: ["query"],
    },
    category: "travel.research",
    reversible: true,
    speed: "fast",
    describe: (a) => `Look up "${s(a.query)}"${s(a.near) ? ` near ${s(a.near)}` : ""}`,
    run: async (a) => {
      const { findBusiness, pickBestCandidate, placesConfigured } = await import("./places");
      if (!placesConfigured()) return { ok: false, line: "Local business search: not configured (needs the Google Places API key)." };

      const query = s(a.query).trim();
      if (!query) return { ok: false, line: "Local business search: no query given, so I didn't search." };

      let locationBias: { lat: number; lng: number } | undefined;
      const near = s(a.near).trim();
      if (near) {
        const { geocodePlace } = await import("./weather");
        const hit = await geocodePlace(near);
        if (hit) locationBias = { lat: hit.lat, lng: hit.lng };
      }
      if (!locationBias) {
        const { loadConfig } = await import("./config");
        const cfg = await loadConfig();
        if (cfg.homeLat != null && cfg.homeLng != null) locationBias = { lat: cfg.homeLat, lng: cfg.homeLng };
      }

      const res = await findBusiness(query, { locationBias, includeHours: true });
      if (!res.ok) return { ok: false, line: `Local business search: ${res.error ?? "lookup failed"}` };
      if (!res.candidates.length) return { ok: true, line: `Local business search "${query}": no matches.` };

      const best = pickBestCandidate(res.candidates, { requirePhone: false });
      if (!best) return { ok: true, line: `Local business search "${query}": found listings, but none currently operational.` };

      const lines = [`${best.name}${best.formattedAddress ? ` — ${best.formattedAddress}` : ""}`];
      if (best.phoneE164) lines.push(`Phone: ${best.phoneE164}`);
      if (best.openNow != null) lines.push(best.openNow ? "Open now" : "Currently closed");
      if (best.hoursWeekly?.length) lines.push(`Hours:\n${best.hoursWeekly.map((h) => `  ${h}`).join("\n")}`);
      if (best.rating != null) lines.push(`Rating: ${best.rating}${best.userRatingCount ? ` (${best.userRatingCount} reviews)` : ""}`);
      if (best.googleMapsUri) lines.push(`Map: ${best.googleMapsUri}`);

      const others = res.candidates.filter((c) => c.placeId !== best.placeId).slice(0, 2);
      const otherLine = others.length ? `\nOther nearby matches: ${others.map((c) => c.name).join("; ")}` : "";

      return { ok: true, line: `${lines.join("\n")}${otherLine}` };
    },
  },
  {
    name: "get_directions",
    description:
      "Get driving time and distance to a destination, plus a Google Maps directions link. Use for 'how long to get to X', 'directions to Y', 'how far is X'.",
    input_schema: {
      type: "object",
      properties: {
        destination: { type: "string", description: "Where to go — an address, place name, or business name." },
        origin: { type: "string", description: "Where to start from. Omit for the owner's home." },
      },
      required: ["destination"],
    },
    category: "travel.research",
    reversible: true,
    speed: "fast",
    describe: (a) => `Get directions to ${s(a.destination)}`,
    run: async (a) => {
      const { getDirections, directionsConfigured } = await import("./maps");
      if (!directionsConfigured()) return { ok: false, line: "Directions: not configured (needs the Google Maps API key)." };

      const destination = s(a.destination).trim();
      if (!destination) return { ok: false, line: "Directions: no destination given, so I didn't look anything up." };

      const origin = s(a.origin).trim() || undefined;
      let home: { lat: number; lng: number } | undefined;
      if (!origin) {
        const { loadConfig } = await import("./config");
        const cfg = await loadConfig();
        if (cfg.homeLat != null && cfg.homeLng != null) home = { lat: cfg.homeLat, lng: cfg.homeLng };
      }

      const r = await getDirections(destination, { origin, home });
      if (!r.ok) return { ok: false, line: `Directions: ${r.error ?? "lookup failed"}` };

      const lines = [`To ${destination}: ${r.durationText ?? "unknown time"}${r.distanceMiles != null ? ` (${r.distanceMiles} mi)` : ""}`];
      if (r.mapsUrl) lines.push(`Map: ${r.mapsUrl}`);
      return { ok: true, line: lines.join("\n") };
    },
  },
  {
    name: "geocode_address",
    description:
      "Find the coordinates for an address, or confirm/clean up an address, and get a Google Maps link to it. Use for 'what's the address for X', 'where is Y located', 'open this address in maps'.",
    input_schema: {
      type: "object",
      properties: {
        address: { type: "string", description: "The address or place description to look up." },
      },
      required: ["address"],
    },
    category: "travel.research",
    reversible: true,
    speed: "fast",
    describe: (a) => `Look up the location of "${s(a.address)}"`,
    run: async (a) => {
      const { geocodeAddress, geocodeConfigured } = await import("./maps");
      if (!geocodeConfigured()) return { ok: false, line: "Geocoding: not configured (needs the Google Maps API key)." };

      const address = s(a.address).trim();
      if (!address) return { ok: false, line: "Geocoding: no address given, so I didn't look anything up." };

      const r = await geocodeAddress(address);
      if (!r.ok) return { ok: false, line: `Geocoding: ${r.error ?? "lookup failed"}` };

      const lines = [r.formattedAddress ?? address];
      if (r.lat != null && r.lng != null) lines.push(`Coordinates: ${r.lat}, ${r.lng}`);
      if (r.mapsUrl) lines.push(`Map: ${r.mapsUrl}`);
      return { ok: true, line: lines.join("\n") };
    },
  },
  {
    name: "web_search",
    description:
      "Search the web for general information and answer from the top results. Use for questions about facts, current events, products, or anything else that isn't a specific local business (use find_local_business for that) and doesn't need a multi-minute deep-research pass (use deep_work for that).",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to search for." },
      },
      required: ["query"],
    },
    category: "travel.research",
    reversible: true,
    speed: "fast",
    describe: (a) => `Search the web for "${s(a.query)}"`,
    run: async (a) => {
      const { webSearch, braveSearchConfigured } = await import("./brave-search");
      if (!braveSearchConfigured()) return { ok: false, line: "Web search: not configured (needs a Brave Search API key)." };

      const query = s(a.query).trim();
      if (!query) return { ok: false, line: "Web search: no query given, so I didn't search." };

      const res = await webSearch(query);
      if (!res.ok) return { ok: false, line: `Web search: ${res.error ?? "search failed"}` };
      if (!res.results.length) return { ok: true, line: `Web search "${query}": no results.` };

      const lines = res.results.slice(0, 5).map((r) => `${r.title} — ${r.url}${r.snippet ? `\n  ${r.snippet}` : ""}`);
      return { ok: true, line: `Web search "${query}":\n${lines.join("\n")}` };
    },
  },
  {
    name: "sweep_inbox",
    description:
      "Triage and clean the owner's work inbox: archive bulk/newsletter/finished mail, mark routine mail read, label the rest for review. Use for any request about cleaning, tidying, sorting, organising, analysing, or going through email. Never deletes anything.",
    input_schema: {
      type: "object",
      properties: {
        dry_run: { type: "boolean", description: "Preview only, change nothing. Use when the owner asks what it WOULD do." },
        max_scan: { type: "number", description: "How many unread to examine. Default 200. Use 500 to clear a whole backlog." },
      },
    },
    category: "email.work",
    reversible: true, // archive is reversible: mail stays in All Mail
    speed: "slow",
    describe: (a) => `Sweep the inbox${a.dry_run ? " (dry run)" : ""}`,
    run: async (a) => {
      const { runInboxZero } = await import("./inboxZero");
      const { sweepFollowUp } = await import("./inboxSweep");
      const r = await runInboxZero({
        dryRun: a.dry_run === true,
        maxScan: n(a.max_scan, 200),
        maxMutations: 100_000,
      });
      return { ok: true, line: sweepFollowUp(r) };
    },
  },
  {
    name: "list_subscriptions",
    description:
      "Inventory the owner's email subscriptions — who is mailing them in bulk, how often, and whether each one can be safely unsubscribed. Use for any request about subscriptions, newsletters, mailing lists, or 'who keeps emailing me'. Read-only; unsubscribes nothing.",
    input_schema: {
      type: "object",
      properties: { max: { type: "number", description: "Messages to scan. Default 250." } },
    },
    category: "email.work",
    reversible: true,
    speed: "slow",
    describe: () => "List email subscriptions",
    run: async (a) => {
      const { scanSubscriptions } = await import("./subscriptions");
      const groups = await scanSubscriptions({ max: n(a.max, 250) });
      if (!groups.length) return { ok: true, line: "Subscriptions: nothing with a List-Unsubscribe header in the scanned mail." };
      const top = groups.slice(0, 20).map((g, i) =>
        `${i + 1}. ${g.name} <${g.sender}> — ${g.count} email${g.count === 1 ? "" : "s"}${g.actionable ? "" : " (manual only)"}`);
      const actionable = groups.filter((g) => g.actionable).length;
      return {
        ok: true,
        line: `Subscriptions (${groups.length} senders, ${actionable} I can leave for you):\n${top.join("\n")}`,
      };
    },
  },
  {
    name: "unsubscribe_from",
    description:
      "Unsubscribe the owner from ONE named sender, using the List-Unsubscribe header. Call list_subscriptions first to get the exact sender address. Never guess an address.",
    input_schema: {
      type: "object",
      properties: { sender: { type: "string", description: "Exact sender email address from list_subscriptions." } },
      required: ["sender"],
    },
    category: "email.work",
    // Leaves the business: either a POST to the sender's endpoint or an email to them. Both tell
    // a third party something, and neither can be taken back — so it always confirms first.
    reversible: false,
    speed: "slow",
    describe: (a) => `Unsubscribe from ${s(a.sender)}`,
    run: async (a) => {
      const { scanSubscriptions, unsubscribeFrom } = await import("./subscriptions");
      const target = s(a.sender).toLowerCase().trim();
      // Re-scan rather than trust the address: the header carries the endpoint, and acting on an
      // address the model produced from memory could POST somewhere never inventoried.
      const groups = await scanSubscriptions({ max: 250 });
      const hit = groups.find((g) => g.sender === target);
      if (!hit) return { ok: false, line: `Subscriptions: "${target}" isn't in the current inventory, so I didn't do anything.` };
      const r = await unsubscribeFrom(hit);
      return { ok: r.ok, line: `${hit.name}: ${r.detail}` };
    },
  },
  {
    name: "find_email",
    description:
      "Search the owner's work mailbox — including archived and already-read mail. Use for 'find that email from…', 'did X ever reply', 'what did the accountant send in June'. Takes a Gmail search query. Read-only.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: 'Gmail search syntax, e.g. "from:casey@acme.com after:2026/06/01" or "invoice has:attachment".' },
        max: { type: "number", description: "How many results. Default 15." },
      },
      required: ["query"],
    },
    category: "email.work",
    reversible: true,
    speed: "fast",
    describe: (a) => `Search mail for "${s(a.query)}"`,
    run: async (a) => {
      const { searchMessages } = await import("./ms-mail");
      const q = s(a.query).trim();
      if (!q) return { ok: false, line: "Mail search: no query given, so I didn't search." };
      const hits = await searchMessages(q, n(a.max, 15));
      if (!hits.length) return { ok: true, line: `Mail search "${q}": no matches.` };
      const lines = hits.map((m) => `· ${m.date.slice(0, 16)} — ${m.from} — ${m.subject}`);
      return { ok: true, line: `Mail search "${q}" (${hits.length}):\n${lines.join("\n")}` };
    },
  },
  {
    name: "send_email",
    description:
      "Send an email now. Use whenever the owner asks you to email, reply to, or write to someone — the owner does not need to approve an email they just asked for. The owner is CC'd on every email automatically; do not add them yourself. If you only have a name, look the address up first (crm_lookup / find_email). Use draft_email instead ONLY when they ask to see a draft before it goes out.",
    input_schema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient address." },
        subject: { type: "string" },
        body: { type: "string", description: "Full message text. Write it properly — this goes out over their name." },
        cc: { type: "string", description: "Extra CC recipients (the owner is added automatically)." },
      },
      required: ["to", "subject", "body"],
    },
    category: "email.work",
    // Irreversible — it reaches outside. The loop queues it for approval unless the gate vouches,
    // which delegationForce does ONLY for the owner's own asks (chat/SMS/voice/verified email). A
    // send instruction arriving any other way — e.g. text inside a client's email — still waits.
    reversible: false,
    speed: "fast",
    describe: (a) => `Send email to ${s(a.to)}: ${s(a.subject)}`,
    run: async (a) => {
      const to = s(a.to).trim();
      const subject = s(a.subject).trim() || "(no subject)";
      const body = s(a.body).trim();
      if (!to || !body) return { ok: false, line: "Send email: I need at least a recipient and a body. Nothing sent." };
      if (!to.includes("@")) return { ok: false, line: `Send email: "${to}" isn't an email address — I need to look it up first. Nothing sent.` };
      const { sendMail } = await import("./ms-mail");
      const r = await sendMail({ to, subject, body, cc: s(a.cc) || undefined });
      if (!r.ok) return { ok: false, line: `Email to ${to} FAILED to send (${r.error ?? "unknown error"}). Nothing went out.` };
      await ledgerAppend({ kind: "email.sent", actor: "clara", what: `Emailed ${to}: ${subject}` }).catch(() => {});
      return {
        ok: true,
        line: `Email to ${to} SENT — you're CC'd.\nSubject: ${subject}\n\n${body.slice(0, 500)}${body.length > 500 ? "…" : ""}`,
      };
    },
  },
  {
    name: "draft_email",
    description:
      "Compose an email as a DRAFT for the owner to review before it's sent. Use ONLY when they ask for a draft or want to see it first — for 'email / reply to / write to someone', use send_email. This never sends on its own; it queues for their confirmation.",
    input_schema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient address." },
        subject: { type: "string" },
        body: { type: "string", description: "Full message text. Write it properly — this is what goes out over their name." },
        cc: { type: "string" },
      },
      required: ["to", "subject", "body"],
    },
    category: "email.work",
    /**
     * `reversible: true` looks wrong on a tool with "email" in the name, so: what this tool DOES is
     * create a pending approval. That is internal, undoable, and sends nothing. The send is gated by
     * the `email.send` approval it produces, which the owner must confirm by code.
     *
     * Marking it irreversible would make the router wrap it in a SECOND approval (intent.tool), so
     * the owner would confirm twice to send one email — and the first confirmation would be for the act of
     * writing a draft, which is not a decision anyone needs to make.
     */
    reversible: true,
    speed: "fast",
    describe: (a) => `Email ${s(a.to)}: ${s(a.subject)}`,
    run: async (a, ctx) => {
      const to = s(a.to).trim();
      const subject = s(a.subject).trim();
      const body = s(a.body).trim();
      if (!to || !body) return { ok: false, line: "Draft email: I need at least a recipient and a body. Nothing queued." };
      // kind "email.send" — the approval executor sendApprovedEmail() has existed since the
      // approvals queue was built and nothing had ever produced a row for it. This is that producer.
      const row = await approvalDraft({
        kind: "email.send",
        title: `Email ${to}: ${subject || "(no subject)"}`,
        summary: `Requested over ${ctx.source}. ${body.length} char body.`,
        requestor: ctx.principal,
        intent: { to, subject, body, cc: s(a.cc) || undefined },
      });
      return {
        ok: true,
        line: `Email to ${to} DRAFTED, not sent — say "yes, send it" and it goes.\nSubject: ${subject}\n\n${body.slice(0, 500)}${body.length > 500 ? "…" : ""}`,
      };
    },
  },
  {
    name: "block_sender",
    description:
      "Stop a sender's mail from reaching the owner's inbox. Use for spam, phishing, or anyone the owner says they don't want to hear from. Accepts one address, or a bare domain to block everything from it. Never deletes mail — it is archived and stays findable.",
    input_schema: {
      type: "object",
      properties: {
        sender: { type: "string", description: 'Address like "noreply@x.com", or a bare domain like "x.com" to block the whole domain.' },
        reason: { type: "string", description: "Short note on why, e.g. 'phishing pretending to be Amazon'." },
      },
      required: ["sender"],
    },
    category: "email.work",
    // Reversible: the entry can be removed and nothing is destroyed — blocked mail is archived,
    // not trashed, so unblocking restores the status quo completely.
    reversible: true,
    speed: "fast",
    describe: (a) => `Block ${s(a.sender)}`,
    run: async (a) => {
      const { addBlocked, normalizeSender } = await import("./blocklist");
      const { createFilter, ensureLabel } = await import("./ms-mail");
      const target = normalizeSender(s(a.sender));
      if (!target || !/[a-z0-9]/.test(target)) {
        return { ok: false, line: "Block: that isn't a usable address or domain, so I didn't block anything." };
      }

      // Layer 2 first, so its id can be stored with the entry. Moving out of the inbox + marking
      // read is the strongest action taken; the rule never deletes.
      //
      // GRAPH REWRITE: Outlook inbox rules move mail to a folder rather than tagging it, so there's
      // no separate "remove from inbox" action independent of a destination — if the "Clara/
      // Blocked" folder couldn't be created, fall back to Graph's well-known "archive" folder
      // alias so blocked mail still leaves the inbox rather than staying put with no label at all
      // (the Gmail original's removeLabelIds:["INBOX"] didn't depend on the label succeeding).
      let filterNote = "";
      let filterId: string | undefined;
      const labelId = await ensureLabel("Clara/Blocked").catch(() => null);
      const f = await createFilter(
        { from: target },
        { moveToFolder: labelId ?? "archive", markAsRead: true },
      );
      if (f.ok && f.value) {
        filterId = f.value;
        filterNote = " An Outlook inbox rule is in place, so it applies the moment mail arrives.";
      } else {
        filterNote = ` The server-side Outlook rule failed (${f.error ?? "unknown"}), so this applies on each inbox sweep rather than instantly.`;
      }

      const { added } = await addBlocked(target, s(a.reason) || undefined, filterId);
      const head = added ? `Blocked ${target}.` : `${target} was already blocked.`;
      return { ok: true, line: `${head} Their mail gets archived and marked read — nothing is deleted.${filterNote}` };
    },
  },
  {
    name: "list_blocked",
    description: "Show who the owner has blocked, and unblock. Read-only unless `unblock` is given.",
    input_schema: {
      type: "object",
      properties: { unblock: { type: "string", description: "Address or domain to UNBLOCK. Omit to just list." } },
    },
    category: "email.work",
    reversible: true,
    speed: "fast",
    describe: (a) => (s(a.unblock) ? `Unblock ${s(a.unblock)}` : "List blocked senders"),
    run: async (a) => {
      const { readBlocklist, removeBlocked } = await import("./blocklist");
      const { deleteFilter } = await import("./ms-mail");
      const un = s(a.unblock).trim();
      if (un) {
        const r = await removeBlocked(un);
        if (!r.removed) return { ok: false, line: `Unblock: "${un}" wasn't on the blocked list, so nothing changed.` };
        // Remove the paired Outlook rule too, or the sender stays blocked server-side while the
        // list says otherwise — a disagreement the owner would have no way to see.
        let note = "";
        if (r.row?.gmailFilterId) {
          const d = await deleteFilter(r.row.gmailFilterId);
          note = d.ok ? " Outlook rule removed too." : ` NOTE: the Outlook rule (${r.row.gmailFilterId}) could NOT be removed — ${d.error ?? "unknown"} — so their mail may still skip your inbox.`;
        }
        return { ok: true, line: `Unblocked ${r.row?.sender ?? un}.${note}` };
      }
      const rows = await readBlocklist();
      if (!rows.length) return { ok: true, line: "Blocked senders: none." };
      const lines = rows.map((r, i) =>
        `${i + 1}. ${r.sender}${r.reason ? ` — ${r.reason}` : ""}${r.gmailFilterId ? "" : " (sweep-only, no Outlook rule)"}`);
      return { ok: true, line: `Blocked senders (${rows.length}):\n${lines.join("\n")}` };
    },
  },
  // ── Drive, documents, vendors, events ─────────────────────────────────────────────────────────
  //
  // Every one of these was fully implemented with ZERO callers. `proposeEdit` and `proposeTrash` in
  // particular are the ONLY producers of the `drive.modify` and `drive.trash` approval kinds, whose
  // executors (applyApprovedDriveEdit / applyApprovedDriveTrash) had therefore never run once. They
  // did not need new logic — they needed a trigger, which is what a tool is.
  {
    name: "drive_search",
    description:
      "Find files in the owner's Google Drive by name or content. Use before reading or editing anything, to get the file id. Read-only.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Words to search for in the file name or contents." },
        max: { type: "number", description: "Default 10." },
      },
      required: ["query"],
    },
    category: "drive.read",
    reversible: true,
    speed: "fast",
    describe: (a) => `Search Drive for "${s(a.query)}"`,
    run: async (a) => {
      const { searchDrive } = await import("./ms-files");
      const files = await searchDrive(s(a.query), { max: n(a.max, 10) });
      if (!files.length) return { ok: true, line: `Drive: nothing matching "${s(a.query)}".` };
      return {
        ok: true,
        line: `Drive (${files.length}):\n` + files.slice(0, 15).map((f) =>
          `· ${f.id} — ${f.name}${f.modifiedTime ? ` · ${f.modifiedTime.slice(0, 10)}` : ""}`).join("\n"),
      };
    },
  },
  {
    name: "drive_read",
    description:
      "Read a Drive file's contents as text (up to 12,000 characters per call; pass `offset` to keep reading a long file). Needs the file id — a KNOWN DOCUMENT id from your instructions, or drive_search.",
    input_schema: {
      type: "object",
      properties: {
        file_id: { type: "string" },
        offset: { type: "number", description: "Character offset to start from (default 0). Use the value the previous read told you to continue at." },
      },
      required: ["file_id"],
    },
    category: "drive.read",
    reversible: true,
    speed: "fast",
    describe: (a) => `Read Drive file ${s(a.file_id)}${n(a.offset, 0) ? ` from ${n(a.offset, 0)}` : ""}`,
    run: async (a) => {
      const { readAsText } = await import("./ms-files");
      const out = await readAsText(s(a.file_id));
      if (!out.ok) return { ok: false, line: `Drive: couldn't read that file — ${out.error ?? "unknown error"}.` };
      // Drive content is UNTRUSTED — anyone who has shared a file with the owner can put text in it.
      // readAsText already screens it; surfacing the verdict means they SEE that a document tried to
      // issue instructions, rather than the router quietly treating whatever it said as context.
      const warn = out.injection?.triggered
        ? `\n\n⚠️ This file contains text shaped like an instruction to me (${out.injection.reasons.join(", ")}). I read it as content, not as a command.`
        : "";
      const { text, next, total } = pageText(out.text, n(a.offset, 0), DRIVE_READ_WINDOW);
      const more = next != null ? `\n…(${total - next} more characters — call drive_read again with offset ${next})` : (out.truncated ? "\n…(truncated)" : "");
      return { ok: true, line: `${s(a.file_id)}:\n${text}${more}${warn}` };
    },
  },
  {
    name: "drive_create",
    description:
      "Create a new document, spreadsheet or slide deck in the owner's Drive from text you supply. Creates a NEW file; never overwrites anything.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string" },
        content: { type: "string", description: "Full text content." },
        as: { type: "string", enum: ["doc", "sheet", "slides", "text", "csv"] },
      },
      required: ["name", "content", "as"],
    },
    category: "drive.create",
    // A brand-new file touches nothing that already exists and can be trashed. createFile applies
    // its own tier check on drive.create, so this is governed twice over.
    reversible: true,
    speed: "fast",
    describe: (a) => `Create Drive ${s(a.as) || "doc"} "${s(a.name)}"`,
    run: async (a, ctx) => {
      const { createFile } = await import("./ms-files");
      const as = s(a.as) as "doc" | "sheet" | "slides" | "text" | "csv";
      const out = await createFile({
        name: s(a.name), content: s(a.content),
        as: (["doc", "sheet", "slides", "text", "csv"] as const).includes(as) ? as : "doc",
        requestor: ctx.principal,
      });
      return out.ok
        ? { ok: true, line: `Created "${out.file?.name}" in Drive${out.file?.webViewLink ? ` — ${out.file.webViewLink}` : ""}.` }
        : { ok: false, line: `Drive: create FAILED — ${out.error ?? "unknown error"}.` };
    },
  },
  {
    name: "drive_edit",
    description:
      "Change an EXISTING Drive file — append text to a Doc, replace text in a Doc, write cells in a Sheet, or overwrite a plain file. " +
      "Read the file first (drive_read) so `find` strings are copied verbatim. When the owner asks directly it's applied at once; otherwise it queues for their confirmation.",
    input_schema: {
      type: "object",
      properties: {
        file_id: { type: "string" },
        change_summary: { type: "string", description: "One line describing the change, in plain English." },
        op: {
          type: "string",
          enum: ["docs-insert", "docs-replace", "sheets-write", "drive-replace-content"],
          description: "docs-insert appends `text` to the end of a Doc; docs-replace swaps each `replacements[].find` for its `replace` in a Doc; sheets-write writes `values` into `range`; drive-replace-content overwrites a plain (non-Google) file with `text`.",
        },
        text: {
          type: "string",
          description: "docs-insert: the text to append (start with \\n\\n for a new paragraph; use \\n between lines). drive-replace-content: the complete new file content.",
        },
        replacements: {
          type: "array",
          description: "docs-replace only: exact, case-sensitive text to find (copied verbatim from drive_read) and what to put in its place. Every occurrence of `find` is replaced, so make it specific.",
          items: {
            type: "object",
            properties: { find: { type: "string" }, replace: { type: "string" } },
            required: ["find", "replace"],
          },
        },
        range: { type: "string", description: "sheets-write only: A1 range, e.g. Sheet1!A2:C2." },
        values: {
          type: "array",
          description: "sheets-write only: rows of cell values.",
          items: { type: "array", items: { type: ["string", "number"] } },
        },
        mode: { type: "string", enum: ["overwrite", "append"], description: "sheets-write only (default overwrite)." },
      },
      required: ["file_id", "change_summary", "op"],
    },
    category: "drive.modify",
    /**
     * `reversible: true` for the same reason draft_email is: what this tool DOES is create a
     * pending `drive.modify` approval, which changes nothing. The edit is gated by that approval,
     * whose executor (applyApprovedDriveEdit) checks the head revision before touching the file.
     * Marking it irreversible would wrap it in a SECOND approval and make the owner confirm twice.
     */
    reversible: true,
    speed: "fast",
    describe: (a) => `Edit Drive file ${s(a.file_id)}: ${s(a.change_summary)}`,
    run: async (a, ctx) => {
      const { proposeEdit, normalizeDriveEditPayload } = await import("./ms-files");
      const built = buildDriveEditPayload(a);
      // Validate the shape HERE, before an approval row exists: a malformed ask should come back as
      // a question to the model, not as a queued approval that can only ever fail.
      const parsed = normalizeDriveEditPayload(built.op, built.payload);
      if (!parsed.ok) return { ok: false, line: `Drive edit FAILED: ${parsed.error}. Nothing was changed.` };
      const row = await proposeEdit({
        fileId: s(a.file_id),
        changeSummary: s(a.change_summary),
        op: built.op,
        payload: built.payload,
        requestor: ctx.principal,
      });
      // Owner rule 2026-09-15: their own ask is the approval — apply it now through the same executor
      // (applyApprovedDriveEdit still checks the head revision). Anyone else's ask stays queued.
      if (delegationForce("drive_edit", ctx, "drive.modify")) {
        const { approve } = await import("./approvals");
        const done = await approve(row.id, "owner asked directly — their ask is the approval");
        if (!done?.result?.ok) {
          return { ok: false, line: `Drive edit FAILED (${done?.result?.error ?? "unknown error"}). The file was not changed.` };
        }
        const refreshed = done.result.knowledgeRefreshed
          ? " My knowledge snapshot of it is refreshed too — say the word if you want company.md re-curated from it."
          : "";
        return { ok: true, line: `Drive edit DONE: ${s(a.change_summary)}.${refreshed}` };
      }
      return {
        ok: true,
        line: `Drive edit QUEUED, not applied: ${s(a.change_summary)}. Say "yes, go ahead" and I'll make the change.`,
      };
    },
  },
  {
    name: "drive_trash",
    description:
      "Move a Drive file to the trash. When the owner asks directly it's done at once; otherwise it queues for their confirmation. Trash, never permanent deletion.",
    input_schema: {
      type: "object",
      properties: { file_id: { type: "string" }, reason: { type: "string" } },
      required: ["file_id", "reason"],
    },
    category: "drive.delete",
    reversible: true, // creates the approval; the trash itself is gated by it
    speed: "fast",
    describe: (a) => `Trash Drive file ${s(a.file_id)}`,
    run: async (a, ctx) => {
      const { proposeTrash } = await import("./ms-files");
      const row = await proposeTrash({ fileId: s(a.file_id), reason: s(a.reason), requestor: ctx.principal });
      // Owner rule 2026-09-15: their own ask is the approval (trash stays recoverable).
      if (delegationForce("drive_trash", ctx, "drive.delete")) {
        const { approve } = await import("./approvals");
        const done = await approve(row.id, "owner asked directly — their ask is the approval");
        return done?.result?.ok
          ? { ok: true, line: `Moved to the Drive trash (recoverable): ${s(a.reason)}.` }
          : { ok: false, line: `Drive trash FAILED (${done?.result?.error ?? "unknown error"}). Nothing was moved.` };
      }
      return {
        ok: true,
        line: `Drive trash QUEUED, not done: ${s(a.reason)}. Say "yes, go ahead" and it goes to the trash (recoverable).`,
      };
    },
  },
  {
    name: "make_document",
    description:
      "Write a PDF — an itinerary, a summary, a brief, a checklist — from a description of what it should contain. Saved to the owner's vault.",
    input_schema: {
      type: "object",
      properties: {
        purpose: { type: "string", description: 'Title/purpose, e.g. "Travel itinerary — Austin trip".' },
        context: { type: "string", description: "Everything that should go in it." },
        filename: { type: "string", description: "Without extension, kebab-case." },
        kind: { type: "string", description: 'e.g. "itinerary", "summary", "brief", "checklist".' },
      },
      required: ["purpose", "context", "filename"],
    },
    category: "research.run",
    reversible: true, // writes a new file into their own vault
    speed: "slow",
    describe: (a) => `Generate document: ${s(a.purpose)}`,
    run: async (a) => {
      const { requestDocument } = await import("./documents");
      const out = await requestDocument({
        kind: (s(a.kind) || "summary") as Parameters<typeof requestDocument>[0]["kind"],
        purpose: s(a.purpose),
        context: s(a.context),
        filename: s(a.filename) || "document",
      });
      return out.ok
        ? { ok: true, line: `Wrote "${s(a.purpose)}" → ${out.relPath}.` }
        : { ok: false, line: `Document FAILED — ${out.error ?? "unknown error"}. Nothing was saved.` };
    },
  },
  {
    name: "coordinate_event",
    description:
      "Set up an event end to end — book it on the calendar and invite the attendees. Because it invites other people, this always needs the owner's confirmation.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string" },
        start_iso: { type: "string", description: "Full ISO 8601 with offset." },
        end_iso: { type: "string", description: "Full ISO 8601 with offset." },
        location: { type: "string" },
        attendees: { type: "array", items: { type: "string" }, description: "Email addresses." },
        prep_note: { type: "string", description: "Sent to attendees as the invite body — this is the agenda, so say what will actually be discussed." },
      },
      required: ["title", "start_iso", "end_iso", "prep_note"],
    },
    category: "event.coordinate",
    // Invites real people and cannot be un-sent.
    reversible: false,
    speed: "slow",
    describe: (a) => `Coordinate "${s(a.title)}" on ${s(a.start_iso)}`,
    run: async (a, ctx) => {
      const { coordinate } = await import("./events");
      const attendees = Array.isArray(a.attendees) ? a.attendees.filter((x): x is string => typeof x === "string") : [];
      const out = await coordinate({
        requestor: ctx.principal,
        onCalendar: "work",
        title: s(a.title),
        startISO: s(a.start_iso),
        endISO: s(a.end_iso),
        location: s(a.location) || undefined,
        attendees,
        prepNote: s(a.prep_note) || undefined,
      });
      return out.ok
        ? { ok: true, line: `Booked "${s(a.title)}"${attendees.length ? ` and invited ${attendees.length} attendee(s)` : ""}.` }
        : { ok: false, line: `Event coordination FAILED — ${out.error ?? "unknown error"}. Nothing was booked.` };
    },
  },
  {
    name: "list_calendar",
    description: "List the owner's upcoming calendar events. Use before moving or cancelling anything, to find the event and its id.",
    input_schema: {
      type: "object",
      properties: { days: { type: "number", description: "How many days ahead. Default 7." } },
    },
    category: "calendar.internal",
    reversible: true,
    speed: "fast",
    describe: () => "Read the calendar",
    run: async (a) => {
      const { combinedUpcoming } = await import("./ms-calendar");
      const events = await combinedUpcoming(n(a.days, 7));
      if (!events.length) return { ok: true, line: "Calendar: nothing scheduled in that window." };
      const lines = events.slice(0, 25).map((e) =>
        `${e.id} · ${e.start} · ${e.summary}${e.attendees?.length ? ` · ${e.attendees.length} attendee(s)` : ""}`);
      return { ok: true, line: `Calendar (${events.length}):\n${lines.join("\n")}` };
    },
  },
  {
    name: "move_event",
    description:
      "Change the time or title of an existing calendar event. Requires the event id — call list_calendar first if you do not have it. If the event has attendees this becomes an approval rather than happening immediately.",
    input_schema: {
      type: "object",
      properties: {
        event_id: { type: "string" },
        start_iso: { type: "string", description: "New start, full ISO 8601 with offset." },
        end_iso: { type: "string", description: "New end, full ISO 8601 with offset." },
        summary: { type: "string", description: "New title, if renaming." },
        has_attendees: { type: "boolean", description: "True if other people are on this event. Be honest — this decides whether it needs the owner's confirmation." },
      },
      required: ["event_id"],
    },
    category: "calendar.internal",
    // Moving a meeting emails every attendee. That is outbound and cannot be taken back.
    reversible: false,
    speed: "fast",
    describe: (a) => `Move calendar event ${s(a.event_id)} to ${s(a.start_iso) || "(new time)"}`,
    run: async (a, ctx) => {
      const { moveEvent } = await import("./ms-calendar");
      const r = await moveEvent(s(a.event_id), {
        requestor: ctx.principal,
        onCalendar: "work",
        startISO: s(a.start_iso) || undefined,
        endISO: s(a.end_iso) || undefined,
        summary: s(a.summary) || undefined,
      });
      return r.ok
        ? { ok: true, line: `Calendar: moved ${s(a.event_id)}. Attendees were notified by Google.` }
        : { ok: false, line: `Calendar: move FAILED — ${r.error ?? "unknown error"}` };
    },
  },
  {
    name: "cancel_event",
    description: "Cancel/delete a calendar event by id. Always needs the owner's confirmation.",
    input_schema: {
      type: "object",
      properties: { event_id: { type: "string" } },
      required: ["event_id"],
    },
    category: "calendar.internal",
    reversible: false,
    speed: "fast",
    describe: (a) => `Cancel calendar event ${s(a.event_id)}`,
    run: async (a, ctx) => {
      const { cancelEvent } = await import("./ms-calendar");
      const r = await cancelEvent(s(a.event_id), { requestor: ctx.principal, onCalendar: "work" });
      return r.ok
        ? { ok: true, line: `Calendar: cancelled ${s(a.event_id)}.` }
        : { ok: false, line: `Calendar: cancel FAILED — ${r.error ?? "unknown error"}` };
    },
  },
  {
    name: "book_event",
    description:
      "Create a new calendar event. If anyone outside the business is invited this becomes an approval instead of happening immediately.",
    input_schema: {
      type: "object",
      properties: {
        summary: { type: "string" },
        start_iso: { type: "string", description: "Full ISO 8601 with offset." },
        end_iso: { type: "string", description: "Full ISO 8601 with offset." },
        attendees: { type: "array", items: { type: "string" }, description: "Email addresses to invite." },
        description: { type: "string", description: "The agenda — what this event is actually about." },
        external: { type: "boolean", description: "True if anyone invited is outside the business." },
      },
      required: ["summary", "start_iso", "end_iso", "description"],
    },
    category: "calendar.internal",
    reversible: false,
    speed: "fast",
    describe: (a) => `Book "${s(a.summary)}" at ${s(a.start_iso)}`,
    run: async (a, ctx) => {
      const { bookEvent } = await import("./ms-calendar");
      const attendees = Array.isArray(a.attendees) ? a.attendees.map(String) : [];
      const r = await bookEvent({
        requestor: ctx.principal,
        onCalendar: "work",
        summary: s(a.summary),
        startISO: s(a.start_iso),
        endISO: s(a.end_iso),
        attendees,
        description: s(a.description) || undefined,
        external: a.external === true || attendees.length > 0,
      });
      return r.ok
        ? { ok: true, line: `Calendar: booked "${s(a.summary)}"${r.link ? ` — ${r.link}` : ""}.` }
        : { ok: false, line: `Calendar: booking FAILED — ${r.error ?? "unknown error"}` };
    },
  },
  {
    name: "connect_call",
    description:
      `Call someone for ${OWNER_FIRST} and connect them — 'connect me to Jordan', 'get me Mike from Globex on the phone', 'call 555-010-0100 for me'. Rings ${OWNER_FIRST}'s personal cell first; when they answer, dials the other person with the work caller ID. Takes a name from the contacts/CRM or a phone number.`,
    input_schema: {
      type: "object",
      properties: {
        who: { type: "string", description: "A name as they said it, or a phone number." },
      },
      required: ["who"],
    },
    category: "call.outbound",
    reversible: false,
    speed: "fast",
    describe: (a) => `Connect ${OWNER_FIRST} to ${s(a.who)}`,
    run: async (a) => {
      const { connectMeTo } = await import("./clickToCall");
      return connectMeTo(s(a.who));
    },
  },
  {
    name: "put_through_list",
    description:
      `${OWNER_FIRST}'s always-put-through list for their work phone: people Clara connects straight to ${OWNER_FIRST}'s personal cell with no questions (key clients, close partners). 'always put Dana through, 555-010-0100', 'take Mike off the put-through list', 'who do you put straight through?'. A name without a number is looked up in their contacts/CRM.`,
    input_schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["add", "remove", "list"] },
        name: { type: "string", description: "Who, as the owner said it." },
        phone: { type: "string", description: "Their number, if the owner gave one." },
      },
      required: ["action"],
    },
    category: "call.inbound",
    reversible: true,
    speed: "fast",
    describe: (a) => `${s(a.action) || "list"} put-through${s(a.name) ? `: ${s(a.name)}` : ""}`,
    run: async (a) => {
      const pt = await import("./putThrough");
      const action = s(a.action) || "list";
      if (action === "list") {
        const list = await pt.putThroughList();
        return { ok: true, line: list.length ? `Put straight through: ${list.map((e) => `${e.name} (${e.phone})`).join(", ")}.` : "Nobody is on the put-through list yet." };
      }
      if (action === "remove") {
        const { removed, seeded } = await pt.removePutThrough(s(a.phone) || s(a.name));
        if (seeded.length) return { ok: false, line: `Put-through: ${seeded.map((e) => e.name).join(", ")} is set in CLARA_PUT_THROUGH in my settings, so they have to come off there — nothing changed.` };
        return removed.length
          ? { ok: true, line: `Put-through: removed ${removed.map((e) => e.name).join(", ")}.` }
          : { ok: false, line: `Put-through: nobody matching "${s(a.phone) || s(a.name)}" is on the list.` };
      }
      let phone = s(a.phone);
      let name = s(a.name);
      if (!phone && name) {
        const { resolveCallee } = await import("./clickToCall");
        const found = await resolveCallee(name);
        if (found) { phone = found.number; name = found.label; }
      }
      const entry = phone ? await pt.addPutThrough(name, phone) : null;
      return entry
        ? { ok: true, line: `Put-through: ${entry.name} (${entry.phone}) will go straight to your cell.` }
        : { ok: false, line: `Put-through: I need a number for "${name}" — I couldn't find a single one in your contacts.` };
    },
  },
  // ── Tasks, follow-ups, and the "what needs me" question ────────────────────────────────────
  // tasks.ts, followups.ts and inbox.ts are all fully built and had zero conversational trigger.
  {
    name: "add_task",
    description:
      "Add something to the owner's task list. Use for 'remind me to…', 'add a task', 'I need to…', 'don't let me forget…'. Syncs to Google Tasks automatically.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string" },
        detail: { type: "string" },
        due: { type: "string", description: "ISO 8601 date or datetime, if a deadline was mentioned." },
      },
      required: ["title"],
    },
    category: "research.run",
    reversible: true,
    speed: "fast",
    describe: (a) => `Add task: ${s(a.title).slice(0, 60)}`,
    run: async (a) => {
      const tasks = await import("./tasks");
      const t = await tasks.add({ title: s(a.title), detail: s(a.detail) || undefined, dueAt: s(a.due) || undefined });
      return { ok: true, line: `Task added: "${t.title}"${t.dueAt ? ` (due ${t.dueAt.slice(0, 10)})` : ""}.` };
    },
  },
  {
    name: "list_tasks",
    description: "The owner's open tasks. Use for 'what's on my list', 'what do I need to do', 'my tasks'.",
    input_schema: { type: "object", properties: {} },
    category: "research.run",
    reversible: true,
    speed: "fast",
    describe: () => "List open tasks",
    run: async () => {
      const tasks = await import("./tasks");
      const open = await tasks.listOpen();
      if (!open.length) return { ok: true, line: "Tasks: nothing open." };
      return {
        ok: true,
        line: `Open tasks (${open.length}):\n` + open.slice(0, 15).map((t) =>
          `  ${t.title}${t.dueAt ? ` — due ${t.dueAt.slice(0, 10)}` : ""}`).join("\n"),
      };
    },
  },
  {
    name: "complete_task",
    description: "Mark a task done. Match on the task's wording — call list_tasks first if unsure which one.",
    input_schema: {
      type: "object",
      properties: { title: { type: "string", description: "The task's title, or enough of it to identify one." } },
      required: ["title"],
    },
    category: "research.run",
    reversible: true,
    speed: "fast",
    describe: (a) => `Complete task: ${s(a.title).slice(0, 60)}`,
    run: async (a) => {
      const tasks = await import("./tasks");
      const open = await tasks.listOpen();
      const q = s(a.title).toLowerCase();
      const hits = open.filter((t) => t.title.toLowerCase().includes(q));
      if (!hits.length) return { ok: false, line: `Tasks: nothing open matching "${s(a.title)}" — nothing changed.` };
      // Ambiguity is asked about, never guessed. Closing the wrong task is quiet and annoying to undo.
      if (hits.length > 1) {
        return { ok: false, line: `Tasks: "${s(a.title)}" matches ${hits.length} — ${hits.map((t) => `"${t.title}"`).join(", ")}. Which one?` };
      }
      await tasks.update(hits[0].id, { status: "done" });
      return { ok: true, line: `Task done: "${hits[0].title}".` };
    },
  },
  {
    name: "track_followup",
    description:
      "Start tracking something the owner is waiting on from someone else. She'll nudge on day 2, 5 and 10. Use for 'I'm waiting on X', 'chase Y about Z', 'follow up with…'.",
    input_schema: {
      type: "object",
      properties: {
        what: { type: "string", description: "What is being waited on, e.g. 'the quote for the roof'." },
        who: { type: "string", description: "Person or company." },
        email: { type: "string" },
        phone: { type: "string" },
      },
      required: ["what", "who"],
    },
    category: "research.run",
    reversible: true,
    speed: "fast",
    describe: (a) => `Track: waiting on ${s(a.who)} for ${s(a.what).slice(0, 50)}`,
    run: async (a) => {
      const followups = await import("./followups");
      await followups.open({
        what: s(a.what),
        contact: { name: s(a.who), email: s(a.email) || undefined, phone: s(a.phone) || undefined },
        channel: s(a.email) ? "email" : "sms",
      });
      return { ok: true, line: `Tracking: waiting on ${s(a.who)} for ${s(a.what)}. I'll chase on day 2, 5 and 10.` };
    },
  },
  {
    name: "list_followups",
    description: "Everything the owner is currently waiting on from other people, and how long it's been.",
    input_schema: { type: "object", properties: {} },
    category: "research.run",
    reversible: true,
    speed: "fast",
    describe: () => "List open follow-ups",
    run: async () => {
      const followups = await import("./followups");
      const open = await followups.listOpen();
      if (!open.length) return { ok: true, line: "Follow-ups: not waiting on anyone." };
      const days = (iso: string) => Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);
      return {
        ok: true,
        line: `Waiting on (${open.length}):\n` + open.slice(0, 12).map((f) =>
          `  ${f.contact.name} — ${f.what} (${days(f.createdAt)}d, ${f.nudgeCount} nudge${f.nudgeCount === 1 ? "" : "s"})`).join("\n"),
      };
    },
  },
  {
    name: "whats_waiting_on_me",
    description:
      "One honest answer to 'what needs me right now' — across email, texts, calls, approvals and notifications, split into signal and noise. Use for 'what do I need to deal with', 'anything important', 'catch me up'.",
    input_schema: { type: "object", properties: {} },
    category: "research.run",
    reversible: true,
    speed: "fast",
    describe: () => "Read the signal/noise inbox",
    run: async (_a, ctx) => {
      const { listInbox } = await import("./inbox");
      const { listPendingDecisions, renderAsk, markAsked } = await import("./decisions");
      const [r, pend] = await Promise.all([listInbox(), listPendingDecisions().catch(() => ({ decisions: [], stale: {} }))]);
      const signal = r.items.filter((i) => i.bucket === "signal" && i.source !== "approval");
      // Questions for the owner, in words — the first one becomes the open question on this channel so a
      // bare "yes" in their next message answers it (decisions.ts).
      const qs = pend.decisions.slice(0, 5);
      const askChannel = ctx.source === "chat" ? "chat" : ctx.source === "voice" ? "voice" : ctx.source === "email" ? "email" : "sms";
      if (qs[0]) await markAsked(qs[0].id, askChannel, undefined, { question: qs[0].question }).catch(() => {});
      const qBlock = qs.length
        ? `${qs.length === 1 ? "One question for you" : `${qs.length} questions for you`}:\n` + qs.map((d, i) => `  ${i === 0 ? renderAsk(d, askChannel) : d.question}`).join("\n")
        : "";
      if (!signal.length && !qs.length) return { ok: true, line: `Nothing needs you — ${r.counts.noise} low-priority item(s) sitting in the noise pile.` };
      const sig = signal.length
        ? `${signal.length} thing(s) need you (${r.counts.noise} noise):\n` + signal.slice(0, 12).map((i) =>
          `  [${i.source}] ${i.title.slice(0, 70)}${i.reason ? ` — ${i.reason}` : ""}`).join("\n")
        : "";
      return { ok: true, line: [qBlock, sig].filter(Boolean).join("\n\n") };
    },
  },
  {
    name: "decide",
    description:
      `Record ${OWNER_FIRST}'s answer to something Clara (or FRIDAY through Clara) asked them: approve, hold (reject), or defer to a later time. Use when they answer a question you asked, or name the item ("go ahead with the Acme Co report", "hold the Initech budget change", "send it Monday"). Never invent a decision they did not state; if it's unclear which item they mean, leave reference empty and Clara will ask which one.`,
    input_schema: {
      type: "object",
      properties: {
        decision: { type: "string", enum: ["approve", "reject", "defer"] },
        reference: { type: "string", description: "The owner's words naming the item, verbatim (client, project, or what it does)." },
        defer_until: { type: "string", description: "For defer: their words for when (\"Monday\", \"tomorrow\", \"next week\")." },
      },
      required: ["decision"],
    },
    category: "research.run",
    // Irreversible on purpose: a decision releases real work in another app. delegationForce vouches
    // for the owner's own answer (their answer IS the approval), so it runs without a second prompt.
    reversible: false,
    speed: "fast",
    describe: (a) => `Record decision: ${s(a.decision)}${a.reference ? ` on "${s(a.reference)}"` : ""}`,
    run: async (a, ctx) => {
      const { tryHandleDecisionReply } = await import("./decisionReply");
      const verb = s(a.decision) === "reject" ? "no, hold" : s(a.decision) === "defer" ? `later${a.defer_until ? ` — ${s(a.defer_until)}` : " — tomorrow"}` : "yes, go ahead";
      const ref = s(a.reference).trim();
      const text = ref ? `${verb} with ${ref}` : verb;
      const channel = ctx.source === "chat" ? "chat" : ctx.source === "voice" ? "voice" : ctx.source === "email" ? "email" : "sms";
      const line = await tryHandleDecisionReply(text, { channel, from: ctx.from, requestRef: ctx.requestRef });
      if (!line) return { ok: false, line: "I don't have a question open that matches that — nothing was decided. Ask me what's waiting and I'll list them." };
      return { ok: !/^(Approved|Held|Noted), but /.test(line), line };
    },
  },
  {
    name: "brief_me",
    description:
      "Compose the owner's brief on demand. Use for 'what's my day look like', 'read me my day', 'catch me up on the week', 'evening summary'. The natural phone request.",
    input_schema: {
      type: "object",
      properties: { which: { type: "string", enum: ["morning", "evening", "weekly"] } },
    },
    category: "research.run",
    reversible: true,
    // Composes from already-gathered state; no model call in the compose path itself.
    speed: "fast",
    describe: (a) => `Compose the ${s(a.which) || "morning"} brief`,
    run: async (a) => {
      const briefs = await import("./briefs");
      const which = ["evening", "weekly"].includes(s(a.which)) ? s(a.which) : "morning";
      const b = which === "evening"
        ? await briefs.composeEveningBrief()
        : which === "weekly"
          ? await briefs.composeWeeklyReview()
          : await briefs.composeMorningBrief();
      // Cloud-gated before it leaves: the brief can carry sensitive vault content and the caller
      // may be relaying it through a cloud model or reading it aloud.
      const safe = briefs.gateBriefForCloud(b.markdown).text;
      return { ok: true, line: safe.slice(0, 2500) };
    },
  },
  {
    name: "project_status",
    description:
      `How a project is going, answered from FRIDAY's live records with provenance — stage, health, what landed recently, what's blocked or next, what's waiting on ${OWNER_FIRST}. Use for "how's Acme Co going", "where are we on the dashboard", "what happened with X this week". Never delegate a status question.`,
    input_schema: {
      type: "object",
      properties: { project: { type: "string", description: "The project as the owner names it (fuzzy is fine)." } },
      required: ["project"],
    },
    category: "research.run",
    reversible: true,
    speed: "fast",
    describe: (a) => `Status of ${s(a.project)}`,
    run: async (a, ctx) => {
      const { answerStatus } = await import("./teamStatus");
      const ch = ctx.source === "sms" || ctx.source === "voice" || ctx.source === "email" || ctx.source === "chat" ? ctx.source : "web";
      const r = await answerStatus(s(a.project), ch, { kind: "project" });
      return { ok: true, line: r.text };
    },
  },
  {
    name: "client_status",
    description:
      `How things stand with a client across the team — FRIDAY's projects for them — with provenance. Use for "how's Globex doing", "anything open with Initech". Never delegate a status question.`,
    input_schema: {
      type: "object",
      properties: { client: { type: "string", description: "The client or company as the owner names it." } },
      required: ["client"],
    },
    category: "research.run",
    reversible: true,
    speed: "fast",
    describe: (a) => `Client status for ${s(a.client)}`,
    run: async (a, ctx) => {
      const { answerStatus } = await import("./teamStatus");
      const ch = ctx.source === "sms" || ctx.source === "voice" || ctx.source === "email" || ctx.source === "chat" ? ctx.source : "web";
      const r = await answerStatus(s(a.client), ch, { kind: "client" });
      return { ok: true, line: r.text };
    },
  },
  {
    name: "delegation_status",
    description:
      `What Clara has handed to FRIDAY and where each hand-off stands — in progress, finished, stuck — from her own receipts, last two days. Use for "did FRIDAY finish that", "what's FRIDAY working on for me", "is that lead form done yet".`,
    input_schema: {
      type: "object",
      properties: { query: { type: "string", description: "Optional: a word from the task, the client, or the agent name to narrow it." } },
    },
    category: "research.run",
    reversible: true,
    speed: "fast",
    describe: (a) => `Hand-off status${a.query ? ` for ${s(a.query)}` : ""}`,
    run: async (a, ctx) => {
      const { readAll } = await import("./delegations");
      const { renderDelegations } = await import("./teamStatus");
      const ch = ctx.source === "sms" || ctx.source === "voice" || ctx.source === "email" || ctx.source === "chat" ? ctx.source : "web";
      return { ok: true, line: renderDelegations(await readAll(), s(a.query).trim() || undefined, ch) };
    },
  },
  {
    name: "agent_status",
    description: "Live status of Clara and FRIDAY: what's up, what's waiting on the owner, spend, autonomy dials. Use for any 'how are things', 'what's broken', 'status' question.",
    input_schema: { type: "object", properties: {} },
    category: "research.run",
    reversible: true,
    speed: "fast",
    describe: () => "Read fleet status",
    run: async () => {
      const { gatherSitrep, formatSitrepSms } = await import("./sitrep");
      return { ok: true, line: formatSitrepSms(await gatherSitrep()) };
    },
  },
  {
    name: "restart_service",
    description: "Restart one of the agent services when it is stuck or unreachable.",
    input_schema: {
      type: "object",
      properties: { target: { type: "string", enum: ["friday", "mcp"] } },
      required: ["target"],
    },
    category: "research.run",
    reversible: true, // a service comes back; nothing is destroyed
    speed: "slow",
    describe: (a) => `Restart ${s(a.target)}`,
    run: async (a) => {
      const { restartService } = await import("./repair");
      const t = s(a.target) as "friday" | "mcp";
      const r = await restartService(t);
      return { ok: r.ok, line: r.message };
    },
  },
  {
    name: "delegate_to_agent",
    description:
      `Dispatch work to FRIDAY (software, deploys, repos, infrastructure, client deliverables, SEO). Use it whenever ${OWNER_FIRST} tells you to have, ask or get FRIDAY to do something, or names work squarely in her domain. When ${OWNER_FIRST} asks, the hand-off fires immediately and reports the task id the department queued so it's provable; asks from anyone else queue for ${OWNER_FIRST}'s one-tap approval first. We don't offer paid ads or marketing — never dispatch ads/campaign/creative work; say plainly it's not a service we offer.`,
    input_schema: {
      type: "object",
      properties: {
        agent: { type: "string", enum: ["friday"] },
        task: { type: "string", description: "The request, in the owner's own words plus any context the head needs." },
        client: { type: "string", description: "Client or counterparty name, when this dispatch is client work — enables the overdue-invoice check." },
        override_overdue_gate: { type: "boolean", description: `Set true only if ${OWNER_FIRST} explicitly said to proceed despite an overdue invoice after being told about it.` },
      },
      required: ["agent", "task"],
    },
    category: "research.run",
    // reversible:false rides the intent.tool approval rail for anyone who is not the owner. When the
    // OWNER personally asks (SMS/voice/chat/email), adapter.gate vouches with force:true — their ask IS
    // the approval (owner decision 2026-09-14; before, every delegation queued a quiet approval that
    // could sit unseen for hours). Money still gates inside the tool (overdue-invoice check).
    reversible: false,
    speed: "slow",
    describe: (a) => `Assign to ${s(a.agent).toUpperCase()}: ${s(a.task).slice(0, 80)}`,
    run: async (a, ctx) => {
      // Enforced here, not just in the description: this also runs when a queued call is approved.
      const { isPaidAdsOrMarketing, RETIRED_SERVICE_LINE } = await import("./retiredServices");
      if (isPaidAdsOrMarketing(s(a.task))) {
        return { ok: false, line: `delegate_to_agent: NOT sent. ${RETIRED_SERVICE_LINE} If part of it is dev or SEO work, send FRIDAY just that part.` };
      }
      const clientName = s(a.client).trim() || undefined;
      if (clientName && a.override_overdue_gate !== true) {
        const blocked = await overdueInvoiceBlock(clientName).catch(() => null);
        if (blocked) return { ok: false, line: blocked };
      }
      const { dispatchTo } = await import("./routing");
      const agent = "friday" as const;
      const name = agent.toUpperCase();
      // Receipts (2026-09-24): the owner's own hand-offs are recorded like client ones, so "did
      // FRIDAY finish that?" is answerable and the result comes back on the channel they used.
      const live = ctx.source === "sms" || ctx.source === "voice" || ctx.source === "chat" || ctx.source === "email";
      const record = ctx.principal === "owner" && live
        ? {
            summary: s(a.task).slice(0, 300),
            source: { kind: ctx.source as "sms" | "voice" | "chat" | "email", ref: ctx.requestRef ?? "" },
            ...(clientName ? { client: { name: clientName } } : {}),
            replyTo: { channel: ctx.source as "sms" | "voice" | "chat" | "email", ...(ctx.from ? { from: ctx.from } : {}) },
            askedBy: "owner" as const,
          }
        : undefined;
      const r = await dispatchTo(agent, s(a.task), record ? { record } : {});
      if (!r.ok) {
        // Distinguish "definitely didn't land" from "we stopped listening". Claiming the former on a
        // timeout is how the same work gets assigned twice.
        if (r.indeterminate) {
          return {
            ok: false,
            line: `${name} didn't answer in time, so I can't tell you whether it landed — it may well be queued and running on her side. Check her board before sending it again; re-assigning could duplicate the work.`,
          };
        }
        if (r.authFailed) {
          return { ok: false, line: `${name} refused my credentials — that's a config problem on our side (INTERAGENT_SHARED_SECRET), not a busy agent. Nothing was handed over.` };
        }
        return { ok: false, line: `${name} couldn't be reached — ${r.error ?? "unknown error"}. Nothing was handed over.` };
      }

      const reply = String(r.reply ?? "(no reply)").slice(0, 900);
      const ids = r.taskIds ?? [];

      // A reply is not a receipt — but no receipt is not proof of no work either, and that second
      // half was learned by getting it wrong: FRIDAY's chat returns tasks:[] whenever her own router
      // handled the request, so a task she genuinely created (2b5c040d, observed) came back with no
      // id and this said "queued nothing" while her reply named the task. Report the absence of a
      // confirmation, never the presence of a nothing. Say what is known and let the reply speak.
      if (!ids.length) {
        return {
          ok: true,
          line: `${name} answered but didn't hand back a task id, so I can't confirm anything is queued`
            + `${r.runId ? ` (run ${r.runId.slice(0, 8)})` : ""}. Her reply:\n${reply}`,
        };
      }
      const shown = ids.slice(0, 5).map((id) => id.slice(0, 8)).join(", ");
      return {
        ok: true,
        line: `${name} took it — ${ids.length} task(s) queued: ${shown}${ids.length > 5 ? "…" : ""}.\n${reply}`,
      };
    },
  },
  // ── CRM (orion over MCP) ──────────────────────────────────────────────────────────────────
  //
  // CLARA_OS_TOOLS grants 217 tools and she has been calling three. Everything below wraps
  // osClient.callTool and passes through tiers.can() — which makes these SAFER than the existing
  // /chat CLI path, where a free-reasoning `claude -p` can already reach all 217 with no tier check
  // (osClient.ts:58-59 says so outright).
  //
  // create_deal and move_deal_stage were deliberately ABSENT here until 2026-08-14: both need a
  // pipeline_id and stage_id, and CLARA's allowlist had no way to resolve them from a name — "a
  // tool that needs an id it cannot obtain is a tool that fails on first use". The Phase 5 tranche
  // (master plan, Phase 5 CLARA bullet) closed that the right way round: pipelines_list/stages_list
  // below ARE the id-resolution path, and the two writes validate every id against those reads
  // before touching the CRM. Both writes are reversible:false — same rail as delegate_to_agent —
  // so every deal create/move queues for the owner's one-tap approval; the auto-posture tier row never
  // fires them unilaterally. Reads and writes live in deals.ts's dedicated client (CLARA_OS_TOOLS
  // + a three-tool extension; the CLI path is deliberately NOT widened — see deals.ts's header for
  // the pending fold-back into agent-core's allowlist).
  {
    name: "pipelines_list",
    description:
      `List the CRM's sales pipelines with their stages and ids. Use before creating or moving a deal — create_deal and move_deal_stage need the ids this returns — or when ${OWNER_FIRST} asks 'what pipelines/stages do we have'.`,
    input_schema: { type: "object", properties: {} },
    category: "research.run",
    reversible: true,
    speed: "fast",
    describe: () => "List sales pipelines and stages",
    run: async () => {
      const { osEnabled } = await import("./osClient");
      if (!osEnabled()) return { ok: false, line: "CRM: not signed in, so I couldn't read the pipelines." };
      const { listPipelines } = await import("./deals");
      const pipelines = await listPipelines();
      if (!pipelines.length) return { ok: true, line: "CRM: no pipelines configured." };
      const lines = pipelines.map((p) =>
        `${p.name} [${p.id}]\n${p.stages.map((st) => `  · ${st.name} [${st.id}]${st.probability != null ? ` (${st.probability}%)` : ""}`).join("\n") || "  (no stages)"}`);
      return { ok: true, line: `Pipelines (${pipelines.length}):\n${lines.join("\n")}` };
    },
  },
  {
    name: "stages_list",
    description:
      "List the stages of ONE pipeline, in board order, with their ids. Accepts the pipeline's name or id. Use when you already know the pipeline and just need a stage id for create_deal or move_deal_stage.",
    input_schema: {
      type: "object",
      properties: { pipeline: { type: "string", description: "Pipeline name or id." } },
      required: ["pipeline"],
    },
    category: "research.run",
    reversible: true,
    speed: "fast",
    describe: (a) => `List stages of pipeline ${s(a.pipeline)}`,
    run: async (a) => {
      const { osEnabled } = await import("./osClient");
      if (!osEnabled()) return { ok: false, line: "CRM: not signed in." };
      const { listPipelines } = await import("./deals");
      const pipelines = await listPipelines();
      const ref = s(a.pipeline).trim().toLowerCase();
      const hit = pipelines.find((p) => p.id === s(a.pipeline).trim() || p.name.toLowerCase() === ref)
        ?? pipelines.find((p) => p.name.toLowerCase().includes(ref));
      if (!hit) return { ok: false, line: `CRM: no pipeline matching "${s(a.pipeline)}". Pipelines: ${pipelines.map((p) => p.name).join(", ") || "(none)"}.` };
      const lines = hit.stages.map((st) => `  · ${st.name} [${st.id}]${st.probability != null ? ` (${st.probability}%)` : ""}`);
      return { ok: true, line: `Stages of ${hit.name} [${hit.id}]:\n${lines.join("\n") || "  (no stages)"}` };
    },
  },
  {
    name: "create_deal",
    description:
      `Create a new deal (opportunity) in the CRM sales pipeline. Needs a pipeline and stage — call pipelines_list first and pass ids or exact names from it — plus the contact it's with (the CRM requires one). When ${OWNER_FIRST} asks directly it runs at once; from anyone else it queues for ${OWNER_FIRST}'s OK first.`,
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Deal name, e.g. 'Acme — website rebuild'." },
        pipeline: { type: "string", description: "Pipeline id or exact name, from pipelines_list." },
        stage: { type: "string", description: "Stage id or exact name within that pipeline." },
        contact: { type: "string", description: "Who the deal is with — name, email or company, resolved against the CRM. Required." },
        value_amount: { type: "number", description: "Deal value in dollars. Omit if unknown." },
        close_date: { type: "string", description: "Expected close date, YYYY-MM-DD." },
      },
      required: ["name", "pipeline", "stage", "contact"],
    },
    category: "research.run",
    // Same shape as delegate_to_agent: the tier row is auto, and reversible:false overrides it onto
    // the intent.tool approval rail — the queued row's release performs the create. REVERSE GEAR
    // (§7.4): honestly, there isn't one — opportunities_delete is deliberately not on CLARA's
    // surface (hard deletes never are), so undoing a created deal means opportunity_close as lost
    // or the owner deleting it in the OS UI. That is exactly why this is approval-required, not auto.
    reversible: false,
    speed: "fast",
    describe: (a) => `Create deal "${s(a.name)}" (${s(a.pipeline)} / ${s(a.stage)}, with ${s(a.contact)})`,
    run: async (a) => {
      const { osClient, osEnabled } = await import("./osClient");
      if (!osEnabled()) return { ok: false, line: "CRM: not signed in — no deal created." };
      const name = s(a.name).trim();
      if (!name) return { ok: false, line: "create_deal: the deal needs a name. Nothing created." };

      // Id validation against the reads — the whole reason this tool can exist now.
      const { resolvePipelineStage, dealsCallTool } = await import("./deals");
      const resolved = await resolvePipelineStage(s(a.pipeline), s(a.stage));
      if (!resolved.ok) return { ok: false, line: `create_deal: ${resolved.error}. Nothing created.` };

      // contact_id is NOT NULL in the CRM schema — resolve it the way add_contact_note does,
      // refusing on ambiguity rather than guessing whose deal this is.
      const people = (unwrapTool(await osClient.callTool("contacts_list", { search: s(a.contact), limit: 5 })) ?? []) as
        Array<{ id?: string; first_name?: string; last_name?: string; company?: string }>;
      const contacts = Array.isArray(people) ? people : [];
      if (!contacts.length) return { ok: false, line: `create_deal: no CRM contact matching "${s(a.contact)}" — create the contact first. Nothing created.` };
      if (contacts.length > 1) {
        return {
          ok: false,
          line: `create_deal: "${s(a.contact)}" matches ${contacts.length} contacts (${contacts.map((c) => c.company || [c.first_name, c.last_name].filter(Boolean).join(" ")).join(", ")}) — tell me which one. Nothing created.`,
        };
      }

      const amount = n(a.value_amount, 0);
      const close = /^\d{4}-\d{2}-\d{2}$/.test(s(a.close_date)) ? s(a.close_date) : undefined;
      const rows = (await dealsCallTool("opportunities_create", {
        name,
        pipeline_id: resolved.pipeline.id,
        stage_id: resolved.stage.id,
        contact_id: String(contacts[0].id),
        ...(amount > 0 ? { value_amount: amount } : {}),
        ...(close ? { close_date: close } : {}),
        // org comes from the pipeline row — a deal cannot land in a different org than its board.
        ...(resolved.pipeline.org_id ? { org_id: resolved.pipeline.org_id } : {}),
      }).then(unwrapTool)) as Array<{ id?: string }> | { id?: string };
      const created = Array.isArray(rows) ? rows[0] : rows;
      const who = contacts[0].company || [contacts[0].first_name, contacts[0].last_name].filter(Boolean).join(" ");
      return {
        ok: true,
        line: `CRM: created "${name}" with ${who} in ${resolved.pipeline.name} / ${resolved.stage.name}${amount > 0 ? `, $${amount.toLocaleString()}` : ""}${created?.id ? ` [${created.id}]` : ""}. No undo tool exists for a create — closing it as lost is the reverse path if this was a mistake.`,
      };
    },
  },
  {
    name: "move_deal_stage",
    description:
      `Move an existing deal to another stage of its pipeline. Needs the deal's id (from pipeline_status or deal_lookup) and the target stage (id or name — stages_list shows them). When ${OWNER_FIRST} asks directly it runs at once; from anyone else it queues for ${OWNER_FIRST}'s OK before anything moves.`,
    input_schema: {
      type: "object",
      properties: {
        deal_id: { type: "string", description: "The opportunity id." },
        stage: { type: "string", description: "Target stage id or exact name, within the deal's own pipeline." },
      },
      required: ["deal_id", "stage"],
    },
    category: "research.run",
    // reversible:false → intent.tool approval rail, same as create_deal. REVERSE GEAR (§7.4): this
    // tool is its own reverse — move the deal back to the stage it came from; the result line names
    // that stage explicitly and opportunity_stage_history_list keeps the full trail.
    reversible: false,
    speed: "fast",
    describe: (a) => `Move deal ${s(a.deal_id).slice(0, 8)} to stage ${s(a.stage)}`,
    run: async (a) => {
      const { osClient, osEnabled } = await import("./osClient");
      if (!osEnabled()) return { ok: false, line: "CRM: not signed in — nothing moved." };
      const dealId = s(a.deal_id).trim();
      if (!dealId) return { ok: false, line: "move_deal_stage: no deal id given. Nothing moved." };

      // Fetch the deal first: verifies the id is real, and pins the target stage to the deal's OWN
      // pipeline so a stage name from the wrong board can't be silently applied.
      const deal = unwrapTool(await osClient.callTool("opportunities_get", { id: dealId })) as
        { id?: string; name?: string; pipeline_id?: string; stage?: { id?: string; name?: string } } | null;
      if (!deal?.id) return { ok: false, line: `move_deal_stage: no deal with id "${dealId}". Nothing moved.` };

      const { resolvePipelineStage, dealsCallTool } = await import("./deals");
      const resolved = await resolvePipelineStage(String(deal.pipeline_id ?? ""), s(a.stage));
      if (!resolved.ok) return { ok: false, line: `move_deal_stage: ${resolved.error}. Nothing moved.` };

      const fromStage = deal.stage?.name ?? "(unknown stage)";
      if (deal.stage?.id === resolved.stage.id) {
        return { ok: true, line: `CRM: "${deal.name ?? dealId}" is already in ${fromStage} — nothing to move.` };
      }
      await dealsCallTool("opportunities_update", { id: dealId, stage_id: resolved.stage.id });
      return {
        ok: true,
        line: `CRM: moved "${deal.name ?? dealId}" from ${fromStage} to ${resolved.stage.name}. Reverse gear: move it back to ${fromStage} the same way if this was wrong.`,
      };
    },
  },
  {
    name: "pipeline_status",
    description:
      "The owner's sales pipeline: how many open deals, what they're worth, and the biggest ones. Use for 'what's in my pipeline', 'how's the pipeline looking', 'what deals are open', 'what's my forecast'.",
    input_schema: {
      type: "object",
      properties: { status: { type: "string", description: "open, won or lost. Default open." } },
    },
    category: "research.run",
    reversible: true,
    speed: "fast",
    describe: () => "Read the sales pipeline",
    run: async (a) => {
      const { osClient, osEnabled } = await import("./osClient");
      if (!osEnabled()) return { ok: false, line: "CRM: not signed in, so I couldn't read the pipeline." };
      const status = ["won", "lost"].includes(s(a.status)) ? s(a.status) : "open";
      const rows = (unwrapTool(await osClient.callTool("opportunities_list", {
        status: `eq.${status}`, order: "value_amount.desc", limit: 25,
      })) ?? []) as Array<{ id?: string; name?: string; title?: string; value_amount?: unknown; contact_id?: string }>;
      const deals = Array.isArray(rows) ? rows : [];
      if (!deals.length) return { ok: true, line: `Pipeline: no ${status} deals.` };

      // PostgREST returns numeric columns as STRINGS ("25000.00"). A typeof === "number" check
      // silently treated every deal as unpriced and reported a $0 pipeline — a wrong number is
      // worse than no number, because it looks like an answer.
      const amount = (v: unknown): number => {
        const x = typeof v === "number" ? v : Number(String(v ?? ""));
        return Number.isFinite(x) ? x : 0;
      };

      // `opportunities.name` is NULL on every row in this CRM, so naming deals by it produced
      // "(unnamed e3e01575)". contact_id IS populated — the deal is identifiable by WHO it's with,
      // which is how anyone would actually refer to it.
      let byContact = new Map<string, string>();
      const contactIds = [...new Set(deals.map((d) => d.contact_id).filter((x): x is string => !!x))];
      if (contactIds.length) {
        const people = (unwrapTool(await osClient.callTool("contacts_list", { limit: 200 })) ?? []) as
          Array<{ id?: string; first_name?: string; last_name?: string; company?: string }>;
        byContact = new Map((Array.isArray(people) ? people : []).map((p) => [
          String(p.id),
          p.company || [p.first_name, p.last_name].filter(Boolean).join(" ") || String(p.id).slice(0, 8),
        ]));
      }

      const total = deals.reduce((sum, d) => sum + amount(d.value_amount), 0);
      const unpriced = deals.filter((d) => amount(d.value_amount) === 0).length;

      const named = deals.slice(0, 8).map((d) => {
        const label = d.name || d.title || byContact.get(String(d.contact_id)) || `(deal ${String(d.id ?? "").slice(0, 8)})`;
        const v = amount(d.value_amount);
        return `  ${label}${v ? ` — $${v.toLocaleString()}` : " — no value set"}`;
      });
      const caveat = unpriced ? ` ${unpriced} have no value recorded, so that total is a floor, not a forecast.` : "";
      return {
        ok: true,
        line: `Pipeline: ${deals.length} ${status} deal(s), $${total.toLocaleString()} logged.${caveat}\n${named.join("\n")}`,
      };
    },
  },
  {
    name: "deal_lookup",
    description: "Find a specific deal or opportunity by name and show its stage, value and history.",
    input_schema: {
      type: "object",
      properties: { query: { type: "string", description: "Deal or company name, or part of it." } },
      required: ["query"],
    },
    category: "research.run",
    reversible: true,
    speed: "fast",
    describe: (a) => `Look up deal: ${s(a.query)}`,
    run: async (a) => {
      const { osClient, osEnabled } = await import("./osClient");
      if (!osEnabled()) return { ok: false, line: "CRM: not signed in." };
      // opportunities_list has no search parameter, so the filter is client-side over a bounded page.
      const rows = (unwrapTool(await osClient.callTool("opportunities_list", { limit: 200 })) ?? []) as
        Array<{ id?: string; name?: string; value_amount?: number; status?: string }>;
      const q = s(a.query).toLowerCase();
      const hits = (Array.isArray(rows) ? rows : []).filter((r) => (r.name ?? "").toLowerCase().includes(q));
      if (!hits.length) return { ok: true, line: `CRM: no deal matching "${s(a.query)}".` };
      return {
        ok: true,
        line: `Deals matching "${s(a.query)}":\n` + hits.slice(0, 8).map((r) =>
          `  ${r.name} — ${r.status ?? "?"}${typeof r.value_amount === "number" ? `, $${r.value_amount.toLocaleString()}` : ""} [${r.id}]`).join("\n"),
      };
    },
  },
  {
    name: "invoice_status",
    description:
      "Invoices and what's outstanding. Use for 'what did we invoice', 'who owes me money', 'is that invoice paid', 'what's overdue'.",
    input_schema: {
      type: "object",
      properties: { status: { type: "string", description: "draft, sent, paid or overdue. Omit for all." } },
    },
    category: "research.run",
    reversible: true,
    speed: "fast",
    describe: () => "Read invoices",
    run: async (a) => {
      const { osClient, osEnabled } = await import("./osClient");
      if (!osEnabled()) return { ok: false, line: "CRM: not signed in." };
      const args: Record<string, unknown> = { order: "created_at.desc", limit: 25 };
      if (s(a.status)) args.status = `eq.${s(a.status)}`;
      const rows = (unwrapTool(await osClient.callTool("invoices_list", args)) ?? []) as
        Array<{ number?: string; total?: number; status?: string; due_date?: string }>;
      if (!Array.isArray(rows) || !rows.length) return { ok: true, line: "Invoices: none matching." };
      // Same PostgREST trap as pipeline_status: numeric columns arrive as strings.
      const num = (v: unknown): number => { const x = Number(String(v ?? "")); return Number.isFinite(x) ? x : 0; };
      const total = rows.reduce((sum, r) => sum + num(r.total), 0);
      return {
        ok: true,
        line: `Invoices (${rows.length}, $${total.toLocaleString()} total):\n` + rows.slice(0, 12).map((r) =>
          `  ${r.number ?? "(no number)"} — ${r.status ?? "?"}${num(r.total) ? ` ${num(r.total).toLocaleString()}` : ""}${r.due_date ? ` due ${r.due_date}` : ""}`).join("\n"),
      };
    },
  },
  {
    name: "find_free_slot",
    description:
      `Find open slots on ${OWNER_FIRST}'s own calendar — 'when am I free for a 30-minute call this week', 'find an hour tomorrow'. Checks real free/busy within business hours and proposes concrete times. Read-only; booking is book_event's job. (This is also the capability siblings request over the bus as calendar.find_free_slot.)`,
    input_schema: {
      type: "object",
      properties: {
        duration_min: { type: "number", description: "Slot length in minutes. Default 30." },
        days_ahead: { type: "number", description: "How many days out to search, starting now. Default 5." },
        count: { type: "number", description: "How many candidate slots to propose. Default 3." },
      },
    },
    category: "calendar.internal",
    reversible: true,
    speed: "fast",
    describe: (a) => `Find ${n(a.count, 3)} free ${n(a.duration_min, 30)}-minute slot(s)`,
    run: async (a) => {
      const { freeBusy, firstFreeSlot } = await import("./ms-calendar");
      const duration = Math.min(Math.max(n(a.duration_min, 30), 5), 480);
      const days = Math.min(Math.max(n(a.days_ahead, 5), 1), 30);
      const want = Math.min(Math.max(n(a.count, 3), 1), 8);
      const from = new Date();
      const to = new Date(from.getTime() + days * 86_400_000);
      const busy = await freeBusy(from.toISOString(), to.toISOString());
      const slots: Date[] = [];
      let cursor = new Date(from);
      let guard = 0;
      while (slots.length < want && guard++ < 20) {
        const slot = firstFreeSlot(busy, cursor, to, duration);
        if (!slot) break;
        slots.push(slot);
        // Next search starts after this slot so candidates don't overlap.
        cursor = new Date(slot.getTime() + duration * 60_000);
      }
      if (!slots.length) return { ok: true, line: `No ${duration}-minute openings in the next ${days} day(s) within business hours — the calendar is packed.` };
      const fmt = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
      return { ok: true, line: `Open ${duration}-minute slots (next ${days} days):\n${slots.map((s2) => `· ${fmt.format(s2)}`).join("\n")}` };
    },
  },
  {
    name: "check_availability",
    description: "What's already booked on the CRM's own booking calendars. Use before offering someone a slot.",
    input_schema: { type: "object", properties: {} },
    category: "calendar.internal",
    reversible: true,
    speed: "fast",
    describe: () => "Check CRM booking availability",
    run: async () => {
      const { osClient, osEnabled } = await import("./osClient");
      if (!osEnabled()) return { ok: false, line: "CRM: not signed in." };
      const cals = (unwrapTool(await osClient.callTool("calendars_list", {})) ?? []) as Array<{ id?: string; name?: string }>;
      if (!Array.isArray(cals) || !cals.length) return { ok: true, line: "CRM: no booking calendars configured." };
      const appts = (unwrapTool(await osClient.callTool("appointments_list", { limit: 25, order: "start_time.asc" })) ?? []) as
        Array<{ title?: string; start_time?: string }>;
      const booked = Array.isArray(appts) && appts.length
        ? appts.slice(0, 12).map((x) => `  ${x.start_time ?? "?"} — ${x.title ?? "(untitled)"}`).join("\n")
        : "  (nothing booked)";
      return { ok: true, line: `Booking calendars: ${cals.map((c) => c.name ?? c.id).join(", ")}\nUpcoming:\n${booked}` };
    },
  },
  {
    name: "book_appointment",
    description:
      "Create an appointment on a CRM booking calendar. Call check_availability first for the calendar id and to avoid a clash.",
    input_schema: {
      type: "object",
      properties: {
        calendar_id: { type: "string" },
        title: { type: "string" },
        start_time: { type: "string", description: "Full ISO 8601 with offset." },
        end_time: { type: "string", description: "Full ISO 8601 with offset." },
        contact_id: { type: "string" },
        description: { type: "string", description: "The agenda — what will be discussed." },
      },
      required: ["calendar_id", "title", "start_time", "end_time", "description"],
    },
    category: "calendar.external",
    // A CRM appointment is a commitment to a client, and the OS notifies them.
    reversible: false,
    speed: "fast",
    describe: (a) => `Book "${s(a.title)}" at ${s(a.start_time)}`,
    run: async (a) => {
      const { osClient } = await import("./osClient");
      const { ensureAgenda } = await import("./ms-calendar");
      await osClient.callTool("appointments_create", {
        calendar_id: s(a.calendar_id), title: s(a.title),
        start_time: s(a.start_time), end_time: s(a.end_time),
        contact_id: s(a.contact_id) || undefined,
        description: ensureAgenda(s(a.description), { title: s(a.title) }),
      });
      return { ok: true, line: `CRM: booked "${s(a.title)}" for ${s(a.start_time)}.` };
    },
  },
  {
    name: "portal_message",
    description:
      "Post a message into a client's portal support-ticket thread — client-visible by default. Use for updating a client on project status through the portal rather than email. Same auto-send rules as work email: VIPs and family still escalate.",
    input_schema: {
      type: "object",
      properties: {
        ticket_id: { type: "string", description: "The support ticket id — use project_support_tickets_list or find_appointment-style lookups first if you don't already have it." },
        body: { type: "string", description: "The message, in full — this is what the client reads." },
        internal_note: { type: "boolean", description: "True only for a staff-only note never shown to the client. Default false." },
      },
      required: ["ticket_id", "body"],
    },
    category: "email.work",
    reversible: false,
    speed: "fast",
    describe: (a) => `Portal message${a.internal_note ? " (internal note)" : ""}: ${s(a.body).slice(0, 80)}`,
    run: async (a) => {
      const ticketId = s(a.ticket_id).trim();
      const body = s(a.body).trim();
      if (!ticketId || !body) return { ok: false, line: "portal_message: need both a ticket id and a message." };
      const { osClient, osEnabled } = await import("./osClient");
      if (!osEnabled()) return { ok: false, line: "CRM: not signed in." };
      const res = await osClient.callTool("project_ticket_comment_create", {
        ticket_id: ticketId,
        body,
        is_internal: a.internal_note === true,
        author_name: "Clara",
      });
      const row = unwrapTool(res) as { id?: string } | null;
      if (!row?.id) return { ok: false, line: "portal_message: the OS didn't confirm the post — nothing sent." };
      return { ok: true, line: `Posted to the client portal (ticket ${ticketId.slice(-6)}).` };
    },
  },
  {
    name: "escalate_out_of_scope_request",
    description:
      `Use when a client asks for work that falls outside what they're contracted for. Texts the client three options — book a call, go ahead anyway, or skip it — and hands the decision to them (with a 30-minute SLA that defaults to booking a call if they don't reply). Do NOT just do out-of-scope work, and do not decide FOR the client — this tool is how you hand the choice back to them properly.`,
    input_schema: {
      type: "object",
      properties: {
        client_contact: { type: "string", description: "The client's phone number (E.164) to text the options to — the same number/thread they reached out from." },
        request_text: { type: "string", description: "What the client actually asked for, in their own words." },
        client_label: { type: "string", description: "Client or company name, for the owner's notification." },
        contract_id: { type: "string", description: "The contract this falls outside of, if known." },
      },
      required: ["client_contact", "request_text"],
    },
    category: "event.coordinate",
    reversible: true,
    speed: "fast",
    describe: (a) => `Escalate out-of-scope request: ${s(a.request_text).slice(0, 80)}`,
    run: async (a) => {
      const clientContact = s(a.client_contact).trim();
      const requestText = s(a.request_text).trim();
      if (!clientContact || !requestText) return { ok: false, line: "escalate_out_of_scope_request: need both a client contact and what they asked for." };
      const { draftScopeEscalation } = await import("./scopeEscalation");
      const row = await draftScopeEscalation({
        clientContact, requestText,
        clientLabel: s(a.client_label) || undefined,
        contractId: s(a.contract_id) || undefined,
      });
      return { ok: true, line: `Texted ${clientContact} the three options (#${row.id.slice(-4)}) — no reply in 30 min defaults to booking a call.` };
    },
  },
  // ── Front Desk booking (Phase 5) ───────────────────────────────────────────────────────────
  //
  // check_availability/book_appointment existed; what the front desk could NOT do was touch a
  // booking that already existed — no way to get an appointment's id, so no reschedule and no
  // cancel. find_appointment is the id-resolution read (same pattern as pipelines_list above);
  // the two writes take ids resolvable from it and ride the approval rail, because a booking is a
  // commitment to a client and changing one is client-visible.
  {
    name: "find_appointment",
    description:
      "Find booked CRM appointments — by day, date range, or matching a title/contact — and return their ids. Use before reschedule_appointment or cancel_appointment (both need the id this returns), or for 'what's booked on Friday'.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Text to match against appointment titles and contact names. Omit to list everything in the window." },
        date: { type: "string", description: "Day to search, YYYY-MM-DD. Defaults to today." },
        days: { type: "number", description: "How many days from `date` to include. Default 7." },
      },
    },
    category: "calendar.internal",
    reversible: true,
    speed: "fast",
    describe: (a) => `Find appointments${s(a.query) ? ` matching "${s(a.query)}"` : ""}${s(a.date) ? ` from ${s(a.date)}` : ""}`,
    run: async (a) => {
      const { osClient, osEnabled } = await import("./osClient");
      if (!osEnabled()) return { ok: false, line: "CRM: not signed in." };
      const start = /^\d{4}-\d{2}-\d{2}$/.test(s(a.date)) ? s(a.date) : new Date().toISOString().slice(0, 10);
      const days = Math.min(Math.max(n(a.days, 7), 1), 60);
      const end = new Date(new Date(`${start}T00:00:00Z`).getTime() + days * 86_400_000).toISOString().slice(0, 10);
      const rows = (unwrapTool(await osClient.callTool("appointments_list", {
        start_date: start, end_date: end, limit: 50,
      })) ?? []) as Array<{
        id?: string; title?: string; start_time?: string; start_at_utc?: string; status?: string;
        contact?: { first_name?: string; last_name?: string }; calendar?: { name?: string };
      }>;
      const q = s(a.query).trim().toLowerCase();
      const hits = (Array.isArray(rows) ? rows : []).filter((r) => {
        if (!q) return true;
        const who = [r.contact?.first_name, r.contact?.last_name].filter(Boolean).join(" ");
        return `${r.title ?? ""} ${who}`.toLowerCase().includes(q);
      });
      if (!hits.length) return { ok: true, line: `CRM: no appointments${q ? ` matching "${s(a.query)}"` : ""} between ${start} and ${end}.` };
      const lines = hits.slice(0, 12).map((r) => {
        const who = [r.contact?.first_name, r.contact?.last_name].filter(Boolean).join(" ");
        return `  ${r.start_time ?? r.start_at_utc ?? "?"} — ${r.title ?? "(untitled)"}${who ? ` with ${who}` : ""}${r.status ? ` (${r.status})` : ""} [${r.id}]`;
      });
      return { ok: true, line: `Appointments ${start} → ${end} (${hits.length}):\n${lines.join("\n")}` };
    },
  },
  {
    name: "reschedule_appointment",
    description:
      `Move an existing CRM appointment to a new time. Needs the appointment id from find_appointment plus the new start and end. When ${OWNER_FIRST} asks directly it runs at once; from anyone else it queues for ${OWNER_FIRST}'s OK first, since the client sees the change.`,
    input_schema: {
      type: "object",
      properties: {
        appointment_id: { type: "string", description: "From find_appointment." },
        start_time: { type: "string", description: "New start, full ISO 8601 with offset." },
        end_time: { type: "string", description: "New end, full ISO 8601 with offset." },
      },
      required: ["appointment_id", "start_time", "end_time"],
    },
    category: "calendar.external",
    // Same posture as book_appointment: a booking is a commitment to a client, so changing one is
    // reversible:false → approval rail. REVERSE GEAR (§7.4): this tool is its own reverse — the
    // result line records the original time precisely so "put it back" is one more call.
    reversible: false,
    speed: "fast",
    describe: (a) => `Reschedule appointment ${s(a.appointment_id).slice(0, 8)} to ${s(a.start_time)}`,
    run: async (a) => {
      const { osClient, osEnabled } = await import("./osClient");
      if (!osEnabled()) return { ok: false, line: "CRM: not signed in — nothing moved." };
      const id = s(a.appointment_id).trim();
      if (!id) return { ok: false, line: "reschedule_appointment: no appointment id. Nothing moved." };
      // Read first: verifies the id AND captures the original time, which IS the reverse gear.
      const appt = unwrapTool(await osClient.callTool("appointments_get", { id })) as
        { id?: string; title?: string; start_time?: string; end_time?: string } | null;
      if (!appt?.id) return { ok: false, line: `reschedule_appointment: no appointment with id "${id}". Nothing moved.` };
      await osClient.callTool("appointments_update", { id, start_time: s(a.start_time), end_time: s(a.end_time) });
      return {
        ok: true,
        line: `CRM: "${appt.title ?? id}" moved to ${s(a.start_time)}. It was ${appt.start_time ?? "?"}–${appt.end_time ?? "?"} — reschedule back to that if this needs undoing.`,
      };
    },
  },
  {
    name: "cancel_appointment",
    description:
      `Cancel a booked CRM appointment. Needs the id from find_appointment. When ${OWNER_FIRST} asks directly it runs at once; from anyone else it queues for ${OWNER_FIRST}'s OK first. The booking is marked cancelled, never deleted — the record stays.`,
    input_schema: {
      type: "object",
      properties: {
        appointment_id: { type: "string", description: "From find_appointment." },
        reason: { type: "string", description: "Short reason, kept on the record." },
      },
      required: ["appointment_id"],
    },
    category: "calendar.external",
    // Cancel is a STATUS FLIP via appointments_update, deliberately not appointments_delete — a
    // delete destroys the record and has no reverse; a cancelled row can be un-cancelled or
    // rebooked with every detail intact. Still reversible:false: the client experiences a
    // cancellation either way, so the owner confirms it. REVERSE GEAR (§7.4): set the status back (the
    // result line records what it was) or rebook from the intact record.
    reversible: false,
    speed: "fast",
    describe: (a) => `Cancel appointment ${s(a.appointment_id).slice(0, 8)}${s(a.reason) ? ` — ${s(a.reason).slice(0, 50)}` : ""}`,
    run: async (a) => {
      const { osClient, osEnabled } = await import("./osClient");
      if (!osEnabled()) return { ok: false, line: "CRM: not signed in — nothing cancelled." };
      const id = s(a.appointment_id).trim();
      if (!id) return { ok: false, line: "cancel_appointment: no appointment id. Nothing cancelled." };
      const appt = unwrapTool(await osClient.callTool("appointments_get", { id })) as
        { id?: string; title?: string; start_time?: string; status?: string; description?: string } | null;
      if (!appt?.id) return { ok: false, line: `cancel_appointment: no appointment with id "${id}". Nothing cancelled.` };
      if (appt.status === "cancelled") return { ok: true, line: `CRM: "${appt.title ?? id}" is already cancelled.` };
      const reason = s(a.reason).trim();
      await osClient.callTool("appointments_update", {
        id, status: "cancelled",
        ...(reason ? { description: `${appt.description ? `${appt.description}\n` : ""}[cancelled: ${reason}]` } : {}),
      });
      return {
        ok: true,
        line: `CRM: cancelled "${appt.title ?? id}" (was ${appt.start_time ?? "?"}, status ${appt.status ?? "confirmed"}). The record is kept — it can be un-cancelled or rebooked as-is.`,
      };
    },
  },
  {
    name: "add_contact_note",
    description:
      "Write a note onto a CRM contact's record. Use after a call or conversation — 'note that Casey wants the quote by Friday'.",
    input_schema: {
      type: "object",
      properties: {
        contact: { type: "string", description: "Name, email or company — resolved against the CRM." },
        note: { type: "string" },
      },
      required: ["contact", "note"],
    },
    category: "research.run",
    reversible: true, // a note is additive and internal
    speed: "fast",
    describe: (a) => `Note on ${s(a.contact)}: ${s(a.note).slice(0, 60)}`,
    run: async (a) => {
      const { osClient, osEnabled } = await import("./osClient");
      if (!osEnabled()) return { ok: false, line: "CRM: not signed in." };
      const rows = (unwrapTool(await osClient.callTool("contacts_list", { search: s(a.contact), limit: 5 })) ?? []) as
        Array<{ id?: string; first_name?: string; last_name?: string }>;
      if (!Array.isArray(rows) || !rows.length) return { ok: false, line: `CRM: no contact matching "${s(a.contact)}" — nothing written.` };
      if (rows.length > 1) {
        return {
          ok: false,
          line: `CRM: "${s(a.contact)}" matches ${rows.length} contacts (${rows.map((r) => [r.first_name, r.last_name].filter(Boolean).join(" ")).join(", ")}) — tell me which one and I'll write it.`,
        };
      }
      await osClient.callTool("contact_notes_create", { contact_id: rows[0].id, content: s(a.note) });
      const who = [rows[0].first_name, rows[0].last_name].filter(Boolean).join(" ");
      return { ok: true, line: `CRM: note added to ${who}.` };
    },
  },
  {
    name: "read_thread",
    description:
      "Read a whole conversation thread in order. Two sources: a CRM client conversation by its id (email/sms/phone channels the business runs — pass conversation_id; call with no args first to list recent ones), or the owner's own chat log for a given day (pass date YYYY-MM-DD). Use for 'pull up that conversation with X', 'what did the client say in that thread', 'show me what we talked about Tuesday'. Read-only. For SEARCHING history use recall_sessions; this reads a known thread end to end.",
    input_schema: {
      type: "object",
      properties: {
        conversation_id: { type: "string", description: "CRM conversation id. Omit with no date to list recent conversations and their ids." },
        date: { type: "string", description: "YYYY-MM-DD — read that day of the owner's own chat log instead of a CRM thread." },
        limit: { type: "number", description: "Max messages to show. Default 20 (CRM) / 200 (own log)." },
      },
    },
    category: "research.run",
    reversible: true,
    speed: "fast",
    describe: (a) => s(a.conversation_id) ? `Read CRM thread ${s(a.conversation_id).slice(0, 8)}` : s(a.date) ? `Read own chat log for ${s(a.date)}` : "List recent CRM conversations",
    run: async (a) => {
      // Own chat log by day — threads.ts reads messages.jsonl directly.
      if (/^\d{4}-\d{2}-\d{2}$/.test(s(a.date))) {
        const { readOwnThread, formatOwnThread } = await import("./threads");
        const rows = await readOwnThread(s(a.date), Math.min(Math.max(n(a.limit, 200), 1), 500));
        return { ok: true, line: formatOwnThread(s(a.date), rows) };
      }
      const { osClient, osEnabled } = await import("./osClient");
      if (!osEnabled()) return { ok: false, line: "CRM: not signed in, so I can only read my own chat log (pass a date)." };
      const convId = s(a.conversation_id).trim();
      if (!convId) {
        // No id and no date: list recent conversations so the next call has an id to use.
        const convs = (unwrapTool(await osClient.callTool("conversations_list", { limit: 10 })) ?? []) as
          Array<{ id?: string; subject?: string; channel?: string; status?: string; last_message_at?: string; contact?: { first_name?: string; last_name?: string } }>;
        if (!Array.isArray(convs) || !convs.length) return { ok: true, line: "CRM: no conversations on file." };
        const lines = convs.map((c) => {
          const who = [c.contact?.first_name, c.contact?.last_name].filter(Boolean).join(" ");
          return `  ${(c.last_message_at ?? "").slice(0, 16) || "?"} — ${c.channel ?? "?"}${who ? ` with ${who}` : ""}${c.subject ? `: ${c.subject}` : ""} (${c.status ?? "?"}) [${c.id}]`;
        });
        return { ok: true, line: `Recent CRM conversations:\n${lines.join("\n")}\nGive me an id and I'll read the whole thread.` };
      }
      const conv = unwrapTool(await osClient.callTool("conversations_get", { id: convId })) as {
        id?: string; subject?: string; channel?: string;
        contact?: { first_name?: string; last_name?: string };
        messages?: Array<{ body?: string; content?: string; direction?: string; sender_type?: string; created_at?: string }>;
      } | null;
      if (!conv?.id) return { ok: false, line: `CRM: no conversation with id "${convId}".` };
      const who = [conv.contact?.first_name, conv.contact?.last_name].filter(Boolean).join(" ") || "unknown contact";
      const msgs = (Array.isArray(conv.messages) ? conv.messages : [])
        .sort((x, y) => String(x.created_at ?? "").localeCompare(String(y.created_at ?? "")))
        .slice(-Math.min(Math.max(n(a.limit, 20), 1), 100));
      if (!msgs.length) return { ok: true, line: `CRM thread with ${who} (${conv.channel ?? "?"}): no messages yet.` };
      const lines = msgs.map((m) => {
        const from = m.direction === "inbound" ? who : (m.sender_type ?? m.direction ?? "us");
        const text = String(m.body ?? m.content ?? "").replace(/\s+/g, " ").slice(0, 240);
        return `[${String(m.created_at ?? "").slice(0, 16)}] ${from}: ${text}`;
      });
      return { ok: true, line: `CRM thread with ${who} (${conv.channel ?? "?"}${conv.subject ? ` — ${conv.subject}` : ""}, ${msgs.length} shown):\n${lines.join("\n")}` };
    },
  },
  {
    name: "proposals_list",
    description:
      "List CRM proposals (newest first) with their ids, status, and contact — the id-resolution path for send_for_signature/signature_status. Optional status filter: draft, sent, accepted, declined.",
    input_schema: {
      type: "object",
      properties: {
        status: { type: "string", description: "Filter: draft | sent | accepted | declined." },
        limit: { type: "number", description: "Max rows (default 15)." },
      },
    },
    category: "research.run",
    reversible: true,
    speed: "fast",
    describe: (a) => `List proposals${s(a.status) ? ` (${s(a.status)})` : ""}`,
    run: async (a) => {
      const { osEnabled } = await import("./osClient");
      if (!osEnabled()) return { ok: false, line: "CRM: not signed in." };
      const { dealsCallTool, unwrapToolResult } = await import("./deals");
      const rows = unwrapToolResult(await dealsCallTool("proposals_list", {
        ...(s(a.status).trim() ? { status: `eq.${s(a.status).trim()}` } : {}),
        limit: Math.min(Math.max(n(a.limit, 15), 1), 50),
      })) as Array<Record<string, unknown>>;
      if (!Array.isArray(rows) || !rows.length) return { ok: true, line: "CRM: no proposals found." };
      const lines = rows.map((r) => {
        const c = (r.contact ?? {}) as Record<string, unknown>;
        const who = [c.first_name, c.last_name].filter(Boolean).join(" ") || c.company || "?";
        return `· ${String(r.title ?? r.name ?? "(untitled)").slice(0, 60)} [${r.id}] — ${r.status ?? "?"}${r.signature_status ? ` / sig: ${r.signature_status}` : ""} — ${who}`;
      });
      return { ok: true, line: [`Proposals (${rows.length}):`, ...lines].join("\n") };
    },
  },
  {
    name: "contracts_list",
    description:
      "List CRM contracts (newest first) with their ids, status, and contact — the id-resolution path for send_for_signature/signature_status on contracts.",
    input_schema: {
      type: "object",
      properties: {
        status: { type: "string", description: "Optional status filter." },
        limit: { type: "number", description: "Max rows (default 15)." },
      },
    },
    category: "research.run",
    reversible: true,
    speed: "fast",
    describe: (a) => `List contracts${s(a.status) ? ` (${s(a.status)})` : ""}`,
    run: async (a) => {
      const { osEnabled } = await import("./osClient");
      if (!osEnabled()) return { ok: false, line: "CRM: not signed in." };
      const { dealsCallTool, unwrapToolResult } = await import("./deals");
      const rows = unwrapToolResult(await dealsCallTool("contracts_list", {
        ...(s(a.status).trim() ? { status: `eq.${s(a.status).trim()}` } : {}),
        limit: Math.min(Math.max(n(a.limit, 15), 1), 50),
      })) as Array<Record<string, unknown>>;
      if (!Array.isArray(rows) || !rows.length) return { ok: true, line: "CRM: no contracts found." };
      const lines = rows.map((r) => {
        const c = (r.contact ?? {}) as Record<string, unknown>;
        const who = [c.first_name, c.last_name].filter(Boolean).join(" ") || c.company || "?";
        return `· ${String(r.title ?? r.name ?? "(untitled)").slice(0, 60)} [${r.id}] — ${r.status ?? "?"}${r.signature_status ? ` / sig: ${r.signature_status}` : ""} — ${who}`;
      });
      return { ok: true, line: [`Contracts (${rows.length}):`, ...lines].join("\n") };
    },
  },
  {
    name: "send_for_signature",
    description:
      `Send a CRM proposal or contract out for e-signature through the OS's own signing rail — freezes the document, emails the signer a signing link, and tracks status. Needs the document type (proposal|contract), its id (from proposals_list/contracts_list via the CRM), and the signer's email. This QUEUES for ${OWNER_FIRST}'s approval; nothing is sent until they confirm.`,
    input_schema: {
      type: "object",
      properties: {
        document_type: { type: "string", enum: ["proposal", "contract"], description: "What is being signed." },
        document_id: { type: "string", description: "The proposal/contract UUID." },
        signer_email: { type: "string", description: "Signer's email address." },
        signer_name: { type: "string", description: "Signer's full name (optional)." },
        expires_in_days: { type: "number", description: "Link validity (default 14 days)." },
      },
      required: ["document_type", "document_id", "signer_email"],
    },
    category: "email.work",
    // A client-facing send with no retraction once signed → approval rail, same as create_deal.
    // REVERSE GEAR (§7.4): signature_void below unlocks the document until it's signed; a signed
    // document is a completed legal act — which is the reason for the gate.
    reversible: false,
    speed: "fast",
    describe: (a) => `Send ${s(a.document_type)} ${s(a.document_id).slice(0, 8)}… for e-signature to ${s(a.signer_email)}`,
    run: async (a) => {
      const { osEnabled } = await import("./osClient");
      if (!osEnabled()) return { ok: false, line: "E-signature: not signed in to the OS, so nothing was sent." };
      const kind = s(a.document_type).trim() === "contract" ? "contract" : "proposal";
      const email = s(a.signer_email).trim();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { ok: false, line: `E-signature: "${email}" doesn't look like an email address. Nothing sent.` };
      const { dealsCallTool, unwrapToolResult } = await import("./deals");
      const out = unwrapToolResult(await dealsCallTool(`${kind}_send_for_signature`, {
        document_id: s(a.document_id).trim(),
        signer_email: email,
        ...(s(a.signer_name).trim() ? { signer_name: s(a.signer_name).trim() } : {}),
        ...(typeof a.expires_in_days === "number" ? { expires_in_days: a.expires_in_days } : {}),
      })) as Record<string, unknown>;
      const url = typeof out?.signing_url === "string" ? out.signing_url : null;
      return { ok: true, line: `E-signature: ${kind} sent to ${email}.${url ? ` Signing link: ${url}` : ""} It can be voided with signature_void until it's signed; once signed there's no retraction.` };
    },
  },
  {
    name: "signature_status",
    description:
      "Check where a proposal or contract's e-signature request stands — pending, viewed, signed, declined, expired, or voided. Read-only.",
    input_schema: {
      type: "object",
      properties: {
        document_type: { type: "string", enum: ["proposal", "contract"], description: "What kind of document." },
        document_id: { type: "string", description: "The proposal/contract UUID." },
      },
      required: ["document_type", "document_id"],
    },
    category: "research.run",
    reversible: true,
    speed: "fast",
    describe: (a) => `Check ${s(a.document_type)} signature status`,
    run: async (a) => {
      const { osEnabled } = await import("./osClient");
      if (!osEnabled()) return { ok: false, line: "E-signature: not signed in to the OS." };
      const kind = s(a.document_type).trim() === "contract" ? "contract" : "proposal";
      const { dealsCallTool, unwrapToolResult } = await import("./deals");
      // The status reads key by proposal_id/contract_id (send/void take document_id — MCP quirk).
      const out = unwrapToolResult(await dealsCallTool(`${kind}_signature_status_get`, { [`${kind}_id`]: s(a.document_id).trim() }));
      return { ok: true, line: `E-signature status for ${kind} ${s(a.document_id).slice(0, 8)}…:
${JSON.stringify(out, null, 1).slice(0, 900)}` };
    },
  },
  {
    name: "signature_void",
    description:
      `Void an active e-signature request on a proposal or contract — the reverse gear for send_for_signature. Unlocks the document for edits; only works while it is NOT yet signed. This QUEUES for ${OWNER_FIRST}'s approval (voiding a live signing link is client-visible).`,
    input_schema: {
      type: "object",
      properties: {
        document_type: { type: "string", enum: ["proposal", "contract"], description: "What kind of document." },
        document_id: { type: "string", description: "The proposal/contract UUID." },
      },
      required: ["document_type", "document_id"],
    },
    category: "email.work",
    reversible: false,
    speed: "fast",
    describe: (a) => `Void the active signature request on ${s(a.document_type)} ${s(a.document_id).slice(0, 8)}…`,
    run: async (a) => {
      const { osEnabled } = await import("./osClient");
      if (!osEnabled()) return { ok: false, line: "E-signature: not signed in to the OS." };
      const kind = s(a.document_type).trim() === "contract" ? "contract" : "proposal";
      const { dealsCallTool, unwrapToolResult } = await import("./deals");
      unwrapToolResult(await dealsCallTool(`${kind}_signature_void`, { document_id: s(a.document_id).trim() }));
      return { ok: true, line: `E-signature: the active request on ${kind} ${s(a.document_id).slice(0, 8)}… is voided — the document is unlocked for edits and the old signing link is dead.` };
    },
  },
  {
    name: "crm_lookup",
    description: "Search the CRM for a contact by name, email or company.",
    input_schema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
    category: "research.run",
    reversible: true,
    speed: "fast",
    describe: (a) => `CRM lookup: ${s(a.query)}`,
    run: async (a) => {
      const { osClient, osEnabled } = await import("./osClient");
      if (!osEnabled()) return { ok: false, line: "CRM: not signed in, so I couldn't look that up." };
      const raw = await osClient.callTool("contacts_list", { search: s(a.query), limit: 10 });
      const rows = unwrapTool(raw) as Array<{ first_name?: string; last_name?: string; email?: string; company?: string }>;
      if (!Array.isArray(rows) || !rows.length) return { ok: true, line: `CRM: no contact matching "${s(a.query)}".` };
      return {
        ok: true,
        line: `CRM (${rows.length}):\n` + rows.slice(0, 10).map((r) =>
          `  ${[r.first_name, r.last_name].filter(Boolean).join(" ")}${r.company ? ` · ${r.company}` : ""}${r.email ? ` · ${r.email}` : ""}`).join("\n"),
      };
    },
  },
  {
    name: "recall_sessions",
    description:
      `Search past conversations with ${OWNER_FIRST} — full-text over every prior chat session, months back. Use when a request references something discussed before: 'what did we decide about X', 'didn't I ask you about this already', 'find that thing ${OWNER_FIRST} mentioned last month', or when today's ask clearly continues earlier work you don't have in context. Returns matching moments with their session date and topic. Read-only; searches only your own history.`,
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to look for — plain keywords work best (e.g. 'boat insurance renewal')." },
        limit: { type: "number", description: "Max matches to return (default 8)." },
      },
      required: ["query"],
    },
    category: "research.run",
    reversible: true,
    speed: "fast",
    describe: (a) => `Recall past sessions: ${s(a.query).slice(0, 60)}`,
    run: async (a) => {
      const query = s(a.query).trim();
      if (!query) return { ok: false, line: "recall_sessions: nothing to search for." };
      const { searchRecall } = await import("./recall");
      const out = await searchRecall(query, Math.min(Math.max(n(a.limit, 8), 1), 20));
      return { ok: true, line: `Recall for "${query}":\n${out}` };
    },
  },
  // Prospect intelligence engine (Part 5 of the plan) — kept in its own module rather than inlined
  // like everything above it; the module is big enough on its own (8 tools) to earn the file split,
  // and every handler needs the same osBridge/planner/estimator imports regardless.
  ...PROSPECT_TOOLS,
];

function unwrapTool(content: unknown): unknown {
  if (Array.isArray(content)) {
    const first = content.find((c) => c && typeof c === "object" && "text" in (c as object));
    if (first && typeof (first as { text?: unknown }).text === "string") {
      try { return JSON.parse((first as { text: string }).text); } catch { return (first as { text: string }).text; }
    }
  }
  return content;
}

// ── The completion-claim guard ────────────────────────────────────────────────────

/**
 * Re-exported from agent-core, where the regex now lives so every agent catches the same shape
 * (it gained deploy/publish/pause for FRIDAY's verbs). Kept as a named export here
 * because the guard probe and the SMS route both import it from this module.
 */
export const claimsCompletion = coreClaimsCompletion;

// ── Router ──────────────────────────────────────────────────────────────────────

function systemPrompt(ctx: IntentContext, identity: string, knownDocs = ""): string {
  return `${identity}

You are handling a request from ${OWNER_FIRST} over ${ctx.source}.

HOW YOU ACT. You have tools. Calling a tool is the ONLY way you can affect anything. You cannot
archive mail, move a meeting, or restart a service by describing it — if you did not call the tool,
it did not happen, and saying otherwise is the worst thing you can do here.

Therefore:
- If the request maps to a tool, CALL IT. Do not ask permission for reversible things; just do them
  and report. The owner asked for an assistant, not a form.
- If anything you need to do it correctly is missing or ambiguous — which event, which address, what
  time, what exactly — ASK before acting: every question you need, together in one message. Do not
  guess at anything that changes state. Once they've answered, do it. Never ask them to approve something
  they asked you to do.
- If nothing fits, say plainly that you can't do it yet. Never imply it's done.
- NEVER write a sentence claiming you completed something unless a tool returned success for it.

Interpret intent, not keywords. "my inbox is a disaster", "sort out my email", "what's my week look
like", "kill friday and bring it back" — these are all requests for specific tools. Read what they
mean.

WHAT YOU CAN ACTUALLY DO. Email, calendar, tasks, follow-ups, Drive/documents, weather, CRM
lookups (pipeline, deals, invoices, appointments, contact notes, client conversation threads),
and approval-gated CRM writes (create/move deals, book/reschedule/cancel appointments — each
queues for ${OWNER_FIRST}'s confirmation before anything changes) — you
are the only agent with access to ${OWNER_FIRST}'s work mail and calendar,
and that access is exclusive to you, not shared with FRIDAY. When asked what you can do
or whether you have access to something, answer from the tools actually available to you in this
request, not from a guess at what would be reasonable — if nothing here covers it, say so plainly.
${knownDocs}

WORK THAT ISN'T YOURS. FRIDAY does work you don't:
- FRIDAY — software, deploys, repos, infrastructure, client deliverables and docs, and SEO (on-site, off-site, local/Google Business Profile).
We don't offer paid ads or marketing. If someone asks
for ads, campaigns, budgets or creative work, say plainly that it's not a service we offer — don't assign it.
When a request is FRIDAY's, ASSIGN IT with delegate_to_agent instead of answering it yourself. This
applies just as much to something you read in an email as to something ${OWNER_FIRST} typed: an emailed "can
you get the staging site back up" is FRIDAY's task, and forwarding ${OWNER_FIRST} a summary of it is not the
same as assigning it.
Questions ABOUT their work are different: "how's Acme Co going", "did FRIDAY finish that", "anything
open with Globex" are yours to answer with project_status / client_status / delegation_status —
they read the benches' live records and say how fresh each source is. Never delegate a status
question; a delegation can create a task, and a question is not a task.

Report what the tool actually returns, and no more. If it gives you a task id, say so and quote it.
If it says it couldn't confirm anything was queued, say exactly that and pass on the agent's reply —
do not round it up to "I've handed it over", and equally do not declare that nothing happened, which
you also don't know. If it says the agent didn't answer in time, tell ${OWNER_FIRST} it may still be running
and that re-sending could duplicate the work. You are the one ${OWNER_FIRST} trusts to know the difference
between asked, assigned, and unconfirmed.

${
  ctx.source === "sms"
    ? "Keep it under 300 characters. This is a text message."
    : ctx.source === "voice"
      // A live phone call: no bullet lists or headers (nobody can see them), and no padding —
      // but a real answer over the phone is still a real answer, not a fragment. Say what
      // matters in natural spoken sentences, the way you'd actually explain it out loud.
      ? "You're on a live call. Speak in complete, natural sentences — this is a real conversation, not a headline. Skip written-report structure (no bullets, no headers, nothing that only makes sense on a screen), but don't clip a real answer down to a fragment just to sound short."
      // Chat/desk — text AND whatever the browser reads aloud of it. This is the register the owner
      // asked for explicitly: a genuine 1:1 with a trusted confidant, not a terse status ping.
      // "Brief" here means never padded, not never detailed — say everything that's actually
      // useful, the way you'd walk someone through it if they were standing next to you.
      : "Talk to them like the person who knows this stuff cold and is genuinely on their side — not a terse status line. Give the real answer: what you found, why it matters, what you'd do about it. Skip filler and hedging, but don't compress a real answer into a fragment just to look efficient — if the honest answer takes four sentences, take four sentences."
}`;
}

// Per-tool telemetry — every run() is wrapped ONCE, here at registration, so no tool can exist in
// the catalog uninstrumented (the whole point of agent-core's wrap() choke-point design). Records
// call/success/latency to ~/.agentic-os/clara/tool-telemetry.jsonl; never throws into a tool path.
const TELEMETRY = new ToolTelemetry({
  dataDir: path.join(os.homedir(), ".agentic-os", "clara"),
  agent: "clara",
});
const INSTRUMENTED_TOOLS: ToolDef[] = TOOLS.map((t) => ({ ...t, run: TELEMETRY.wrap(t.name, t.run) }));

/** A Gemini entry in the chain that can actually be called (a key is set). */
function usableGemini(chain: ModelTarget[]): boolean {
  return chain.some((t) => t.provider === "google") && Boolean(geminiApiKey());
}

/** The OS persona override for a subagent, appended to (or replacing) its soul file. */
function withSubagentPersona(soul: string, s: EffectiveAgentSettings): string {
  const extra = [s.prompts.persona_override?.trim(), ...s.prompts.templates.map((t) => t.body.trim())].filter(Boolean).join("\n\n");
  if (!extra) return soul;
  if (s.prompts.persona_mode === "replace") return extra;
  return soul.trim() ? `${soul.trim()}\n\n${extra}` : extra;
}

type RouterCaller = ReturnType<typeof anthropicCaller>;

/**
 * The router's model chain from the OS settings: primary → fallback → the built-in MODEL, each tried
 * per call in order. A Gemini entry uses gemini.ts's function-calling translation; with no Gemini
 * key it is skipped with one ledger line. Exported for tests (callers are injectable).
 */
export function routerModelChain(
  chain: ModelTarget[],
  opts: { anthropicKey?: string; geminiKey?: string | null; maxTokens: number; onToken?: (t: string) => void },
): { target: ModelTarget; call: RouterCaller }[] {
  const out: { target: ModelTarget; call: RouterCaller }[] = [];
  for (const t of chain) {
    if (t.provider === "google") {
      if (opts.geminiKey) out.push({ target: t, call: geminiCaller(opts.geminiKey, t.model, opts.maxTokens, { onToken: opts.onToken }) });
    } else if (opts.anthropicKey) {
      out.push({
        target: t,
        call: opts.onToken ? anthropicStreamingCaller(opts.anthropicKey, opts.onToken, t.model, opts.maxTokens) : anthropicCaller(opts.anthropicKey, t.model, opts.maxTokens),
      });
    }
  }
  return out;
}

/**
 * Tools the router may offer this turn: CLARA's catalog ∩ OS allowed − OS denied — CLARA's own
 * settings first, then (for a subagent run) the subagent's. Never adds a tool.
 */
export function routerTools<T extends { name: string }>(tools: T[], s: EffectiveAgentSettings, root?: EffectiveAgentSettings): T[] {
  const narrowed = root && root !== s ? filterTools(tools, root.tools) : tools;
  return filterTools(narrowed, s.tools);
}

/**
 * CLARA's bindings to the shared loop: her tier table decides act-vs-ask, her approvals queue holds
 * what needs confirming, her ledger records failures, and her sensitivity screen keeps private
 * content off a hosted model entirely.
 */
function adapter(
  key: string,
  onToken?: (text: string) => void,
  settings?: EffectiveAgentSettings,
  rootSettings?: EffectiveAgentSettings,
): IntentAdapter<IntentContext, ToolDef> {
  const s = settings ?? rootSettings;
  const maxTokens = narrowIntCap(ROUTER_MAX_TOKENS, s?.limits.max_tokens);
  const targets = s ? modelChain(s, MODEL) : [{ provider: "anthropic" as const, model: MODEL, via: "default" as const }];
  const callers = routerModelChain(targets, { anthropicKey: key || undefined, geminiKey: geminiApiKey(), maxTokens, onToken });
  const skippedGemini = targets.some((t) => t.provider === "google") && !geminiApiKey();
  const ignored = s ? ignoredModelReason(s) : null;
  // Runtime CLI fallback (2026-08-13 outage): an Anthropic API failure — credits, 5xx, network —
  // degrades to the Claude CLI on the owner's subscription instead of a dead router. The fallback is
  // per-call, so the API resumes automatically the moment it recovers. OS settings (2026-10-29) put
  // their model chain in front: primary → fallback → MODEL → CLI.
  let noted = false;
  const claudeChain: RouterCaller = async (input) => {
    if (!noted) {
      noted = true;
      if (skippedGemini) await ledgerAppend({ kind: "action", actor: "clara", what: "router: OS picked a Gemini model but GEMINI_API_KEY / GOOGLE_AI_API_KEY is not set — using the next model in the chain" }).catch(() => {});
      if (ignored) await ledgerAppend({ kind: "action", actor: "clara", what: `router: OS model setting not used (${ignored}) — built-in model` }).catch(() => {});
    }
    for (const { target, call } of callers) {
      try {
        return await call(input);
      } catch (e) {
        await ledgerAppend({ kind: "action", actor: "clara", what: `router ${target.provider}/${target.model} (${target.via}) failed (${String(e).slice(0, 120)}) — trying the next model` }).catch(() => {});
      }
    }
    await ledgerAppend({ kind: "action", actor: "clara", what: "router API models exhausted — falling back to CLI" }).catch(() => {});
    const { cliCaller } = await import("./intentCli");
    return cliCaller()(input);
  };
  // 2026-09-15: Claude is the router's model — the Anthropic API, then the Claude CLI on the owner's
  // subscription (claudeChain above). LM Studio is retired (engine lineup since 2026-09-13: Claude,
  // Codex, Antigravity). The 2026-08-23 "LM Studio first" chain tried it on every turn; with no model
  // loaded it failed each time ("No LM Studio chat model resolved") and only added latency — and a
  // ledger line — before Claude answered anyway.
  const callModel: RouterCaller = claudeChain;
  return {
    agent: "clara",
    tools: s ? routerTools(INSTRUMENTED_TOOLS, s, rootSettings) : INSTRUMENTED_TOOLS,
    maxTurns: narrowIntCap(ROUTER_MAX_TURNS, s?.limits.max_turns),
    callModel,
    systemPrompt: async (ctx) => {
      // Soul-prefixed principal identity (constitution → persona → learned, then the operational
      // identity). Principal path only — the business persona never sees the soul; see persona.ts.
      const { principalIdentityWithSoul } = await import("./persona");
      // Known reference docs (knowledge/sources.json) so "edit the ICP" resolves to the right file.
      // Principal path only — the business persona never gets file ids.
      const { knownDocumentsBlock } = await import("./knowledge");
      const docs = await knownDocumentsBlock().catch(() => "");
      return systemPrompt(ctx, await principalIdentityWithSoul(), docs);
    },
    gate: async (tool, ctx): Promise<IntentGate> => {
      const decision = await can(ctx.principal, tool.category);
      if (decision.posture === "blocked") return { decision: "block", reason: decision.reason };
      // After the policy check, so a policy-blocked tool never shows up as a proposed action.
      if (readOnlyBlocks(tool.name, ctx)) return { decision: "block", reason: PROPOSED_MARK };
      // OS require_approval only ever ADDS approvals: anything that isn't a pure read queues, even
      // the owner's own asks that delegationForce would otherwise waive.
      if (requireApproval(tool.name, s, rootSettings)) return { decision: "approve" };
      // The loop applies the `reversible` override itself, so this only has to report what the
      // tier table says — except for the owner's own delegations, which it vouches for outright.
      if (delegationForce(tool.name, ctx, tool.category)) return { decision: "run", force: true };
      if (!decision.allow || decision.posture === "draft-then-approve") return { decision: "approve" };
      return { decision: "run" };
    },
    queueApproval: async (tool, args, ctx, requestText) => {
      // kind "intent.tool", NOT "generic" — generic's executor is a no-op that returns ok, so
      // approving would silently discard the very action being confirmed.
      const a = await approvalDraft({
        kind: "intent.tool",
        title: tool.describe(args),
        summary: `Requested over ${ctx.source}: "${requestText.slice(0, 200)}"`,
        requestor: ctx.principal,
        intent: { tool: tool.name, args, principal: ctx.principal, source: ctx.source },
      });
      return { code: shortCode(a.id) };
    },
    log: async (what, meta) => {
      await ledgerAppend({ kind: "action", actor: "clara", what, meta }).catch(() => {});
    },
    // Sensitive content never leaves the machine, and the local model is not reliable at tool
    // calling — so rather than guess, the router declines and lets the caller fall back.
    preflight: async (text) =>
      classifySensitive({ text }).sensitive
        ? { reply: "That looks sensitive, so I'm keeping it on the local model and not routing it through my tools. Ask me directly and I'll handle it without touching anything." }
        : null,
  };
}

/**
 * Route one request.
 *
 * Never throws. A failure returns `failed: true` with an honest message — a router that cannot run
 * must not degrade into free prose, because free prose is exactly what invented the original lie.
 */
export async function runIntent(text: string, ctx: IntentContext): Promise<IntentOutcome> {
  // OS per-agent settings (agentSettings.ts) — cached, never throws, defaults when the OS is down.
  const snap = await getAgentSettings();
  const s = snap.root;
  const refusal = statusRefusal(s);
  if (refusal) {
    const { reportStatusChange } = await import("./modelCall");
    await reportStatusChange(s.status, `router (${ctx.source})`);
    // clarifying: true — a refusal the caller must deliver, not paper over with its own LLM path.
    return { reply: refusal, calls: [], failed: false, clarifying: true };
  }
  if (s.limits.rate_limit_per_minute && !takeModelCallSlot(s.limits.rate_limit_per_minute)) {
    await ledgerAppend({ kind: "action", actor: "clara", what: `router: over the OS rate limit (${s.limits.rate_limit_per_minute}/min) — turn refused` }).catch(() => {});
    return {
      reply: "I'm at the request limit set for me in the OS for this minute, so I'm holding off rather than guessing. Nothing was changed — ask again in a minute.",
      calls: [], failed: false, clarifying: true,
    };
  }
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key && !usableGemini(modelChain(s, MODEL))) {
    return {
      reply: "I can't reach my planning model right now, so I'm not going to guess at what you wanted. Nothing was changed.",
      calls: [], failed: true, clarifying: false,
    };
  }
  return runIntentLoop<IntentContext, ToolDef>(text, ctx, adapter(key ?? "", ctx.onToken, s, s));
}

/** OS require_approval (CLARA's or the subagent's): every tool that isn't a pure read queues. */
export function requireApproval(toolName: string, s?: EffectiveAgentSettings, root?: EffectiveAgentSettings): boolean {
  if (!s?.require_approval && !root?.require_approval) return false;
  return !READ_ONLY_TOOLS.has(toolName);
}

/**
 * Run ONE tool call a human already approved in the OS approval queue (clara.instruction's
 * deliver step), with exactly the arguments that were drafted — no model in the loop, so what
 * runs is what was approved. The approval replaces the approve-queue; a tier-table "blocked"
 * category stays blocked. Never throws.
 */
export async function runApprovedToolCall(name: string, args: Record<string, unknown>, ctx: IntentContext): Promise<{ ok: boolean; line: string }> {
  const tool = INSTRUMENTED_TOOLS.find((t) => t.name === name);
  if (!tool) return { ok: false, line: `${name}: no such tool` };
  const decision = await can(ctx.principal, tool.category);
  if (decision.posture === "blocked") return { ok: false, line: `${name}: blocked by policy — ${decision.reason}` };
  await ledgerAppend({ kind: "action", actor: "clara", what: `running OS-approved ${name}`, meta: { tool: name, requestRef: ctx.requestRef } }).catch(() => {});
  try {
    return await tool.run(args, ctx);
  } catch (e) {
    return { ok: false, line: `${name}: FAILED — ${String(e).slice(0, 200)}` };
  }
}
