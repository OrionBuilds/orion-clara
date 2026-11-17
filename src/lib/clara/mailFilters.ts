// Pure helpers that decide whether an inbound email is a HUMAN writing to us, before anything is
// drafted, sent or dispatched on its back. Added 2026-09-14 when client-email triage was widened
// from "exact CRM email" to "any address at a client's domain": the unread inbox is mostly robots
// (Hooli "Task overdue", Globex "New Lead", calendar invites, Google-Group newsletters), and
// a domain match alone would have CLARA acknowledging notification bots and queuing tasks for them.

const FREEMAIL = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "outlook.com", "hotmail.com", "icloud.com", "me.com",
  "aol.com", "proton.me", "protonmail.com", "live.com", "msn.com", "ymail.com", "mail.com",
]);

/** Bare lowercased address out of a From header; a bare address passes through. */
export function senderEmail(from: string): string {
  const m = from.match(/<([^>]+)>/);
  return (m ? m[1] : from).trim().toLowerCase();
}

/** The sender's domain when it can stand for a company; null for freemail or malformed. */
export function domainOf(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at < 1) return null;
  const d = email.slice(at + 1).toLowerCase().trim();
  if (!d || !d.includes(".") || FREEMAIL.has(d)) return null;
  return d;
}

const AUTOMATED_LOCAL =
  /^(no-?reply|do-?not-?reply|notifications?|notify|alerts?|alerting|mailer-daemon|postmaster|bounces?|newsletter|digest|calendar-notification|system|automated|robot|updates?|billing|receipts?)([+._-]|$)/i;

export interface MailShape {
  from: string;
  subject: string;
  /** To header (raw). Used to spot self-addressed mail; falls back to headers.get("to"). */
  to?: string;
  /** Lowercased header name → value (GmailFullMessage.headers). Optional for the cheap pre-check. */
  headers?: Map<string, string>;
  mimeTypes?: string[];
}

/**
 * Why this message is automated, or null when it looks like a person wrote it. Header rules only
 * apply when headers were fetched; the sender-name rule and calendar-subject rule work on the stub.
 */
export function automatedReason(m: MailShape): string | null {
  const h = m.headers;
  const from = senderEmail(m.from);
  if (h) {
    if (h.has("list-unsubscribe") || h.has("list-id") || h.has("list-post")) return "mailing list";
    if (/^(bulk|list|junk)$/i.test((h.get("precedence") ?? "").trim())) return "precedence bulk";
    const auto = (h.get("auto-submitted") ?? "").trim().toLowerCase();
    if (auto && auto !== "no") return "auto-submitted";
    if (h.has("x-auto-response-suppress") || h.has("x-google-group-id") || h.has("x-mailer-daemon")) return "automated header";
    if (/^(?:multipart\/report|message\/delivery-status)/i.test(h.get("content-type") ?? "")) return "delivery report";
  }
  if (m.mimeTypes?.some((t) => t.toLowerCase() === "text/calendar")) return "calendar";
  if (/^(?:invitation|updated invitation|accepted|tentatively accepted|declined|cancell?ed event|reminder):/i.test(m.subject.trim())) return "calendar";
  const local = from.split("@")[0] ?? "";
  if (AUTOMATED_LOCAL.test(local)) return `automated sender (${local})`;
  return null;
}

/**
 * CLARA's own notification mail. She emails the owner from their own address ("Clara digest (N)", "Clara: kind")
 * and reads commands from the same inbox, so without this the digest is re-evaluated as a possible
 * command every tick — and refused every tick for failing DMARC.
 */
export function isClaraNotification(m: MailShape, principalEmails: string[]): boolean {
  if (m.headers?.get("x-clara-notify") === "1") return true;
  // Any agent stamps X-Agent on owner-bound mail (FRIDAY, clara). None of it is a command.
  if ((m.headers?.get("x-agent") ?? "").trim()) return true;
  const from = senderEmail(m.from);
  const principals = principalEmails.map((e) => e.toLowerCase());
  if (!principals.includes(from)) return false;
  // Self-addressed: the owner's address is both sender and recipient. Only Clara writes that mail — a
  // human replying to themselves is not a thing — and it can never carry a DMARC pass to check.
  // …except a REPLY: when the owner answers a self-addressed brief from their own mailbox the message is
  // also self-addressed, but it is their instruction, not her notification. Clara never sends "Re:".
  const subject = m.subject.trim();
  const isReply = /^(?:re|fwd?|aw|wg)\s*:/i.test(subject);
  const to = (m.to ?? m.headers?.get("to") ?? "").toLowerCase();
  if (to && to.includes(from) && !isReply) return true;
  return /^Clara(?:: |\s+digest \()/.test(subject);
}

/** `jordan@example.com` → `j***@example.com` — enough to recognise, not enough to harvest. */
export function redactAddress(email: string): string {
  const e = senderEmail(email);
  const at = e.indexOf("@");
  if (at < 1) return "***";
  return `${e.slice(0, 1)}***@${e.slice(at + 1)}`;
}
