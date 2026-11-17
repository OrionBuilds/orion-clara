// Clara — approvals queue.
//
// Anything Clara drafts but can't ship autonomously lands here as a structured intent.
// The owner reviews at /approvals and taps approve or reject. Approved intents are dispatched
// to their handler; rejected intents are archived with the reason.
//
// Every intent is a discriminated union keyed by `kind` so the executor can pattern-match.
// New kinds: add a case in `execute()` below and a card in the /approvals UI.

import { promises as fs } from "node:fs";
import path from "node:path";
import { loadConfig } from "./config";
import type { PrincipalId } from "./types";
import { append as ledgerAppend } from "./ledger";
import { notifyOwner } from "./notify";

// 4-char suffix-of-id — same technique as FRIDAY's risk.ts shortCode(). Since the plain-language
// decisions rail (2026-09-24) codes are INTERNAL: dashboards, logs and the hidden reply-compat
// parser only. The owner is never shown one.
export function shortCode(id: string): string {
  return id.replace(/-/g, "").slice(-4).toUpperCase();
}

export type ApprovalKind =
  | "vendor.quote-req"   // reach out to N vendors for quotes
  | "email.send"         // sensitive/VIP-adjacent draft that shouldn't auto-send
  | "call.business"      // outbound call to an external business to inquire/book — needs the owner's OK
  | "drive.modify"       // edit an existing Drive file — creating new files needs no approval
  | "drive.trash"        // move a Drive file to trash (never a permanent delete)
  | "intent.tool"        // an intent-router tool call held for confirmation — runs on approve
  | "scope.out-of-bounds" // Autonomy Spec v0.1 item #8 — client asked for work outside the contract
  | "generic";

/**
 * Payload for `scope.out-of-bounds` (Autonomy Spec v0.1, item #8). Unlike every other kind, the
 * decision here isn't the owner tapping approve/reject — it's the CLIENT replying to a 3-option text
 * ([book a call] / [do it anyway] / [decline]), or the SLA timer defaulting to "call" on silence.
 * `decision` starts unset and is filled in by scopeEscalation.ts's resolve function right before
 * calling approve(), which is what execute() below actually branches on.
 */
export interface ScopeOutOfBoundsPayload {
  clientContact: string;  // phone (E.164) or email the client replied from
  requestText: string;    // what the client actually asked for, in their own words
  contractId?: string;
  decision?: "call" | "anyway" | "decline";
}

/**
 * Payload for `intent.tool`: the exact tool and arguments the router wanted to run.
 *
 * Stored rather than re-derived so that approving executes what was SHOWN on the approval card,
 * not whatever a second pass through the model would decide now. A confirmation that can drift
 * between the asking and the doing is not a confirmation.
 */
export interface IntentToolPayload {
  tool: string;
  args: Record<string, unknown>;
  principal: PrincipalId;
  source: "sms" | "chat" | "voice";
}

export type ApprovalStatus = "pending" | "approved" | "rejected" | "cancelled";

export interface Approval {
  id: string;
  kind: ApprovalKind;
  title: string;
  summary: string;
  amountUsd?: number;
  requestor: "owner" | "clara";
  // Where the CONTENT behind this approval came from, distinct from who requested it — a trip
  // The owner asked for is still origin:"owner" even though Clara did the drafting. "external" is for
  // approvals whose content was authored by someone outside the business (a vendor's reply, an
  // OCR'd document, a research summary) with no human in the loop before the draft was created —
  // surfaced to the owner so they know an approval wasn't purely their own words driving it.
  origin?: "owner" | "external";
  createdAt: string;
  status: ApprovalStatus;
  decidedAt?: string;
  decisionNote?: string;
  intent: unknown;              // opaque payload consumed by execute()
  result?: { ok: boolean; error?: string; ref?: string; knowledgeRefreshed?: boolean };
  // Autonomy Spec v0.1, item #5: set by whatever drafts an approval when a client is actively
  // on the other end of it (mid-call, mid-SMS-thread) — the SLA nudge treats this as urgent
  // (30min) regardless of business hours, distinct from the business-hours(2h) default.
  clientWaiting?: boolean;
}

