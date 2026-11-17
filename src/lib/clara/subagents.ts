// CLARA's department roster (JARVIS-pivot A3, plan §7.2/§10) — seven sub-agents, each a scoped
// execution context over agent-core's workerpool. Tool subsets are deliberately narrow: the pool
// enforces parent ∩ subset in code, so a name listed here that CLARA doesn't carry simply
// vanishes (fails safe), and nothing here can ever exceed what CLARA herself is gated to do.

import os from "node:os";
import path from "node:path";
import type { SubAgentDef } from "@autom8ionlab/agent-core";
import { OWNER_FIRST } from "./owner";
import { filterToolNames, settingsFor, type AgentSettingsSnapshot } from "./agentSettings";

export const SOULS_DIR = process.env.ORION_SOULS_DIR ?? path.join(os.homedir(), ".agentic-os", "souls");

export const SUBAGENTS: SubAgentDef[] = [
  {
    id: "front-desk",
    name: "Front Desk",
    parent: "clara",
    description: "Inbound leads, screening, CRM hygiene, follow-ups.",
    tools: ["crm_lookup", "deal_lookup", "add_contact_note", "book_appointment", "check_availability", "list_calendar", "track_followup", "list_followups", "escalate_out_of_scope_request", "portal_message"],
  },
  {
    id: "scheduler",
    name: "Scheduler",
    parent: "clara",
    description: "Calendar surgery — slots, bookings, moves, coordination.",
    tools: ["list_calendar", "find_free_slot", "book_event", "move_event", "cancel_event", "check_availability", "book_appointment", "coordinate_event"],
  },
  {
    id: "inbox-triage",
    name: "Inbox Triage",
    parent: "clara",
    description: "Mail sweeps, subscriptions, senders, reply drafts.",
    tools: ["find_email", "sweep_inbox", "list_subscriptions", "unsubscribe_from", "block_sender", "list_blocked", "draft_email"],
  },
  {
    id: "contracts-docs",
    name: "Contracts & Docs",
    parent: "clara",
    description: "Documents — drafting, editing, filing, deep document builds.",
    tools: ["drive_search", "drive_read", "drive_create", "drive_edit", "make_document", "deep_work"],
  },
  {
    id: "researcher",
    name: "Researcher",
    parent: "clara",
    description: "Deep research write-ups and source digging.",
    tools: ["deep_work", "drive_search", "drive_read", "get_weather"],
  },
  {
    id: "advisor",
    name: "Advisor",
    parent: "clara",
    description: `${OWNER_FIRST}-facing strategy counsel — briefs, pipeline, the long view. Never client-facing.`,
    tools: ["brief_me", "pipeline_status", "invoice_status", "deal_lookup", "deep_work"],
  },
];

export function subAgentById(id: string): SubAgentDef | undefined {
  return SUBAGENTS.find((s) => s.id === id);
}

/**
 * A roster entry narrowed by the OS per-agent settings (Settings → AI Agents → CLARA → subagent).
 * Tools = roster ∩ CLARA's allowed − CLARA's denied, then ∩ the subagent's own allowed − denied.
 * A subagent with no OS entry inherits CLARA's. Never adds a tool to the roster.
 *
 * The rest of a subagent's OS entry is applied where the run is built (intent.ts run_subagent):
 * status (paused/disabled → not started), model (its own primary/fallback, else CLARA's), limits
 * (max_turns / max_tokens), require_approval, and persona override (appended to its soul file).
 */
export function applySubagentSettings(def: SubAgentDef, snap: AgentSettingsSnapshot): SubAgentDef {
  const sub = settingsFor(snap, def.id);
  let tools = filterToolNames(def.tools, snap.root.tools);
  if (sub !== snap.root) tools = filterToolNames(tools, sub.tools);
  return { ...def, tools };
}
