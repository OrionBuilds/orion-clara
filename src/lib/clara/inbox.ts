// Clara — unified inbox: one triage queue over mail, SMS/calls, approvals, batched notifications,
// and open follow-ups, split Signal/Noise. Aggregates existing stores rather than owning new
// state for any of them — the ledger, approvals queue, and follow-up store all stay authoritative;
// this only adds a thin "have I seen/dismissed this" layer on top (inbox-seen.json), since the
// ledger itself is append-only and has no per-item done/read flag.

import { promises as fs } from "node:fs";
import path from "node:path";
import { loadConfig } from "./config";
import { listUnreadInbox, markRead as gmailMarkRead } from "./ms-mail";
import { classify as classifyMail, classifyComm, type Verdict } from "./triage";
import { readAll as ledgerReadAll } from "./ledger";
import { listPending as listPendingApprovals, approve as approveApproval, reject as rejectApproval, type Approval } from "./approvals";
import { listOpen as listOpenFollowups, resolve as resolveFollowup, type Followup } from "./followups";
import { removeQueued, listQueuedNotifications } from "./notify";
import { fetchFridayApprovals, decideAgentApproval, type AgentApprovalsResult } from "./agentProxy";

export type InboxSource = "mail" | "sms" | "call" | "approval" | "notification" | "followup"
  | "friday-approval";
export type InboxBucket = "signal" | "noise";

export interface InboxItem {
  id: string;               // "<source>:<nativeId>" — nativeId always the real underlying id, so
                             // "done" state survives a reload instead of resurrecting on reorder.
  source: InboxSource;
  ts: string;
  title: string;
  detail?: string;
  bucket: InboxBucket;
  reason: string;
  href?: string;
  actions: Array<"done" | "approve" | "reject">;
}

const MAIL_SIGNAL: Verdict[] = ["vip", "escalate"];

async function seenFile(): Promise<string> {
  const cfg = await loadConfig();
  await fs.mkdir(cfg.dataDir, { recursive: true });
  return path.join(cfg.dataDir, "inbox-seen.json");
}

interface SeenMap { [id: string]: string } // id -> ISO when marked done

async function readSeen(): Promise<SeenMap> {
  try {
    const raw = JSON.parse(await fs.readFile(await seenFile(), "utf8")) as SeenMap;
    // Prune anything older than 30 days so the file doesn't grow forever.
    const cutoff = Date.now() - 30 * 86_400_000;
    const kept: SeenMap = {};
    for (const [id, at] of Object.entries(raw)) if (new Date(at).getTime() >= cutoff) kept[id] = at;
    return kept;
  } catch { return {}; }
}
async function writeSeen(m: SeenMap): Promise<void> {
  await fs.writeFile(await seenFile(), JSON.stringify(m, null, 2), "utf8").catch(() => {});
}

function extractPhone(what: string): string {
  return what.match(/(\+\d{7,15})/)?.[1] ?? "unknown";
}

async function mailItems(seen: SeenMap): Promise<InboxItem[]> {
  const msgs = await listUnreadInbox(30).catch(() => []);
  const items: InboxItem[] = [];
  for (const m of msgs) {
    const id = `mail:${m.id}`;
    if (seen[id]) continue;
    const verdict = await classifyMail(m).catch(() => "escalate" as Verdict);
    items.push({
      id, source: "mail", ts: m.date, title: m.subject || "(no subject)", detail: `${m.from} — ${m.snippet}`,
      bucket: MAIL_SIGNAL.includes(verdict) ? "signal" : "noise", reason: verdict,
      href: "/mail", actions: ["done"],
    });
  }
  return items;
}