async function file(): Promise<string> {
  const cfg = await loadConfig();
  const dir = path.join(cfg.vaultRoot, "approvals");
  await fs.mkdir(dir, { recursive: true });
  return path.join(dir, "queue.json");
}

async function load(): Promise<Approval[]> {
  try { return JSON.parse(await fs.readFile(await file(), "utf8")) as Approval[]; }
  catch { return []; }
}
async function save(rows: Approval[]): Promise<void> {
  await fs.writeFile(await file(), JSON.stringify(rows, null, 2), "utf8");
}

export async function draft(input: Omit<Approval, "id" | "createdAt" | "status">): Promise<Approval> {
  const rows = await load();
  const row: Approval = {
    ...input,
    // Default origin to the requestor (the owner's own ask) unless a caller explicitly marks
    // this as driven by content from outside the business (origin: "external").
    origin: input.origin ?? (input.requestor === "clara" ? "owner" : input.requestor),
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    status: "pending",
  };
  rows.push(row);
  await save(rows);

  // Wave 3: mirror into the orion hub the moment the row is persisted (best-effort fire-and-
  // forget — a hub outage never blocks queueing). Dynamic import keeps the bridge off the module
  // graph for callers that never touch the OS; the bridge itself no-ops when CLARA_OS_BRIDGE=off
  // or the clara@ agent identity isn't signed in.
  void import("./osApprovalsBridge").then((b) => b.mirrorApproval(row)).catch(() => {});

  await ledgerAppend({
    kind: "action",
    actor: input.requestor === "owner" ? "clara" : input.requestor,
    what: `queued for approval: ${row.title}`,
    ref: row.id,
    meta: { kind: row.kind, amountUsd: row.amountUsd },
  });

  // Queue-time ask (owner-comms overhaul, 2026-09-24). Only a business call still pages at once —
  // an outbound call about to happen on the owner's behalf to an outside party is genuinely
  // time-sensitive. Every other kind waits for the plain-language decisions rail: the 08:00 brief,
  // the 08:30 call, or decision-ask's same-day text for money/scope items (decisions.ts). The ask
  // is a plain-English question they answer in words; there is no code anywhere in it.
  if (row.kind === "call.business") {
    const { phraseDecision, renderAsk, markAsked, decisionIdFor } = await import("./decisions");
    const d = phraseDecision("clara", row);
    const externalFlag = row.origin === "external" ? " Heads up: this one was triggered by outside content." : "";
    const sms = `${renderAsk(d, "sms")}${externalFlag}`.slice(0, 600);
    const sent = await notifyOwner({
      kind: "approval",
      priority: "critical",
      call: true,
      text: sms,
      callText: `${renderAsk(d, "voice")}${externalFlag} Reply to the text with yes or no.`,
      dedupeKey: `approval:${row.id}`,
    }).catch(() => null);
    if (sent?.sms) await markAsked(decisionIdFor("clara", row.id), "sms", undefined, { question: row.title }).catch(() => {});
  }

  return row;
}

export async function listPending(): Promise<Approval[]> {
  return (await load()).filter((r) => r.status === "pending");
}
export async function listAll(): Promise<Approval[]> {
  return load();
}
export async function get(id: string): Promise<Approval | null> {
  return (await load()).find((r) => r.id === id) ?? null;
}

// Autonomy Spec v0.1, item #8: scope.out-of-bounds is resolved by a CLIENT's reply (or the SLA
// timeout default), not the owner tapping approve — so the decision has to be written onto the stored
// row BEFORE approve() runs, since approve() reads its own fresh copy from disk and executes
// exactly what's there. Kept narrow (this one field, this one kind) rather than a general patch
// function — nothing else needs mutable intent payloads today.
export async function setScopeDecision(id: string, decision: "call" | "anyway" | "decline"): Promise<Approval | null> {
  const rows = await load();
  const row = rows.find((r) => r.id === id);
  if (!row || row.status !== "pending" || row.kind !== "scope.out-of-bounds") return null;
  (row.intent as ScopeOutOfBoundsPayload).decision = decision;
  await save(rows);
  return row;
}

