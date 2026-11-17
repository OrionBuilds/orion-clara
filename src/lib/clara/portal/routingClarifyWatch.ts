// Routing-clarify watch (2026-09-18) — polls both reply channels (portal comment thread + the
// mirrored clarify email) for a client's answer to "website/app or ad campaigns?", resolves and
// dispatches whichever answers first via triage.ts's dispatchAndAck, and escalates to the owner after
// 24h of silence (no SMS nudge — see routingClarify.ts's file header for why).

import { osClient, osEnabled } from "../osClient";
import { unwrap, rowsOf } from "../osUnwrap";
import { getThread } from "../ms-mail";
import { notifyOwner } from "../notify";
import { add as addTask } from "../tasks";
import { BUSINESS_NAME } from "../owner";
import {
  readAll, upsert, classifyRoutingAnswer, routingClarifyOutcome, routingClarifySilenceAction,
  type RoutingClarify,
} from "./routingClarify";
import { dispatchAndAck } from "./triage";
import type { PortalTicket } from "./classify";

function addrOf(header: string): string {
  return (header.match(/<([^>]+)>/)?.[1] ?? header).trim().toLowerCase();
}

interface CandidateReply { channel: "portal" | "email"; text: string; atMs: number }

function firstReply(portal: CandidateReply | null, email: CandidateReply | null): CandidateReply | null {
  if (!portal) return email;
  if (!email) return portal;
  return email.atMs < portal.atMs ? email : portal;
}

async function checkPortalReply(rec: RoutingClarify): Promise<CandidateReply | null> {
  const raw = await osClient.callTool("project_support_ticket_comments_list", { ticket_id: rec.ticketId }).catch(() => null);
  const thread = rowsOf<{ author_type?: string; is_internal?: boolean; body?: string; created_at?: string }>(unwrap(raw));
  const askedAtMs = Date.parse(rec.askedAt) || 0;
  const candidates = thread
    .filter((c) => c.author_type === "client" && c.is_internal === false)
    .map((c) => ({ text: (c.body ?? "").trim(), atMs: Date.parse(c.created_at ?? "") || 0 }))
    .filter((c) => c.text && c.atMs > askedAtMs)
    .sort((a, b) => a.atMs - b.atMs);
  const first = candidates[0];
  return first ? { channel: "portal", text: first.text, atMs: first.atMs } : null;
}

async function checkEmailReply(rec: RoutingClarify): Promise<CandidateReply | null> {
  if (!rec.emailThreadId || !rec.clientEmail) return null;
  const msgs = await getThread(rec.emailThreadId, "work", { max: 20 }).catch(() => []);
  if (!msgs.length) return null;
  const floorMs = rec.emailSeenMs ?? 0;
  const clientAddr = rec.clientEmail.toLowerCase();
  const candidates = msgs
    .map((m) => ({ ...m, atMs: Date.parse(m.at) || 0 }))
    .filter((m) => m.atMs > floorMs)
    .filter((m) => addrOf(m.from) === clientAddr)
    .sort((a, b) => a.atMs - b.atMs);
  const first = candidates[0];
  return first ? { channel: "email", text: first.text.trim(), atMs: first.atMs } : null;
}

