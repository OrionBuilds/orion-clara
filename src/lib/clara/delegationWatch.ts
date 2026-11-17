// Delegation watcher — closes the loop on every hand-off in delegations.json.
//
// Every 2 minutes: poll each open delegation's bench, fold the answer through applyTransition, and
// announce the ONE transition it returns: a finished job becomes a client update (email in the
// original thread, or a client-visible comment + "resolved" on a portal ticket) and a note to the owner;
// parked / failed / stale go to the owner only — a client never hears "it's stuck". Client sends pass
// through the outbound governor like every other autonomous send.

import { loadConfig } from "./config";
import { listOpen, upsert, prune, applyTransition, type Delegation } from "./delegations";
import { fridayState, completionMessage, type BenchRun, type BenchState } from "./delegationStatus";
import { sendMail } from "./ms-mail";
import { gateOutbound, recordSent } from "./outbound";
import { notifyOwner } from "./notify";
import { append as ledgerAppend } from "./ledger";
import { osClient, osEnabled } from "./osClient";
import { OWNER_FIRST, BUSINESS_NAME } from "./owner";
import { interagentAuthHeaders } from "@autom8ionlab/agent-core";
import { appendMessage } from "./messages";
import { sendSMS } from "./channels";

export function delegationWatchEnabled(): boolean {
  return (process.env.CLARA_DELEGATION_WATCH ?? "on").trim().toLowerCase() !== "off";
}

const TIMEOUT_MS = 8_000;