/** Decision provenance ("owner via clara/sms") + the free-text note, as one stored string. */
function decisionNoteFor(note?: string, by?: string): string | undefined {
  if (by && note) return `${by} — ${note}`;
  return by ?? note;
}

export async function reject(id: string, note?: string, by?: string): Promise<Approval | null> {
  const rows = await load();
  const row = rows.find((r) => r.id === id);
  if (!row || row.status !== "pending") return row ?? null;
  row.status = "rejected";
  row.decidedAt = new Date().toISOString();
  row.decisionNote = decisionNoteFor(note, by);
  await save(rows);

  // Wave 3: local decision landed first → supersede the hub mirror row (best-effort).
  void import("./osApprovalsBridge").then((b) => b.closeApproval(id, "rejected")).catch(() => {});

  await ledgerAppend({ kind: "action", actor: "owner", what: `rejected: ${row.title}${note ? ` — ${note}` : ""}${by ? ` (${by})` : ""}`, ref: row.id });
  return row;
}

// Approve + dispatch. Handlers live in this module — imports are deferred to keep the graph clean.
export async function approve(id: string, note?: string, by?: string): Promise<Approval | null> {
  const rows = await load();
  const row = rows.find((r) => r.id === id);
  if (!row || row.status !== "pending") return row ?? null;
  row.status = "approved";
  row.decidedAt = new Date().toISOString();
  row.decisionNote = decisionNoteFor(note, by);
  await save(rows);

  // Wave 3: local decision landed first → supersede the hub mirror row (best-effort). Fired on
  // the state TRANSITION, before execute() — the local outcome is "approved" regardless of
  // whether dispatch later succeeds (that result lives on row.result, not row.status).
  void import("./osApprovalsBridge").then((b) => b.closeApproval(id, "approved")).catch(() => {});

  try {
    row.result = await execute(row);
  } catch (e) {
    row.result = { ok: false, error: (e as Error).message };
  }
  await save(rows);

  await ledgerAppend({
    kind: "action",
    actor: "owner",
    what: `approved: ${row.title} → ${row.result?.ok ? "OK" : "FAILED"}${by ? ` (${by})` : ""}`,
    ref: row.id,
    meta: row.result,
  });
  return row;
}

async function execute(row: Approval): Promise<{ ok: boolean; error?: string; ref?: string }> {
  switch (row.kind) {
    case "vendor.quote-req": {
      const { sendQuoteRequests } = await import("./vendors");
      return sendQuoteRequests(row);
    }
    case "email.send": {
      const { sendApprovedEmail } = await import("./mail-send");
      return sendApprovedEmail(row);
    }
    case "call.business": {
      const { placeApprovedBusinessCall } = await import("./business-calls");
      return placeApprovedBusinessCall(row);
    }
    case "scope.out-of-bounds": {
      const { executeScopeDecision } = await import("./scopeEscalation");
      return executeScopeDecision(row);
    }
    case "drive.modify": {
      const { applyApprovedDriveEdit } = await import("./ms-files");
      return applyApprovedDriveEdit(row);
    }
    case "drive.trash": {
      const { applyApprovedDriveTrash } = await import("./ms-files");
      return applyApprovedDriveTrash(row);
    }
    case "intent.tool": {
      // Runs the held tool for real. Without this branch an intent-router confirmation would land
      // in `generic` below, report ok, and do nothing — a confirmation prompt that quietly
      // discards the thing you confirmed, which is the same class of defect as a sweep that
      // reports success without sweeping.
      const p = row.intent as IntentToolPayload | undefined;
      if (!p?.tool) return { ok: false, error: "approval carried no tool payload" };
      const { TOOLS } = await import("./intent");
      const def = TOOLS.find((t) => t.name === p.tool);
      if (!def) return { ok: false, error: `no such tool: ${p.tool}` };
      try {
        const out = await def.run(p.args ?? {}, { principal: p.principal, source: p.source });
        return out.ok ? { ok: true, ref: out.line } : { ok: false, error: out.line };
      } catch (e) {
        return { ok: false, error: String(e).slice(0, 200) };
      }
    }
    case "generic":
      return { ok: true };
  }
}