export async function pollRoutingClarifyReplies(): Promise<string> {
  if (!osEnabled()) return "OS bridge off";
  const recs = (await readAll()).filter((r) => r.status === "awaiting_reply");
  let checked = 0;
  let resolved = 0;
  let askedAgain = 0;
  let forcedOwner = 0;

  for (const rec of recs) {
    checked++;
    try {
      // Concurrent — the two channel checks are independent network/tool calls (code-review perf fix).
      const [portalCandidate, emailCandidate] = await Promise.all([checkPortalReply(rec), checkEmailReply(rec)]);
      const winner = firstReply(portalCandidate, emailCandidate);
      if (!winner) continue; // still waiting on both channels

      const qa = [...rec.qa, { question: rec.question, answer: winner.text }];
      const classification = classifyRoutingAnswer(qa);
      const outcome = routingClarifyOutcome(rec.round, classification);
      const now = new Date().toISOString();
      const emailSeenMs = winner.channel === "email" ? winner.atMs : rec.emailSeenMs;

      if (outcome === "ask_again") {
        const nextQuestion = "sorry — just to be sure: is this for your website/app, or for your ad campaigns?";
        await osClient.callTool("project_ticket_comment_create", { ticket_id: rec.ticketId, body: nextQuestion, is_internal: false, author_name: "CLARA" }).catch(() => {});
        // Round 2 also mirrors by email (code-review fix) — round 1 sends both channels (triage.ts),
        // so a client who's been replying by email would otherwise silently stop hearing from CLARA.
        let emailThreadId = rec.emailThreadId;
        if (rec.clientEmail) {
          const { gateOutbound } = await import("../outbound");
          const { sendMail } = await import("../ms-mail");
          const gate = await gateOutbound({ channel: "email", to: rec.clientEmail, kind: "portal.routing_clarify" });
          if (gate.action === "send") {
            const first = (rec.clientName ?? "").split(" ")[0] || "there";
            const res = await sendMail({
              to: rec.clientEmail, subject: `[${rec.subject || "Your ticket"}] Quick question`,
              body: `Hi ${first},\n\n${nextQuestion}\n\nJust reply to this email (or in the client portal) and we'll get this moving.\n\n— Clara, ${BUSINESS_NAME}`,
              threadId: rec.emailThreadId,
            }).catch(() => null);
            if (res?.ok && res.threadId) emailThreadId = res.threadId;
          }
        }
        await upsert({ ...rec, qa, emailSeenMs, emailThreadId, round: 2, question: nextQuestion, askedAt: now, escalatedAt: undefined, updatedAt: now });
        askedAgain++;
        continue;
      }

      const target = outcome === "force_owner" ? "owner" as const : classification as "friday" | "owner";
      // Preserve every field the original ticket carried (2026-09-18 code-review fix) — a synthetic
      // ticket missing contact_id/priority/request_type/service_category/ticket_number silently
      // dropped them from bench intake and owner-facing receipts.
      const t: PortalTicket = {
        id: rec.ticketId, project_id: rec.projectId, subject: rec.subject,
        description: `${rec.description}\n\nClient clarified: ${winner.text}`,
        client_email: rec.clientEmail, client_name: rec.clientName,
        contact_id: rec.contactId, priority: rec.priority,
        request_type: rec.requestType, service_category: rec.serviceCategory,
        ticket_number: rec.ticketNumber,
      };
      const num = rec.ticketNumber ? `#${rec.ticketNumber}` : rec.ticketId.slice(0, 8);
      const reason = outcome === "force_owner" ? "clarify unresolved after 2 rounds" : "client clarified routing";
      try {
        await dispatchAndAck(t, target, rec.subject, reason, num);
      } catch (e) {
        // Same fallback discipline as triage.ts's own failed-dispatch path (code-review fix): a
        // failed hand-off must land a task on the owner's book, not just a notification with nothing to
        // act on if the notify itself is missed/dismissed.
        await addTask({
          title: `Portal ${num} (clarify hand-off failed): ${rec.subject.slice(0, 100)}`,
          detail: `${target.toUpperCase()} dispatch failed after routing clarify: ${String(e).slice(0, 300)}`,
          assignee: "owner", source: `portal:ticket:${rec.ticketId}`, tags: ["portal", "failed-dispatch"],
        }).catch(() => {});
        await notifyOwner({
          kind: "portal.ticket.failed", priority: "normal", dedupeKey: `portal:fail:${rec.ticketId}`,
          text: `🎫 Couldn't hand clarified ticket ${num} to ${target.toUpperCase()} — ${String(e).slice(0, 120)}. It's on your book.`,
        }).catch(() => {});
      }
      await upsert({ ...rec, qa, emailSeenMs, status: "resolved", updatedAt: now });
      if (outcome === "force_owner") forcedOwner++; else resolved++;
    } catch (e) {
      console.error(`[routing-clarify-watch] error on ${rec.ticketId}: ${String(e).slice(0, 200)}`);
    }
  }
  return `${checked} checked, ${resolved} resolved, ${askedAgain} asked again, ${forcedOwner} forced to the owner`;
}

export async function routingClarifySilenceSweep(): Promise<string> {
  const recs = (await readAll()).filter((r) => r.status === "awaiting_reply");
  let escalated = 0;
  for (const rec of recs) {
    const askedAtMs = Date.parse(rec.askedAt) || 0;
    if (!askedAtMs) continue;
    const action = routingClarifySilenceAction(askedAtMs, Date.now(), rec.escalatedAt ? Date.parse(rec.escalatedAt) || 0 : null);
    if (action !== "escalate") continue;
    await notifyOwner({
      kind: "portal.routing_clarify.stale", priority: "normal", dedupeKey: `routing-clarify-stale:${rec.id}`,
      text: `⏳ No answer on the routing question for ticket ${rec.ticketId.slice(0, 8)} ("${rec.subject}") after a day — might be worth a direct follow-up.`,
    }).catch(() => {});
    await upsert({ ...rec, escalatedAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    escalated++;
  }
  return `${escalated} escalated`;
}
