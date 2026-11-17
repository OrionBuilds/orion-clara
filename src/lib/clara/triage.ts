// Clara — email triage rules.
//
// Every unread inbox message flows through this classifier. Per plan:
//   VIP → escalate to the owner (star + label "Clara/For<FirstName>")
//   Newsletter / promo → archive silently (label "Clara/AutoArchived")
//   Routine (scheduling / confirm / ack) → auto-reply if we're confident, else escalate
//   Rest → escalate to the owner
//
// Actions are logged to the ledger. Auto-replies are drafted, not sent, until W3 wires them.

import { listUnreadInbox, archive, star, ensureLabel, addLabel, markRead, fetchMessageFull, sendMail, type GmailMessage } from "./ms-mail";
import { append as ledgerAppend } from "./ledger";
import { loadConfig } from "./config";
import { resolveByPhone } from "./principals";
import { promises as fs } from "node:fs";
import path from "node:path";
import { OWNER_FIRST, BUSINESS_DOMAIN } from "./owner";
import { appendMessage, recentMessagesFor } from "./messages";

export type Verdict = "vip" | "newsletter" | "routine" | "escalate";

export interface Classification {
  msg: GmailMessage;
  verdict: Verdict;
  // Autonomy Spec v0.1, item #7: "auto-reply-drafted" used to be a value here, then got removed
  // because nothing ever drafted OR sent a reply — the branch just labeled the message and
  // stopped, and naming a draft that doesn't exist is the same class of lie as reporting a sweep
  // that never ran. "auto-replied" is real now (composeRoutineReply + a genuine sendMail call
  // below), and only gets used once the send has actually succeeded — on failure this still falls
  // back to "labeled-for-reply", exactly the old, honest behavior.
  action: "starred+labeled" | "archived" | "labeled-for-reply" | "auto-replied" | "escalated";
  reason: string;
}

const NEWSLETTER_RX = /noreply|no-reply|do-not-reply|newsletter|marketing|updates|notifications?@|unsubscribe/i;

// The owner's own agents mailing the owner their status. FRIDAY alone sends a "scanned N tickets, claiming
// none" every poll, and because `escalate` is the DEFAULT verdict all of it counted as needing the owner:
// the unified inbox reported "78 things need you, 6 noise" when the true ratio was the other way
// round. An alert channel that cries wolf 78 times is not an alert channel.
//
// The exception matters more than the rule: an agent asking for an APPROVAL genuinely does need
// the owner, and those must stay escalate. Anything matching the routine-report shape is operational
// chatter; anything asking for a decision is not.
// Matching on the SUBJECT, not the sender: the agents send their status mail from
// the owner's work address (they relay through the owner's Gmail), so a sender rule catches almost none of it.
// The subject shape "FRIDAY: …" / "[CLARA] …" is what actually identifies them.
const AGENT_SUBJECT_RX = /^\s*\[?(friday|clara)\]?\s*[:\-—]/i;
const AGENT_SENDER_RX = new RegExp(`^(friday|clara)@${BUSINESS_DOMAIN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i");
const AGENT_NEEDS_OWNER_RX = /approval|approve|needs your ok|action required|sign.?off|blocked|failed|error|escalat/i;
const ROUTINE_RX = /reschedule|schedule|confirm|reminder|meeting request|calendar invite|available (this|next) (week|month)|would (a )?(morning|afternoon) work|calendly/i;

async function loadVipList(): Promise<{ vip: string[] }> {
  const cfg = await loadConfig();
  const p = path.join(cfg.vaultRoot, "preferences", "vips.json");
  try {
    const raw = JSON.parse(await fs.readFile(p, "utf8")) as { vip?: string[] };
    return { vip: raw.vip ?? [] };
  } catch {
    // Business-only: a VIP-client list only.
    const seed: { vip: string[] } = { vip: [] };
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, JSON.stringify(seed, null, 2), "utf8");
    return seed;
  }
}

function fromAddress(header: string): string {
  const m = header.match(/<([^>]+)>/);
  return (m ? m[1] : header).trim().toLowerCase();
}

// Pure decision core — no I/O, directly unit-testable. `classify()` below is just this plus the
// disk-backed VIP list lookup.
export function classifyVerdict(from: string, subject: string, snippet: string, vip: string[]): Verdict {
  const f = from.toLowerCase();
  if (vip.map((s) => s.toLowerCase()).includes(f))    return "vip";

  // Checked before the newsletter/routine patterns so agent mail is classified on whether it wants
  // a DECISION, not on whether its subject happens to contain "updates".
  if (AGENT_SUBJECT_RX.test(subject) || AGENT_SENDER_RX.test(f)) {
    return AGENT_NEEDS_OWNER_RX.test(`${subject} ${snippet}`) ? "escalate" : "routine";
  }

  if (NEWSLETTER_RX.test(from) || NEWSLETTER_RX.test(subject)) return "newsletter";
  if (ROUTINE_RX.test(subject) || ROUTINE_RX.test(snippet))    return "routine";
  return "escalate";
}

export async function classify(msg: GmailMessage): Promise<Verdict> {
  const from = fromAddress(msg.from);
  const { vip } = await loadVipList();
  return classifyVerdict(from, msg.subject, msg.snippet, vip);
}

// Autonomy Spec v0.1, item #7. Fetches the real body (the unread-list scan only carries Gmail's
// ~100-char snippet, not enough to reply to) and asks the model for a short, confident reply.
// Returns null on ANY doubt — no API key, no fetch, no model response, or a response the model
// itself hedged on — so the caller's honesty guarantee (only auto-replied when a reply genuinely
// sent) has something real to fall back to.
async function composeRoutineReply(msg: GmailMessage, senderAddr: string): Promise<{ body: string; messageId?: string } | null> {
  const full = await fetchMessageFull(msg.id).catch(() => null);
  if (!full) return null;

  // Same sender may have emailed before (a different thread — Gmail thread history alone wouldn't
  // catch it) and gets a cold reply every time without this. History only, never vault/RAG: this
  // path replies to any inbox sender, including clients, and the vault stays principal-only.
  const priorTurns = await recentMessagesFor("email", senderAddr, 8).catch(() => []);
  const historyBlock = priorTurns.length
    ? `\n\nPrior emails on this thread, for context (do not repeat, just stay consistent with them):\n${priorTurns.map((m) => `${m.role === "user" ? "Them" : "You"}: ${m.text}`).join("\n")}`
    : "";

  const system = [
    `You are ${OWNER_FIRST}'s assistant, replying on their behalf to a routine scheduling/`,
    `confirmation email. Write ONLY the reply body text — no subject line, no signature.`,
    `Plain, warm, brisk — 2 to 4 sentences. Confirm or acknowledge what's being asked.`,
    `If anything in the message is ambiguous, needs a decision only ${OWNER_FIRST} can make, or you`,
    `are not fully confident a simple confirmation is the right reply, respond with exactly`,
    `the single word SKIP and nothing else — do not guess.${historyBlock}`,
  ].join(" ");
  const user = `From: ${full.from}\nSubject: ${full.subject}\n\n${full.body.slice(0, 4000)}`;

  // OS model setting (agentSettings.ts) → its fallback → this site's built-in model.
  const { callModelText } = await import("./modelCall");
  const res = await callModelText({ site: "routine-reply", purpose: "routine-reply", defaultModel: "claude-sonnet-5", system, prompt: user, maxTokens: 400 });
  const text = res?.text?.trim();
  if (!text || /^SKIP\b/i.test(text)) return null;
  return { body: text, messageId: full.headers.get("message-id") };
}

