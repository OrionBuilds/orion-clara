// Clara <-> orion approvals bridge (Wave 3). Clara's LOCAL approvals queue (approvals.ts)
// stays authoritative; this module mirrors pending approvals into the OS hub
// (workflow_approval_queue, source='agent_approval') so the owner sees one queue + realtime badge,
// supersedes the hub row when a decision lands locally first (SMS / /approvals UI), and pulls
// hub decisions back on the scheduler's minute tick. Hub decisions apply ONLY through the local
// decide spine — approve()/reject() in approvals.ts, both CAS-guarded on status === "pending" —
// so the four decide channels (SMS, /approvals UI, CLARA proxy, hub) can race safely: whoever
// transitions the row first wins, everyone else no-ops.
//
// Identity: the owner's owner account, by their explicit direction (2026-07-30, "clara signs in as me").
// The mirror tools carry agent_slug explicitly ('clara'), so hub attribution is unaffected; RLS
// authorizes via org membership, which the owner session satisfies.
//
// Every hub call is best-effort: an OS outage can never block or break local approvals. Kill
// switch CLARA_OS_BRIDGE=off; also silently inactive when the OS session isn't signed in.

import { osClient as osAgentClient, osEnabled as osAgentEnabled } from "./osClient";
import { approve, reject, get, listPending, type Approval } from "./approvals";

const AGENT_SLUG = "clara";
const HUB_NOTE = "decided via orion hub";

type Log = (m: string, e?: unknown) => void;

export function bridgeMode(): "on" | "off" {
  return (process.env.CLARA_OS_BRIDGE ?? "on").trim().toLowerCase() === "off" ? "off" : "on";
}

let warnedNotSignedIn = false;
function active(log?: Log): boolean {
  if (bridgeMode() === "off") return false;
  if (!osAgentEnabled()) {
    if (log && !warnedNotSignedIn) {
      log("os-approvals: agent identity (clara@) not signed in — visit /os/auth/agent to complete the one-time sign-in (docs/os-agent-auth.md); bridge inactive until then");
      warnedNotSignedIn = true;
    }
    return false;
  }
  return true;
}

// OsMcpClient.callTool returns the raw MCP content array; hub tools serialize their payload as
// JSON in the first text block. Same helper as osTasks.ts.
function unwrap(content: unknown): unknown {
  if (Array.isArray(content)) {
    const first = content.find((c) => c && typeof c === "object" && "text" in (c as object));
    if (first && typeof (first as { text?: unknown }).text === "string") {
      try { return JSON.parse((first as { text: string }).text); } catch { return (first as { text: string }).text; }
    }
  }
  return content;
}

type HubStatus = "approved" | "rejected" | "expired";
function isHubStatus(v: unknown): v is HubStatus {
  return v === "approved" || v === "rejected" || v === "expired";
}

interface HubDecisionRow {
  id: string;
  external_ref: string | null;
  status: string;
  resolution_note?: string | null;
}

// Re-entrancy guard: refs currently being decided FROM a hub decision. approve()/reject() fire
// closeApproval() on every successful transition; when the transition itself came from the hub,
// closing would only round-trip a superseded:false answer — skip it.
const applyingFromHub = new Set<string>();

/** Mirror a freshly-queued (or back-mirrored) pending approval into the hub. Idempotent on
 *  (agent_slug, external_ref) server-side — re-mirroring returns the existing row and sends no
 *  duplicate notification. Best-effort: failures are swallowed, the local queue is authoritative. */
export async function mirrorApproval(approval: Approval): Promise<void> {
  if (!active()) return;
  if (approval.status !== "pending") return;
  try {
    await osAgentClient.callTool("agent_approval_mirror", {
      agent_slug: AGENT_SLUG,
      external_ref: approval.id,
      title: approval.title,
      description: approval.summary ? approval.summary.slice(0, 500) : undefined,
      risk: approval.kind === "call.business" ? "high" : "medium",
      action_type: approval.kind,
      facts: { kind: approval.kind, requestor: approval.requestor },
    });
  } catch { /* best-effort */ }
}

/** A decision happened locally first — supersede the still-pending hub mirror row. If the hub
 *  answers superseded:false with a decided row, the hub decided first: apply that decision
 *  through the local spine (a no-op if the local row is already decided — CAS). */