async function commItems(seen: SeenMap): Promise<InboxItem[]> {
  const rows = await ledgerReadAll().catch(() => []);
  const items: InboxItem[] = [];
  // "What needs me RIGHT NOW" has a horizon. A text from five days ago is either handled or it is
  // not urgent, and either way it is not the answer to that question — but it stayed in the list
  // forever because nothing ever aged out, which is half of why the count reached 81.
  //
  // Approvals are deliberately NOT aged out (see approvalItems): an old approval is more urgent
  // than a new one, not less.
  const HORIZON_MS = 72 * 60 * 60 * 1000;
  const cutoff = Date.now() - HORIZON_MS;

  // Ledger is append-only and can grow large — only the recent tail is relevant to a triage inbox.
  for (const row of rows.slice(-300)) {
    const at = Date.parse(row.ts);
    if (Number.isFinite(at) && at < cutoff) continue;
    const isInboundSms = row.kind === "sms.sent" && (row.meta as { direction?: string } | undefined)?.direction === "inbound";
    const isInboundCall = row.kind === "call" && (row.meta as { direction?: string } | undefined)?.direction === "inbound";
    if (!isInboundSms && !isInboundCall) continue;
    const id = `${isInboundSms ? "sms" : "call"}:${row.id}`;
    if (seen[id]) continue;
    const from = extractPhone(row.what);
    const { bucket, reason } = await classifyComm(from).catch(() => ({ bucket: "signal" as const, reason: "inbound" }));
    items.push({
      id, source: isInboundSms ? "sms" : "call", ts: row.ts, title: `${isInboundSms ? "SMS" : "Call"} from ${from}`,
      detail: row.what, bucket, reason, href: isInboundSms ? undefined : "/calls", actions: ["done"],
    });
  }
  return items;
}

function approvalItems(approvals: Approval[], seen: SeenMap): InboxItem[] {
  return approvals
    .filter((a) => !seen[`approval:${a.id}`])
    .map((a) => ({
      id: `approval:${a.id}`, source: "approval" as const, ts: a.createdAt,
      title: a.title, detail: a.summary + (a.amountUsd ? ` — $${a.amountUsd}` : ""),
      bucket: "signal" as const, reason: "needs your OK", href: "/approvals",
      actions: ["approve", "reject"] as const,
    }));
}

function followupItems(followups: Followup[], seen: SeenMap): InboxItem[] {
  return followups
    .filter((f) => f.status === "open" && !seen[`followup:${f.id}`])
    .map((f) => ({
      id: `followup:${f.id}`, source: "followup" as const, ts: f.lastNudgeAt ?? f.createdAt,
      title: `Follow-up: ${f.what}`, detail: f.contact.name, bucket: "signal" as const,
      reason: f.nudgeCount > 0 ? `nudged ${f.nudgeCount}x` : "open", actions: ["done"] as const,
    }));
}

// Federated approvals — FRIDAY's pending queue surfaced alongside Clara's own (Wave 3).
// The sibling app's store stays authoritative: these items only mirror what its GET reports, and
// approve/reject proxies back through its real decide spine (see decideApproval below). The item
// id embeds the agent ("friday:<uuid>") so the decide route knows where to send the verdict.
function agentApprovalItems(results: AgentApprovalsResult[], seen: SeenMap): InboxItem[] {
  const items: InboxItem[] = [];
  for (const r of results) {
    for (const a of r.approvals) {
      const id = `${r.agent}:${a.id}`;
      if (seen[id]) continue;
      items.push({
        id, source: `${r.agent}-approval` as InboxSource, ts: a.requestedAt,
        title: a.title, detail: a.detail, bucket: "signal",
        reason: `Approval — ${r.agent.toUpperCase()}${r.fromCache ? " (cached)" : ""}`,
        actions: ["approve", "reject"],
      });
    }
  }
  return items;
}