async function getJson(url: string): Promise<unknown> {
  const r = await fetch(url, { headers: { ...interagentAuthHeaders() }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!r.ok) throw new Error(`${new URL(url).pathname} → ${r.status}`);
  return r.json();
}

function runsFrom(j: unknown): BenchRun[] {
  const o = j as { runs?: unknown; data?: { runs?: unknown } } | unknown[] | null;
  const arr = Array.isArray(o) ? o : (o as { runs?: unknown })?.runs ?? (o as { data?: { runs?: unknown } })?.data?.runs;
  return Array.isArray(arr) ? (arr as BenchRun[]) : [];
}


/** Poll the bench for one delegation; aggregates across its task ids (worst state wins). */
export async function pollBench(row: Delegation): Promise<{ state: BenchState; clientText?: string; internal?: string }> {
  const cfg = await loadConfig();
  const states: Array<{ state: BenchState; clientText?: string; internal?: string }> = [];
  for (const id of row.benchTaskIds) {
    const j = await getJson(`${cfg.fridayBaseUrl.replace(/\/$/, "")}/api/friday/runs?taskId=${encodeURIComponent(id)}`).catch(() => null);
    states.push(fridayState(runsFrom(j)));
  }
  if (!states.length) return { state: "pending" };
  const pick = (s: BenchState) => states.find((x) => x.state === s);
  return pick("failed") ?? pick("parked") ?? (states.every((x) => x.state === "done") ? { state: "done", clientText: states.map((x) => x.clientText).filter(Boolean).join("\n\n") || undefined, internal: states[0].internal } : { state: "pending" });
}

/**
 * Receipts (2026-09-24): when the owner personally handed the work over, the result goes back on the
 * channel they used — a text to their phone, a reply in the email thread, or a line in the chat thread
 * (plus the brief). Every outcome is also written to messages.jsonl so delegation_status and the
 * cross-channel history can cite it. Never throws.
 */
export async function tellOwner(row: Delegation, outcome: "done" | "parked" | "failed" | "stale", text: string): Promise<string> {
  const bench = row.bench.toUpperCase();
  const line = `${bench} on "${row.summary}": ${text}`.slice(0, 1500);
  const channel = row.replyTo?.channel ?? "chat";
  const stored = channel === "voice" ? "web" : channel;
  await appendMessage("clara", line, undefined, { channel: stored as "sms" | "web" | "email", from: row.replyTo?.from, principal: true }, { kind: "turn" }).catch(() => {});
  if (row.askedBy !== "owner") return "recorded";
  try {
    if (channel === "sms" && row.replyTo?.from) {
      const r = await sendSMS(row.replyTo.from, line);
      return r.ok ? "texted the owner" : `owner text failed: ${r.error ?? "unknown"}`;
    }
    if (channel === "email" && row.replyTo?.from) {
      const subject = row.source.subject ? (/^re:/i.test(row.source.subject) ? row.source.subject : `Re: ${row.source.subject}`) : `Re: ${row.summary.slice(0, 70)}`;
      const r = await sendMail({ to: row.replyTo.from, subject, body: line, threadId: row.source.threadId, inReplyTo: row.source.messageId, references: row.source.messageId });
      return r.ok ? "emailed the owner" : `owner email failed: ${r.error ?? "unknown"}`;
    }
  } catch (e) {
    return `owner reply failed: ${String(e).slice(0, 120)}`;
  }
  // chat / voice: the thread line above is what they see next time they open the desk; the brief
  // still carries it via notifyOwner (normal) from the caller.
  return outcome === "done" ? "posted to the chat thread" : "posted to the chat thread";
}

async function tellClient(row: Delegation, clientText: string | undefined): Promise<string> {
  const cfg = await loadConfig();
  const name = row.client?.name ?? "there";
  const body = completionMessage(name, row.summary, clientText, OWNER_FIRST, BUSINESS_NAME);
  if (row.source.kind === "ticket" && row.source.ticketId && osEnabled()) {
    await osClient.callTool("project_ticket_comment_create", { ticket_id: row.source.ticketId, body, is_internal: false, author_name: "CLARA" });
    await osClient.callTool("project_support_tickets_update", { id: row.source.ticketId, status: "resolved", actor_name: "CLARA" }).catch(() => {});
    return "ticket comment + resolved";
  }
  if (row.client?.email) {
    const meta = { channel: "email" as const, to: row.client.email, kind: "client.update" };
    const gate = await gateOutbound(meta);
    if (gate.action !== "send") return `client email ${gate.action}: ${"reason" in gate ? gate.reason : ""}`;
    const subject = row.source.subject ? (/^re:/i.test(row.source.subject) ? row.source.subject : `Re: ${row.source.subject}`) : `Update: ${row.summary.slice(0, 60)}`;
    const r = await sendMail({
      to: row.client.email, cc: cfg.principals.owner.emails[0], subject, body,
      threadId: row.source.threadId, inReplyTo: row.source.messageId, references: row.source.messageId,
      headers: { "X-Clara-Origin": "client-update" },
    }, "work");
    if (!r.ok) throw new Error(r.error ?? "send failed");
    await recordSent(meta);
    return "client emailed";
  }
  return "no client channel";
}

export async function runDelegationWatch(log: (m: string) => void = (m) => console.log(`[delegation-watch] ${m}`)): Promise<string> {
  if (!delegationWatchEnabled()) return "delegation watch off";
  const open = await listOpen();
  let polled = 0, announced = 0, errors = 0;
  for (const row of open) {
    let state: Awaited<ReturnType<typeof pollBench>>;
    try { state = await pollBench(row); polled++; }
    catch (e) { errors++; log(`poll failed for ${row.id.slice(0, 8)} (${row.bench}): ${String(e).slice(0, 120)}`); continue; }
    const { row: next, notify } = applyTransition(row, state.state);
    await upsert(next);
    if (!notify) continue;
    announced++;
    const bench = row.bench.toUpperCase();
    const who = row.client?.name ? ` for ${row.client.name}` : "";
    try {
      const ownerAsked = row.askedBy === "owner";
      if (notify === "done") {
        let delivered = "no client";
        if (row.client && !ownerAsked) delivered = await tellClient(next, state.clientText).catch((e) => `client update FAILED: ${String(e).slice(0, 120)}`);
        const result = state.clientText?.trim() || state.internal?.trim() || "finished";
        const ownerLine = await tellOwner(next, "done", `done. ${result}`.slice(0, 1200));
        if (ownerAsked) delivered = ownerLine;
        await notifyOwner({ kind: "delegation.done", priority: "normal", dedupeKey: `deleg:done:${row.id}`,
          text: `${bench} finished "${row.summary}"${who} — ${delivered}${state.clientText || ownerAsked ? "" : " (no client summary block; sent the generic completion note)"}.` }).catch(() => {});
      } else if (notify === "parked") {
        await tellOwner(next, "parked", `parked for approval — ${state.internal ?? "see her board"}.`);
        await notifyOwner({ kind: "delegation.parked", priority: "normal", dedupeKey: `deleg:parked:${row.id}`,
          text: `${bench} parked "${row.summary}"${who} for approval — ${state.internal ?? "see her board"}.${ownerAsked ? "" : " The client hasn't been told."}` }).catch(() => {});
      } else if (notify === "failed") {
        await tellOwner(next, "failed", `failed — ${state.internal ?? "no detail"}.`);
        await notifyOwner({ kind: "delegation.failed", priority: "normal", dedupeKey: `deleg:failed:${row.id}`,
          text: `${bench} failed "${row.summary}"${who} — ${state.internal ?? "no detail"}.${ownerAsked ? "" : " The client hasn't been told;"} Needs a human.` }).catch(() => {});
      } else if (notify === "stale") {
        await tellOwner(next, "stale", "never returned a task id (6h) — nothing may be queued.");
        await notifyOwner({ kind: "delegation.stale", priority: "low", dedupeKey: `deleg:stale:${row.id}`,
          text: `${bench} never returned a task id for "${row.summary}"${who} (6h) — nothing may be queued. Re-send or handle it yourself.` }).catch(() => {});
      }
      if (row.source.kind === "ticket" && row.source.ticketId && notify !== "done" && osEnabled()) {
        await osClient.callTool("project_ticket_comment_create", { ticket_id: row.source.ticketId, body: `CLARA: ${bench} reports ${notify} — ${state.internal ?? "no detail"}.`, is_internal: true, author_name: "CLARA" }).catch(() => {});
      }
      try {
        const { recordOutcome, delegationTransitionOutcome } = await import("./vaultMemory");
        await recordOutcome(delegationTransitionOutcome(row, notify, state));
      } catch { /* memory is best-effort; the ledger entry below must still be written */ }
      await ledgerAppend({ kind: "action", actor: "clara", what: `delegation ${row.id.slice(0, 8)} → ${notify} (${bench}, ${row.source.kind})`, meta: { delegationId: row.id, bench: row.bench, transition: notify } }).catch(() => {});
    } catch (e) {
      errors++;
      log(`announce failed for ${row.id.slice(0, 8)}: ${String(e).slice(0, 120)}`);
    }
  }
  const pruned = await prune().catch(() => 0);
  const summary = `open ${open.length}, polled ${polled}, announced ${announced}, errors ${errors}${pruned ? `, pruned ${pruned}` : ""}`;
  log(summary);
  return summary;
}