export async function closeApproval(id: string, outcome: string): Promise<void> {
  if (!active()) return;
  if (applyingFromHub.has(id)) return;
  try {
    const res = unwrap(await osAgentClient.callTool("agent_approval_close", {
      agent_slug: AGENT_SLUG,
      external_ref: id,
      outcome,
    })) as { superseded?: boolean; approval?: { status?: unknown; resolution_note?: string | null } | null } | null;
    if (res && res.superseded === false && res.approval && isHubStatus(res.approval.status)) {
      // Hub decided first. Apply locally; the still-unacked hub row is acked by the next pull tick.
      await applyHubDecision({ external_ref: id, status: res.approval.status, resolution_note: res.approval.resolution_note });
    }
  } catch { /* best-effort */ }
}

// Apply one hub decision through the local spine. approve()/reject() only act on rows still
// "pending", so a decision that already happened locally (or a duplicate pull) is a clean no-op.
// Hub "expired" auto-rejects ONLY a locally-still-pending row — a local decision beat the expiry.
async function applyHubDecision(
  row: { external_ref: string; status: HubStatus; resolution_note?: string | null },
  log?: Log,
): Promise<void> {
  const ref = row.external_ref;
  const note = row.resolution_note ? `${HUB_NOTE} — ${row.resolution_note}` : HUB_NOTE;
  applyingFromHub.add(ref);
  try {
    if (row.status === "approved") {
      const local = await approve(ref, note);
      if (local?.status === "approved" && local.decisionNote === note) log?.(`os-approvals: hub approval applied for "${local.title}" (${ref})`);
      return;
    }
    if (row.status === "rejected") {
      const local = await reject(ref, note);
      if (local?.status === "rejected" && local.decisionNote === note) log?.(`os-approvals: hub rejection applied for "${local.title}" (${ref})`);
      return;
    }
    // expired
    const local = await get(ref);
    if (local?.status === "pending") {
      await reject(ref, "expired in orion hub — auto-rejected");
      log?.(`os-approvals: hub expiry applied for "${local.title}" (${ref})`);
    }
  } finally {
    applyingFromHub.delete(ref);
  }
}

// Startup back-mirror flag: on the first tick after boot, (re-)mirror every currently-pending
// local approval so rows queued while the bridge was down (or before it existed) reach the hub.
let backMirrored = false;

/** One scheduler tick: back-mirror (first tick only) → pull hub decisions → apply through the
 *  local spine → ack. Ack covers ALL pulled ids — apply is CAS-idempotent, and an ack failure
 *  just re-pulls the same rows next minute. */
export async function runOsApprovalsPoll(log?: Log): Promise<{ pulled: number; acked: number } | null> {
  if (!active(log)) return null;

  if (!backMirrored) {
    try {
      const pending = await listPending();
      for (const row of pending) await mirrorApproval(row);
      backMirrored = true;
      if (pending.length) log?.(`os-approvals: back-mirrored ${pending.length} pending approval(s)`);
    } catch (e) {
      log?.("os-approvals: back-mirror failed (will retry next tick)", e);
    }
  }

  let rows: HubDecisionRow[] = [];
  try {
    const raw = unwrap(await osAgentClient.callTool("agent_approval_pull_decisions", { agent_slug: AGENT_SLUG, limit: 50 }));
    if (Array.isArray(raw)) rows = raw as HubDecisionRow[];
  } catch (e) {
    log?.("os-approvals: pull failed", e);
    return null;
  }
  if (rows.length === 0) return { pulled: 0, acked: 0 };

  const ackIds: string[] = [];
  for (const row of rows) {
    if (!row?.id) continue;
    ackIds.push(row.id);
    if (!row.external_ref || !isHubStatus(row.status)) continue;
    try {
      await applyHubDecision({ external_ref: row.external_ref, status: row.status, resolution_note: row.resolution_note }, log);
    } catch (e) {
      log?.(`os-approvals: apply failed for ${row.external_ref} (${row.status})`, e);
    }
  }

  let acked = 0;
  if (ackIds.length > 0) {
    try {
      const res = unwrap(await osAgentClient.callTool("agent_approval_ack", { ids: ackIds })) as { acked_count?: number } | null;
      acked = res?.acked_count ?? ackIds.length;
    } catch (e) {
      log?.("os-approvals: ack failed (rows re-pull next tick; re-apply is a CAS no-op)", e);
    }
  }
  log?.(`os-approvals: pulled=${rows.length} acked=${acked}`);
  return { pulled: rows.length, acked };
}
