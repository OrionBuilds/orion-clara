// Clara Gmail — read + label + reply on the work account only.
// The personal Gmail (named in the owner profile) is excluded by policy at the auth layer.

import { gfetch, type GAccount } from "./google-auth";

const BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

export interface GmailMessage {
  id: string;
  threadId: string;
  from: string;
  to: string;
  subject: string;
  snippet: string;
  date: string;
  labelIds: string[];
  unread: boolean;
}

// List unread inbox messages (up to `max`) on the work account.
//
// Promotions are INCLUDED (2026-08-03). The query used to carry `-category:promotions`, which
// excluded the single largest source of visible clutter from every sweep — the owner would ask for
// their inbox to be cleaned, watch it stay full of promotional mail, and reasonably conclude nothing
// had happened. The classifier already treats promotional senders as newsletters, which archive.
export async function listUnreadInbox(max = 50, account: GAccount = "work"): Promise<GmailMessage[]> {
  const q = encodeURIComponent("is:unread in:inbox");
  const r = await gfetch(`${BASE}/messages?q=${q}&maxResults=${max}`, {}, account);
  // THROW, don't return []. A 401/403/429 here used to produce an empty list, which the sweep
  // reported as "0 archived — 0 eligible of 0 unread" under the headline "Inbox swept." A dead
  // token was indistinguishable from a clean mailbox. The sweep's caller already has a catch that
  // ledgers the failure and tells the owner; it just never had anything to catch.
  if (!r.ok) {
    throw new Error(`Gmail inbox list failed: ${r.status} ${(await r.text().catch(() => "")).slice(0, 160)}`);
  }
  const j = await r.json() as { messages?: { id: string; threadId: string }[] };
  const ids = j.messages ?? [];
  return Promise.all(ids.map((m) => fetchMessage(m.id, account))).then((rows) => rows.filter(Boolean) as GmailMessage[]);
}

export async function fetchMessage(id: string, account: GAccount = "work"): Promise<GmailMessage | null> {
  const r = await gfetch(`${BASE}/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`, {}, account);
  if (!r.ok) return null;
  const j = await r.json() as {
    id: string; threadId: string; snippet: string; labelIds?: string[];
    payload: { headers: { name: string; value: string }[] };
  };
  const h = new Map<string, string>();
  for (const { name, value } of j.payload?.headers ?? []) h.set(name.toLowerCase(), value);
  const labelIds = j.labelIds ?? [];
  return {
    id: j.id,
    threadId: j.threadId,
    from: h.get("from") ?? "",
    to: h.get("to") ?? "",
    subject: h.get("subject") ?? "(no subject)",
    snippet: j.snippet ?? "",
    date: h.get("date") ?? "",
    labelIds,
    unread: labelIds.includes("UNREAD"),
  };
}

// Mark read (remove UNREAD label).
export async function markRead(id: string, account: GAccount = "work"): Promise<boolean> {
  const r = await gfetch(`${BASE}/messages/${id}/modify`, {
    method: "POST",
    body: JSON.stringify({ removeLabelIds: ["UNREAD"] }),
  }, account);
  return r.ok;
}

// Archive (remove INBOX label; keep read state as-is).
export async function archive(id: string, account: GAccount = "work"): Promise<boolean> {
  const r = await gfetch(`${BASE}/messages/${id}/modify`, {
    method: "POST",
    body: JSON.stringify({ removeLabelIds: ["INBOX"] }),
  }, account);
  return r.ok;
}

// Star (flag for the owner to see later).
export async function star(id: string, account: GAccount = "work"): Promise<boolean> {
  const r = await gfetch(`${BASE}/messages/${id}/modify`, {
    method: "POST",
    body: JSON.stringify({ addLabelIds: ["STARRED"] }),
  }, account);
  return r.ok;
}

export interface GmailLabel {
  id: string;
  name: string;
  /** "user" = someone created it by hand or we did. "system" = INBOX/SENT/CATEGORY_* etc. */
  type: "user" | "system";
  messagesTotal: number;
  threadsTotal: number;
}

/**
 * Every label with its message count.
 *
 * Exists because deleting a Gmail label is permanent and strips it from every message it was on —
 * so the owner gets to see the real list, with counts, before anything is destroyed. Read-only.
 *
 * Uses `?` on each detail fetch rather than the bulk list because the bulk `labels.list` response
 * omits counts entirely; the counts are the whole point of showing the list.
 */