// The OS user whose dashboard Follow-ups tab escalated emails surface on: the owner's Orion user id
// (ORION_OWNER_USER_ID). osClient authenticates as clara@, whose whoami is NOT the owner, so there
// is no safe default — unset means escalated emails are not mirrored into the OS.
const OS_OWNER_USER_ID = (process.env.ORION_OWNER_USER_ID ?? "").trim();

// Mirrors an escalated email into the OS as an unread 'email.flagged' notification — that's what
// the dashboard's Follow-ups tab lists. Best-effort by design: triage must never fail or slow
// down because the OS is unreachable, so callers .catch(() => {}) this.
async function flagEmailInOs(msg: GmailMessage): Promise<void> {
  const { osClient, osEnabled } = await import("./osClient");
  if (!osEnabled() || !OS_OWNER_USER_ID) return;
  await osClient.callTool("notifications_create", {
    user_id: OS_OWNER_USER_ID,
    type: "email.flagged",
    title: msg.subject || "(no subject)",
    body: (msg.snippet ?? "").slice(0, 300),
    link: `https://mail.google.com/mail/u/0/#inbox/${msg.threadId}`,
    metadata: { gmailMessageId: msg.id, from: msg.from },
  });
}

export async function runTriage(): Promise<Classification[]> {
  const out: Classification[] = [];
  const inbox = await listUnreadInbox(50);
  const forOwnerLabel = await ensureLabel(`Clara/For${OWNER_FIRST}`);
  const archivedLabel = await ensureLabel("Clara/AutoArchived");
  const draftLabel = await ensureLabel("Clara/DraftReply");

  for (const msg of inbox) {
    const verdict = await classify(msg);
    let action: Classification["action"];
    let reason = "";
    // Microsoft Graph migration (ms-mail.ts): addLabel()/archive() both move the message to a
    // different folder, and Graph reassigns a NEW id on every move — Gmail's label-based versions
    // never did. Every branch below that chains a second mutation onto the same message (or logs
    // the id afterward) must thread the reassigned id through via this local `id`, not reuse the
    // original `msg.id` — otherwise the next call 404s on a message that already moved.
    let id = msg.id;

    if (verdict === "vip" || verdict === "escalate") {
      if (forOwnerLabel) {
        const a = await addLabel(id, forOwnerLabel);
        if (a.newId) id = a.newId;
      }
      await star(id);
      action = verdict === "escalate" ? "escalated" : "starred+labeled";
      reason = `verdict=${verdict}`;
      if (verdict === "escalate") await flagEmailInOs(msg).catch(() => {});
    } else if (verdict === "newsletter") {
      if (archivedLabel) {
        const a = await addLabel(id, archivedLabel);
        if (a.newId) id = a.newId;
      }
      const ar = await archive(id);
      if (ar.newId) id = ar.newId;
      await markRead(id);
      action = "archived";
      reason = "newsletter/promo pattern";
    } else if (verdict === "routine") {
      const senderAddr = fromAddress(msg.from);
      const reply = await composeRoutineReply(msg, senderAddr).catch(() => null);
      const sent = reply ? await sendMail({
        to: senderAddr,
        subject: /^re:/i.test(msg.subject) ? msg.subject : `Re: ${msg.subject}`,
        body: reply.body,
        inReplyTo: reply.messageId,
        references: reply.messageId,
      }).catch(() => ({ ok: false })) : null;

      if (sent?.ok) {
        // Only reachable once the send genuinely succeeded — see the honesty note on
        // Classification["action"] above. Distinct label from Clara/DraftReply on purpose: a
        // message under the old label was never actually replied to, and conflating the two
        // regimes here would make historical mail unreadable.
        const repliedLabel = await ensureLabel("Clara/AutoReplied");
        if (repliedLabel) { const a = await addLabel(id, repliedLabel); if (a.newId) id = a.newId; }
        action = "auto-replied";
        reason = "scheduling/confirm/ack pattern — replied";
        // Sender identity is unverified (no DMARC/principal gate on this path, unlike
        // emailCommands.ts) — always recorded as non-principal so it can never reach the owner's own
        // recall index (recall.ts skips principal:false rows).
        await appendMessage("user", msg.snippet ?? "", undefined, { channel: "email", from: senderAddr, principal: false }).catch(() => {});
        await appendMessage("clara", reply!.body, undefined, { channel: "email", from: senderAddr, principal: false }).catch(() => {});
      } else {
        if (draftLabel) { const a = await addLabel(id, draftLabel); if (a.newId) id = a.newId; }
        action = "labeled-for-reply";
        reason = reply ? "scheduling/confirm/ack pattern — reply composed but send failed" : "scheduling/confirm/ack pattern";
      }
    } else {
      action = "escalated";
      reason = "unknown";
      await flagEmailInOs(msg).catch(() => {});
    }

    await ledgerAppend({
      kind: "email.sent",
      actor: "clara",
      what: `${action}: "${msg.subject}" from ${msg.from}`,
      // `id`, not `msg.id` — a move above may have reassigned it; the original id would be a
      // dangling reference once that's happened.
      ref: id,
      meta: { verdict, threadId: msg.threadId },
    });

    // Return the POST-move id too, same reasoning — a caller acting further on this result
    // should see where the message actually ended up, not where it started.
    out.push({ msg: id === msg.id ? msg : { ...msg, id }, verdict, action, reason });
  }
  return out;
}