interface QueuedNotification { id?: string; kind: string; text: string; at: string }
async function notificationItems(seen: SeenMap): Promise<InboxItem[]> {
  // Reads through notify.ts's merged view (shared notify-policy queue first, then any legacy
  // notify-queue.json leftovers) so the ids shown here are the same ids markDone → removeQueued
  // clears from the pending digest.
  let q: QueuedNotification[] = [];
  try { q = await listQueuedNotifications(); } catch { return []; }
  return q
    // Queue items carry a UUID from enqueue; the at:idx fallback only covers pre-UUID entries
    // (positional ids break as soon as the queue mutates, which is why the UUID exists).
    .map((n, i) => ({ ...n, nativeId: n.id ?? `${n.at}:${i}` }))
    .filter((n) => !seen[`notification:${n.nativeId}`])
    .map((n) => ({
      id: `notification:${n.nativeId}`, source: "notification" as const, ts: n.at,
      title: n.kind, detail: n.text, bucket: "noise" as const, reason: "batched (quiet hours or low priority)",
      actions: ["done"] as const,
    }));
}

export interface InboxResult { items: InboxItem[]; counts: { signal: number; noise: number } }

export async function listInbox(): Promise<InboxResult> {
  const seen = await readSeen();
  const [mail, comms, approvals, followups, notifications, agentApprovals] = await Promise.all([
    mailItems(seen),
    commItems(seen),
    listPendingApprovals().then((a) => approvalItems(a, seen)).catch(() => []),
    listOpenFollowups().then((f) => followupItems(f, seen)).catch(() => []),
    notificationItems(seen),
    // agentProxy already degrades to last-good cache / [] internally, but a hard throw here must
    // still not take the whole inbox down.
    Promise.all([fetchFridayApprovals()])
      .then((r) => agentApprovalItems(r, seen)).catch(() => []),
  ]);
  const items = [...mail, ...comms, ...approvals, ...followups, ...notifications, ...agentApprovals]
    .sort((a, b) => b.ts.localeCompare(a.ts));
  return { items, counts: { signal: items.filter((i) => i.bucket === "signal").length, noise: items.filter((i) => i.bucket === "noise").length } };
}

/**
 * Per-source "done" semantics: mail is markRead ONLY (never archived — reversible), approvals
 * aren't done-able here (they resolve via approve/reject), everything else is local seen-state
 * since the ledger and notify queue are append-only with no per-item flag of their own.
 */
export async function markDone(item: InboxItem): Promise<void> {
  if (item.source === "mail") {
    const gmailId = item.id.split(":")[1];
    await gmailMarkRead(gmailId).catch(() => {});
  } else if (item.source === "followup") {
    const followupId = item.id.split(":")[1];
    await resolveFollowup(followupId).catch(() => {});
  } else if (item.source === "notification") {
    // "Done" here means the owner has seen it — drop it from the pending queue too, so it doesn't
    // come back around in the next flushNotifyDigest.
    await removeQueued([item.id.slice("notification:".length)]).catch(() => {});
  }
  const seen = await readSeen();
  seen[item.id] = new Date().toISOString();
  await writeSeen(seen);
}

export async function decideApproval(item: InboxItem, decision: "approve" | "reject"): Promise<void> {
  const approvalId = item.id.slice(item.id.indexOf(":") + 1);
  // Routes through the real approve/reject spine — the inbox is a faster way to reach it, not a
  // parallel path around it. Clara's own approvals hit her local spine (execute + ledger +
  // notify); FRIDAY items are proxied to that app's decide endpoint with its own verb
  // dialect (agentProxy handles the approved/rejected vs approve/reject mismatch).
  if (item.source === "friday-approval") {
    const agent = "friday" as const;
    const res = await decideAgentApproval(agent, approvalId, decision);
    // Failed proxy → throw so the API returns 500 and the optimistically-removed item reappears
    // on the next poll instead of a decision silently vanishing. Don't mark seen either.
    if (!res.ok) throw new Error(`${agent} decide failed (status ${res.status})`);
  } else if (decision === "approve") {
    await approveApproval(approvalId);
  } else {
    await rejectApproval(approvalId);
  }
  const seen = await readSeen();
  seen[item.id] = new Date().toISOString();
  await writeSeen(seen);
}