export async function listLabels(account: GAccount = "work"): Promise<GmailLabel[]> {
  const r = await gfetch(`${BASE}/labels`, {}, account);
  if (!r.ok) throw new Error(`Gmail labels list failed: ${r.status} ${(await r.text().catch(() => "")).slice(0, 160)}`);
  const j = await r.json() as { labels?: { id: string; name: string; type?: string }[] };
  const stubs = j.labels ?? [];

  const detailed = await Promise.all(stubs.map(async (l) => {
    // A failed detail fetch must not hide the label — show it with unknown counts (-1) rather than
    // dropping it from a list someone is about to make delete decisions from.
    const d = await gfetch(`${BASE}/labels/${encodeURIComponent(l.id)}`, {}, account).catch(() => null);
    let messagesTotal = -1, threadsTotal = -1;
    if (d?.ok) {
      const dj = await d.json().catch(() => ({})) as { messagesTotal?: number; threadsTotal?: number };
      messagesTotal = dj.messagesTotal ?? -1;
      threadsTotal = dj.threadsTotal ?? -1;
    }
    return {
      id: l.id,
      name: l.name,
      type: (l.type === "system" ? "system" : "user") as "user" | "system",
      messagesTotal,
      threadsTotal,
    };
  }));

  return detailed.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Delete ONE label by id. Permanent — Gmail strips it from every message it was on.
 *
 * Takes an id, never a name or a pattern, and there is deliberately no "delete all" here: the
 * caller must have listed the labels and named each one. Messages themselves are never affected;
 * only the tag is removed.
 */
export async function deleteLabel(id: string, account: GAccount = "work"): Promise<{ ok: boolean; error?: string }> {
  const r = await gfetch(`${BASE}/labels/${encodeURIComponent(id)}`, { method: "DELETE" }, account);
  // Gmail returns 204 on success. System labels return 400 — that is a correct refusal, not a bug.
  if (r.ok || r.status === 204) return { ok: true };
  return { ok: false, error: `${r.status} ${(await r.text().catch(() => "")).slice(0, 120)}` };
}

// Add or ensure a custom label exists; returns the label id.
export async function ensureLabel(name: string, account: GAccount = "work"): Promise<string | null> {
  const r = await gfetch(`${BASE}/labels`, {}, account);
  if (!r.ok) return null;
  const j = await r.json() as { labels: { id: string; name: string }[] };
  const hit = (j.labels ?? []).find((l) => l.name === name);
  if (hit) return hit.id;
  const c = await gfetch(`${BASE}/labels`, {
    method: "POST",
    body: JSON.stringify({ name, labelListVisibility: "labelShow", messageListVisibility: "show" }),
  }, account);
  if (!c.ok) return null;
  const cj = await c.json() as { id: string };
  return cj.id;
}

/**
 * A message with ALL its headers and its plain-text body.
 *
 * fetchMessage deliberately asks for four metadata headers, which is right for triage and useless
 * for authentication: `Authentication-Results` is where Gmail records the SPF/DKIM/DMARC verdict,
 * and without it a From header is just a string anybody can type. The email command channel refuses
 * to act without that verdict, so it needs this.
 */
export interface GmailFullMessage extends GmailMessage {
  /** Lowercased header name → value. */
  headers: Map<string, string>;
  /** text/plain part, or the stripped-down snippet when the message is HTML-only. */
  body: string;
  /** Every MIME type in the payload tree — `text/calendar` marks an invite (mailFilters). */
  mimeTypes: string[];
}

function decodeB64Url(data: string): string {
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

/** Depth-first walk for the first text/plain part; falls back to text/html with tags stripped. */
function extractBody(payload: unknown): string {
  const p = payload as { mimeType?: string; body?: { data?: string }; parts?: unknown[] } | undefined;
  if (!p) return "";
  if (p.mimeType === "text/plain" && p.body?.data) return decodeB64Url(p.body.data);
  for (const part of p.parts ?? []) {
    const hit = extractBody(part);
    if (hit) return hit;
  }
  if (p.mimeType === "text/html" && p.body?.data) {
    return decodeB64Url(p.body.data).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  }
  return "";
}

/** All MIME types in a payload tree, depth-first. */
function collectMimeTypes(payload: unknown, out: string[] = []): string[] {
  const p = payload as { mimeType?: string; parts?: unknown[] } | undefined;
  if (!p) return out;
  if (p.mimeType) out.push(p.mimeType);
  for (const part of p.parts ?? []) collectMimeTypes(part, out);
  return out;
}

export async function fetchMessageFull(id: string, account: GAccount = "work"): Promise<GmailFullMessage | null> {
  const r = await gfetch(`${BASE}/messages/${id}?format=full`, {}, account);
  if (!r.ok) return null;
  const j = await r.json() as {
    id: string; threadId: string; snippet?: string; labelIds?: string[];
    payload?: { headers?: { name: string; value: string }[] };
  };
  const headers = new Map<string, string>();
  for (const { name, value } of j.payload?.headers ?? []) headers.set(name.toLowerCase(), value);
  const labelIds = j.labelIds ?? [];
  return {
    id: j.id,
    threadId: j.threadId,
    from: headers.get("from") ?? "",
    to: headers.get("to") ?? "",
    subject: headers.get("subject") ?? "(no subject)",
    snippet: j.snippet ?? "",
    date: headers.get("date") ?? "",
    labelIds,
    unread: labelIds.includes("UNREAD"),
    headers,
    body: extractBody(j.payload) || (j.snippet ?? ""),
    mimeTypes: collectMimeTypes(j.payload),
  };
}

export interface ThreadMessage { at: string; from: string; text: string }

/**
 * Earlier messages in a thread, oldest first — reply/triage CONTEXT, never instructions (the
 * caller's job to frame it that way). Best-effort: a fetch failure returns [] rather than
 * throwing, since context is a nice-to-have and must never block a reply or a triage decision
 * (2026-09-17 — clientEmailTriage.ts used to classify a client's email from its body alone, with
 * no memory of anything said earlier in the same thread).
 */
export async function getThread(threadId: string, account: GAccount = "work", opts: { excludeId?: string; max?: number } = {}): Promise<ThreadMessage[]> {
  const max = opts.max ?? 8;
  const r = await gfetch(`${BASE}/threads/${threadId}?format=full`, {}, account);
  if (!r.ok) return [];
  const j = await r.json() as { messages?: { id: string; internalDate?: string; snippet?: string; payload?: unknown }[] };
  const out: ThreadMessage[] = [];
  for (const m of j.messages ?? []) {
    if (opts.excludeId && m.id === opts.excludeId) continue;
    const headers = new Map<string, string>();
    for (const { name, value } of (m.payload as { headers?: { name: string; value: string }[] } | undefined)?.headers ?? []) {
      headers.set(name.toLowerCase(), value);
    }
    const text = (extractBody(m.payload) || (m.snippet ?? "")).trim();
    out.push({ at: new Date(Number(m.internalDate ?? 0) || Date.now()).toISOString(), from: headers.get("from") ?? "", text });
  }
  return out.slice(-max);
}

/**
 * Search mail by Gmail query, across the whole mailbox (not just unread, not just the inbox).
 *
 * Separate from listUnreadInbox because that one is the SWEEP's view — it hardcodes
 * `is:unread in:inbox` and is tuned for triage. "Find that email from the accountant in June"
 * needs archived and read mail too.
 *
 * Throws on a non-OK response for the same reason listUnreadInbox does: an empty array is
 * indistinguishable from "no results", and a dead token silently reporting "I couldn't find
 * anything" is exactly the comfortable lie this codebase keeps having to remove.
 */
export async function searchMessages(query: string, max = 20, account: GAccount = "work"): Promise<GmailMessage[]> {
  const r = await gfetch(`${BASE}/messages?q=${encodeURIComponent(query)}&maxResults=${Math.min(50, Math.max(1, max))}`, {}, account);
  if (!r.ok) {
    throw new Error(`Gmail search failed: ${r.status} ${(await r.text().catch(() => "")).slice(0, 160)}`);
  }
  const j = await r.json() as { messages?: { id: string }[] };
  const ids = j.messages ?? [];
  return Promise.all(ids.map((m) => fetchMessage(m.id, account))).then((rows) => rows.filter(Boolean) as GmailMessage[]);
}

// ── Filters (settings API) ──────────────────────────────────────────────────────────────────────
//
// SCOPE WARNING. These three need `https://www.googleapis.com/auth/gmail.settings.basic`, which the
// work account's refresh token does not currently carry. Adding the scope to scopesFor() does not
// grant it — Google only widens a token at re-consent — so every one of these can legitimately 403
// on a healthy, fully-working setup.
//
// That is why they return a structured `needsConsent` instead of throwing: the caller
// (blocklist-backed block_sender) has a real fallback that works without the scope, and must be
// able to tell "Google refused for want of a scope" apart from "this failed". Reporting the former
// as a generic failure would send the owner debugging a token that is fine.

export interface GmailFilter {
  id: string;
  from?: string;
  addLabelIds?: string[];
  removeLabelIds?: string[];
}

/** Distinguishes a missing scope (actionable: re-authorize) from any other failure. */
export interface FilterResult<T> {
  ok: boolean;
  value?: T;
  error?: string;
  /** True when Google refused specifically because the token lacks gmail.settings.basic. */
  needsConsent?: boolean;
}

function scopeRefusal(status: number, body: string): boolean {
  return (status === 403 || status === 401) && /insufficient|scope|permission/i.test(body);
}

export async function listFilters(account: GAccount = "work"): Promise<FilterResult<GmailFilter[]>> {
  const r = await gfetch(`${BASE}/settings/filters`, {}, account);
  const body = r.ok ? "" : (await r.text().catch(() => ""));
  if (!r.ok) return { ok: false, error: `${r.status} ${body.slice(0, 160)}`, needsConsent: scopeRefusal(r.status, body) };
  const j = await r.json() as { filter?: { id: string; criteria?: { from?: string }; action?: { addLabelIds?: string[]; removeLabelIds?: string[] } }[] };
  return {
    ok: true,
    value: (j.filter ?? []).map((f) => ({
      id: f.id,
      from: f.criteria?.from,
      addLabelIds: f.action?.addLabelIds,
      removeLabelIds: f.action?.removeLabelIds,
    })),
  };
}

/**
 * Create a server-side filter.
 *
 * Deliberately never sets `action.delete` or adds TRASH — the strongest action taken here is
 * skipping the inbox and marking read. Phishing in particular must remain findable: it is evidence,
 * and a filter that silently destroys mail is a far worse failure mode than one that files it.
 */
export async function createFilter(
  criteria: { from?: string; subject?: string; query?: string },
  action: { addLabelIds?: string[]; removeLabelIds?: string[] },
  account: GAccount = "work",
): Promise<FilterResult<string>> {
  const r = await gfetch(`${BASE}/settings/filters`, {
    method: "POST",
    body: JSON.stringify({ criteria, action }),
  }, account);
  const body = r.ok ? "" : (await r.text().catch(() => ""));
  if (!r.ok) return { ok: false, error: `${r.status} ${body.slice(0, 160)}`, needsConsent: scopeRefusal(r.status, body) };
  const j = await r.json() as { id: string };
  return { ok: true, value: j.id };
}

export async function deleteFilter(id: string, account: GAccount = "work"): Promise<FilterResult<true>> {
  const r = await gfetch(`${BASE}/settings/filters/${encodeURIComponent(id)}`, { method: "DELETE" }, account);
  if (r.ok || r.status === 204) return { ok: true, value: true };
  const body = await r.text().catch(() => "");
  return { ok: false, error: `${r.status} ${body.slice(0, 160)}`, needsConsent: scopeRefusal(r.status, body) };
}

export async function addLabel(id: string, labelId: string, account: GAccount = "work"): Promise<boolean> {
  const r = await gfetch(`${BASE}/messages/${id}/modify`, {
    method: "POST",
    body: JSON.stringify({ addLabelIds: [labelId] }),
  }, account);
  return r.ok;
}

/**
 * RFC 2047 encode a header value that contains non-ASCII.
 *
 * MIME headers are ASCII-only. Putting raw UTF-8 bytes in `Subject:` is not merely sloppy — the
 * receiving client decodes them as latin-1, so an em dash (—) arrives as "Ã¢Â€Â”". The BODY was
 * always fine because it declares charset=UTF-8; only the header was wrong, which is why the
 * mojibake showed up in subject lines and nowhere else.
 *
 * Pure-ASCII subjects pass through untouched so the common case stays readable in raw MIME.
 */
function encodeHeaderWord(value: string): string {
  if (!value) return "";
  // eslint-disable-next-line no-control-regex
  if (!/[^\x00-\x7F]/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

// Send a fresh message from the work account.
// Create a Gmail DRAFT (never sends) in the account's mailbox — the owner reviews and sends.
// Threads onto the client's message via threadId + In-Reply-To/References so it lands in-thread.
// Used by the client-email triage flow: CLARA drafts, the owner sends. Deliberately does NOT touch
// the send path (mail-send.ts / sendMail) — this must never deliver on its own.
export async function createReplyDraft(input: {
  to: string; subject: string; body: string; cc?: string; threadId?: string; inReplyTo?: string; references?: string;
}, account: GAccount = "work"): Promise<{ ok: boolean; id?: string; error?: string }> {
  const headerLines = [
    `To: ${input.to}`,
    input.cc ? `Cc: ${input.cc}` : "",
    `Subject: ${encodeHeaderWord(input.subject)}`,
    input.inReplyTo ? `In-Reply-To: ${input.inReplyTo}` : "",
    input.references ? `References: ${input.references}` : "",
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
  ].filter(Boolean);
  // The blank line separating headers from the body is mandatory (RFC 2822) — it must never go
  // through the same filter(Boolean) as the optional headers above, or a parser reading the raw
  // message can't find the body boundary and the body silently vanishes (2026-09-19 incident).
  const lines = [...headerLines, "", input.body].join("\r\n");
  const raw = Buffer.from(lines, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const message: Record<string, unknown> = { raw };
  if (input.threadId) message.threadId = input.threadId;
  const r = await gfetch(`${BASE}/drafts`, {
    method: "POST",
    body: JSON.stringify({ message }),
  }, account);
  if (!r.ok) return { ok: false, error: `draft ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}` };
  const j = await r.json() as { id: string };
  return { ok: true, id: j.id };
}

export async function sendMail(input: {
  to: string; subject: string; body: string; cc?: string; inReplyTo?: string; references?: string;
  /** Gmail threads the sent copy under the client's message (with In-Reply-To/References above). */
  threadId?: string;
  /** Extra headers, e.g. { "X-Clara-Notify": "1" } so Clara can recognise her own mail. ASCII only. */
  headers?: Record<string, string>;
  /** Optional HTML alternative (2026-09-24, the morning brief). Sent as multipart/alternative with `body` as the text part. */
  html?: string;
}, account: GAccount = "work"): Promise<{ ok: boolean; id?: string; threadId?: string; error?: string }> {
  // Owner rule (2026-09-15): the owner is CC'd on every email CLARA sends — see ownerCc.ts.
  const { withOwnerCc } = await import("./ownerCc");
  const { OWNER_WORK_EMAIL } = await import("./owner");
  const cc = withOwnerCc(input.to, input.cc, OWNER_WORK_EMAIL);
  // Anything addressed to a principal is Clara's own outbound mail landing in the inbox she reads
  // commands from. Stamp it so emailCommands recognises it instead of refusing it every 3 minutes
  // for the DMARC verdict self-sent mail can never have (2026-09-24).
  const headers: Record<string, string> = { ...(input.headers ?? {}) };
  try {
    const { loadConfig } = await import("./config");
    const principals = (await loadConfig()).principals.owner.emails.map((e) => e.toLowerCase());
    const rcpts = `${input.to} ${cc ?? ""}`.toLowerCase();
    if (principals.some((e) => e && rcpts.includes(e))) {
      headers["X-Clara-Notify"] ??= "1";
      headers["X-Agent"] ??= "clara";
    }
  } catch { /* config unreadable — send without the stamp */ }
  const extra = Object.entries(headers).map(([k, v]) => `${k.replace(/[^\w-]/g, "")}: ${v.replace(/[\r\n]+/g, " ")}`);
  const headerLines = [
    `To: ${input.to}`,
    cc ? `Cc: ${cc}` : "",
    `Subject: ${encodeHeaderWord(input.subject)}`,
    input.inReplyTo ? `In-Reply-To: ${input.inReplyTo}` : "",
    input.references ? `References: ${input.references}` : "",
    ...extra,
    "MIME-Version: 1.0",
  ].filter(Boolean);
  // Same fix as createReplyDraft above: the header/body blank line must not go through
  // filter(Boolean) with the optional headers, or the body silently vanishes.
  let lines: string;
  if (input.html) {
    const boundary = `clara-alt-${Date.now().toString(36)}`;
    lines = [
      ...headerLines,
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      "",
      `--${boundary}`,
      'Content-Type: text/plain; charset="UTF-8"',
      "Content-Transfer-Encoding: 8bit",
      "",
      input.body,
      "",
      `--${boundary}`,
      'Content-Type: text/html; charset="UTF-8"',
      "Content-Transfer-Encoding: 8bit",
      "",
      input.html,
      "",
      `--${boundary}--`,
      "",
    ].join("\r\n");
  } else {
    lines = [...headerLines, 'Content-Type: text/plain; charset="UTF-8"', "", input.body].join("\r\n");
  }
  const raw = Buffer.from(lines, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const r = await gfetch(`${BASE}/messages/send`, {
    method: "POST",
    body: JSON.stringify(input.threadId ? { raw, threadId: input.threadId } : { raw }),
  }, account);
  if (!r.ok) return { ok: false, error: `send ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}` };
  const j = await r.json() as { id: string; threadId?: string };
  return { ok: true, id: j.id, threadId: j.threadId };
}