// SMS/call verdict for the unified inbox (B6) — deliberately simpler than email triage: anyone who
// actually calls or texts Clara's number is a human choosing to reach out, so there's no "noise"
// bucket here, only a reason that says WHY it's signal (a whitelisted/recognized number gets
// flagged differently than a stranger, but both still surface).
/**
 * Bucket an inbound SMS or call for the unified inbox.
 *
 * The return type used to be literally `{ bucket: "signal" }` — every branch returned signal, so
 * every text and call Clara had ever seen counted as something needing the owner, forever. The unified
 * inbox reported "81 things need you, 5 noise", of which 21 were OWNER'S OWN MESSAGES. An answer
 * that large is the same as no answer.
 */
export async function classifyComm(fromE164: string): Promise<{ bucket: "signal" | "noise"; reason: string }> {
  const cfg = await loadConfig();
  const principal = await resolveByPhone(fromE164).catch(() => null);

  // The owner texting Clara is not a thing that needs the owner. They wrote it; they know.
  if (principal?.id === "owner") return { bucket: "noise", reason: "your own message" };
  if (principal) return { bucket: "signal", reason: `${principal.displayName} (recognized)` };

  if (cfg.whitelist.includes(fromE164)) return { bucket: "signal", reason: "whitelisted number" };
  return { bucket: "signal", reason: "inbound from an unrecognized number" };
}

export async function readVipList(): Promise<{ vip: string[] }> {
  return loadVipList();
}

export async function writeVipList(next: { vip: string[] }): Promise<void> {
  const cfg = await loadConfig();
  const p = path.join(cfg.vaultRoot, "preferences", "vips.json");
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(next, null, 2), "utf8");
}
