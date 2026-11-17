// Clara Outlook Mail (Microsoft Graph) — read + folder-file + reply on the work account only.
//
// Microsoft Graph replacement for gmail.ts. Same exported names and call signatures as gmail.ts,
// so a later pass can repoint consumer imports at this file without touching their call sites. The
// *behavior* underneath several of these is NOT identical to Gmail's — Outlook has no label model,
// no multipart/alternative send, and a genuinely different filter/rule engine. Every place that
// diverges carries a comment explaining the shift; see the ones marked BEHAVIOR CHANGE.
//
// The owner's personal account and their own mailbox are excluded at the auth layer (ms-auth.ts),
// same policy as under Google.

import { mfetch, type MAccount } from "./ms-auth";

const BASE = "https://graph.microsoft.com/v1.0/me";

export interface GmailMessage {
  id: string;
  threadId: string;
  from: string;
  to: string;
  subject: string;
  snippet: string;
  date: string;
  /**
   * APPROXIMATION. Gmail's labelIds is the message's full label membership (INBOX, UNREAD, user
   * labels, everything). Graph has no label system at all, so this only ever carries synthesized
   * pseudo-labels this module knows for certain — "UNREAD" when isRead is false, and "INBOX" when
   * the message came from a call that specifically listed the inbox folder. Any other Gmail
   * labelIds check (e.g. `.includes("SENT")`) will not see a match through this field.
   */
  labelIds: string[];
  unread: boolean;
}

interface GraphEmailAddress { emailAddress?: { name?: string; address?: string } }

interface GraphMessageRaw {
  id: string;
  conversationId?: string;
  subject?: string;
  from?: GraphEmailAddress;
  toRecipients?: GraphEmailAddress[];
  receivedDateTime?: string;
  bodyPreview?: string;
  isRead?: boolean;
  flag?: { flagStatus?: string };
}

function formatAddress(a?: GraphEmailAddress): string {
  const name = a?.emailAddress?.name?.trim();
  const address = a?.emailAddress?.address ?? "";
  return name ? `${name} <${address}>` : address;
}

function toGmailMessage(j: GraphMessageRaw, extraLabels: string[] = []): GmailMessage {
  const labelIds = [...extraLabels];
  if (j.isRead === false && !labelIds.includes("UNREAD")) labelIds.push("UNREAD");
  // Synthesize the one other pseudo-label callers actually check for: star()'s flag.flagStatus is
  // the Graph analogue of Gmail's STARRED label (see star()'s BEHAVIOR CHANGE comment below).
  // Without this, `.labelIds.includes("STARRED")` would always read false post-migration, and
  // inboxZero.ts's "don't re-star an already-starred VIP message" guard would never fire — every
  // run would burn a mutation-cap slot re-flagging the same already-starred messages.
  if (j.flag?.flagStatus === "flagged" && !labelIds.includes("STARRED")) labelIds.push("STARRED");
  return {
    id: j.id,
    threadId: j.conversationId ?? j.id,
    from: formatAddress(j.from),
    to: (j.toRecipients ?? []).map(formatAddress).filter(Boolean).join(", "),
    subject: j.subject ?? "(no subject)",
    snippet: j.bodyPreview ?? "",
    date: j.receivedDateTime ?? "",
    labelIds,
    unread: j.isRead === false,
  };
}

const LIST_SELECT = "subject,from,toRecipients,receivedDateTime,bodyPreview,isRead,categories,conversationId,flag";

// List unread inbox messages (up to `max`) on the work account.
export async function listUnreadInbox(max = 50, account: MAccount = "work"): Promise<GmailMessage[]> {
  const out: GmailMessage[] = [];
  let url: string | null =
    `${BASE}/mailFolders/inbox/messages?$filter=${encodeURIComponent("isRead eq false")}&$top=${Math.min(max, 999)}&$select=${LIST_SELECT}`;
  // THROW, don't return []. Same reasoning as the Gmail original: a dead token here must not look
  // like a clean inbox to the sweep that calls this.
  while (url && out.length < max) {
    const r = await mfetch(url, {}, account);
    if (!r.ok) {
      throw new Error(`Graph inbox list failed: ${r.status} ${(await r.text().catch(() => "")).slice(0, 160)}`);
    }
    const j = await r.json() as { value?: GraphMessageRaw[]; "@odata.nextLink"?: string };
    for (const m of j.value ?? []) out.push(toGmailMessage(m, ["INBOX"]));
    url = j["@odata.nextLink"] ?? null;
  }
  return out.slice(0, max);
}

export async function fetchMessage(id: string, account: MAccount = "work"): Promise<GmailMessage | null> {
  const r = await mfetch(`${BASE}/messages/${id}?$select=${LIST_SELECT}`, {}, account);
  if (!r.ok) return null;
  const j = await r.json() as GraphMessageRaw;
  return toGmailMessage(j);
}

// Mark read.
export async function markRead(id: string, account: MAccount = "work"): Promise<boolean> {
  const r = await mfetch(`${BASE}/messages/${id}`, { method: "PATCH", body: JSON.stringify({ isRead: true }) }, account);
  return r.ok;
}

/**
 * BEHAVIOR CHANGE. Gmail's archive removes the INBOX label only — the message keeps its id and
 * stays wherever else it was filed. Outlook has no "untag" equivalent; the nearest analogue is
 * moving the message into the mailbox's well-known Archive folder. Graph's /move ALSO assigns the
 * moved message a brand-new id in the destination folder, so — unlike the Gmail original, which
 * could return a bare boolean because the id never changed — this returns the new id too.
 * CONFIRMED LIVE HAZARD, not theoretical: inboxZero.ts calls `addLabel(m.id, lid)` then
 * `archive(m.id)` on the SAME message in sequence; without threading the new id through, the
 * second call 404s on an id that already moved. Flagged for the consumer-import-swap step (no
 * file imports from ms-mail.ts yet, so nothing is broken by this signature right now).
 */
export async function archive(id: string, account: MAccount = "work"): Promise<{ ok: boolean; newId?: string }> {
  const r = await mfetch(`${BASE}/messages/${id}/move`, { method: "POST", body: JSON.stringify({ destinationId: "archive" }) }, account);
  if (!r.ok) return { ok: false };
  const j = await r.json().catch(() => ({})) as { id?: string };
  return { ok: true, newId: j.id };
}

/**
 * BEHAVIOR CHANGE. Gmail's STARRED label becomes Outlook's flag. Conceptually the same "mark for
 * later" signal, but a flag is one boolean state, not a label that coexists independently with
 * every other label the message carries.
 */
export async function star(id: string, account: MAccount = "work"): Promise<boolean> {
  const r = await mfetch(`${BASE}/messages/${id}`, { method: "PATCH", body: JSON.stringify({ flag: { flagStatus: "flagged" } }) }, account);
  return r.ok;
}

export interface GmailLabel {
  id: string;
  name: string;
  /** "user" = someone created it by hand or we did. "system" = a well-known Outlook folder. */
  type: "user" | "system";
  messagesTotal: number;
  threadsTotal: number;
}

interface GraphFolderRaw { id: string; displayName: string; totalItemCount?: number; unreadItemCount?: number }

const WELL_KNOWN_FOLDERS = ["inbox", "archive", "sentitems", "deleteditems", "drafts", "junkemail"] as const;

/** Resolve the well-known folder aliases to their real folder ids, once, so listLabels can tell
 *  system folders apart from user-created ones without guessing off localized display names. */
async function wellKnownFolderIds(account: MAccount): Promise<Set<string>> {
  const ids = await Promise.all(WELL_KNOWN_FOLDERS.map(async (name) => {
    const r = await mfetch(`${BASE}/mailFolders/${name}?$select=id`, {}, account).catch(() => null);
    if (!r?.ok) return null;
    const j = (await r.json().catch(() => null)) as { id?: string } | null;
    return j?.id ?? null;
  }));
  return new Set(ids.filter((x): x is string => Boolean(x)));
}

/**
 * Every mail folder with its message count. Read-only — mirrors the Gmail original's purpose
 * (show real counts before anything is deleted), but the thing being listed is FOLDERS, not labels,
 * because archive() above files messages into a folder, not a label.
 *
 * threadsTotal is set equal to messagesTotal: Graph has no per-folder thread/conversation count the
 * way Gmail's labels.get does, so rather than invent a number, this reports the one real count
 * twice.
 */
export async function listLabels(account: MAccount = "work"): Promise<GmailLabel[]> {
  const systemIds = await wellKnownFolderIds(account);
  const out: GmailLabel[] = [];
  let url: string | null = `${BASE}/mailFolders?$top=100&$select=id,displayName,totalItemCount,unreadItemCount`;
  while (url) {
    const r = await mfetch(url, {}, account);
    if (!r.ok) throw new Error(`Graph folder list failed: ${r.status} ${(await r.text().catch(() => "")).slice(0, 160)}`);
    const j = await r.json() as { value?: GraphFolderRaw[]; "@odata.nextLink"?: string };
    for (const f of j.value ?? []) {
      const messagesTotal = f.totalItemCount ?? -1;
      out.push({
        id: f.id,
        name: f.displayName,
        type: systemIds.has(f.id) ? "system" : "user",
        messagesTotal,
        threadsTotal: messagesTotal,
      });
    }
    url = j["@odata.nextLink"] ?? null;
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Delete ONE mail folder by id.
 *
 * Gmail's deleteLabel only stripped a tag from every message that carried it — the messages
 * themselves were never touched, which is the entire safety premise `src/app/api/mail/labels/
 * route.ts` is built on ("nothing gets deleted until the owner has seen the list — only the TAG
 * is permanent, the mail survives"). Graph has no "untag" concept for folders: a bare
 * DELETE /mailFolders/{id} deletes the folder AND every message filed inside it, permanently —
 * a materially more destructive operation than the one this function is supposed to perform.
 *
 * So this reproduces the ORIGINAL guarantee instead of silently inheriting the harsher one: empty
 * the folder into Archive first (paginated, best-effort per message — one stuck message doesn't
 * block the rest), THEN delete the now-empty folder. Mail never gets destroyed by this call,
 * matching what every caller of deleteLabel was already written to assume.
 */
export async function deleteLabel(id: string, account: MAccount = "work"): Promise<{ ok: boolean; error?: string }> {
  let url: string | null = `${BASE}/mailFolders/${encodeURIComponent(id)}/messages?$top=999&$select=id`;
  while (url) {
    const r: Response = await mfetch(url, {}, account);
    if (!r.ok) return { ok: false, error: `listing folder contents before delete: ${r.status} ${(await r.text().catch(() => "")).slice(0, 120)}` };
    const j = await r.json() as { value?: { id: string }[]; "@odata.nextLink"?: string };
    for (const msg of j.value ?? []) {
      await mfetch(`${BASE}/messages/${encodeURIComponent(msg.id)}/move`, {
        method: "POST", body: JSON.stringify({ destinationId: "archive" }),
      }, account).catch(() => null);
    }
    url = j["@odata.nextLink"] ?? null;
  }
  const r = await mfetch(`${BASE}/mailFolders/${encodeURIComponent(id)}`, { method: "DELETE" }, account);
  if (r.ok || r.status === 204) return { ok: true };
  return { ok: false, error: `${r.status} ${(await r.text().catch(() => "")).slice(0, 120)}` };
}

// Find-or-create a mail folder; returns the folder id.
export async function ensureLabel(name: string, account: MAccount = "work"): Promise<string | null> {
  const escaped = name.replace(/'/g, "''");
  const r = await mfetch(`${BASE}/mailFolders?$filter=${encodeURIComponent(`displayName eq '${escaped}'`)}`, {}, account);
  if (!r.ok) return null;
  const j = await r.json() as { value?: { id: string; displayName: string }[] };
  const hit = (j.value ?? []).find((f) => f.displayName === name);
  if (hit) return hit.id;
  const c = await mfetch(`${BASE}/mailFolders`, { method: "POST", body: JSON.stringify({ displayName: name }) }, account);
  if (!c.ok) return null;
  const cj = await c.json() as { id: string };
  return cj.id;
}

/**
 * A message with ALL its headers and its plain-text body.
 *
 * `headers` comes from Graph's internetMessageHeaders — the analogue of Gmail's raw header list,
 * and specifically what carries Authentication-Results (SPF/DKIM/DMARC), which emailCommands.ts's
 * dmarcPassed() depends on. Exchange's transport pipeline populates internetMessageHeaders for mail
 * that actually transited mail flow; a message that never went through transport (e.g. a draft
 * created and never sent) won't have one — same as Gmail never attaching Authentication-Results to
 * a locally-composed draft, so this is not a new gap.
 */
export interface GmailFullMessage extends GmailMessage {
  /** Lowercased header name → value. */
  headers: Map<string, string>;
  /** Plain text, or HTML with tags stripped — same fallback the Gmail original used. */
  body: string;
  /**
   * APPROXIMATION. Graph has no MIME-part tree to walk the way Gmail's payload does — a message
   * has exactly one body content type (text or html). This list is reconstructed from that single
   * content type plus attachment content types, and is NOT a real multipart structure.
   *
   * Outlook also represents a meeting invite as a distinct message type (meetingMessageType), not
   * as a text/calendar MIME part — so when meetingMessageType is set, this still pushes a synthetic
   * "text/calendar" entry, specifically so mailFilters.ts's existing `mimeTypes.includes/some(...)`
   * invite check keeps working unmodified against messages that are invites for a reason Gmail
   * never had.
   */
  mimeTypes: string[];
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

interface GraphAttachmentRaw { contentType?: string }

const CALENDAR_CONTENT_TYPES = new Set(["text/calendar", "application/ics"]);

const FULL_SELECT =
  "subject,from,toRecipients,receivedDateTime,bodyPreview,isRead,conversationId,body,internetMessageHeaders,meetingMessageType,hasAttachments";

export async function fetchMessageFull(id: string, account: MAccount = "work"): Promise<GmailFullMessage | null> {
  const r = await mfetch(`${BASE}/messages/${id}?$select=${FULL_SELECT}`, {}, account);
  if (!r.ok) return null;
  const j = await r.json() as GraphMessageRaw & {
    body?: { contentType?: "text" | "html"; content?: string };
    internetMessageHeaders?: { name: string; value: string }[];
    meetingMessageType?: string;
    hasAttachments?: boolean;
  };

  const headers = new Map<string, string>();
  for (const { name, value } of j.internetMessageHeaders ?? []) headers.set(name.toLowerCase(), value);

  const rawContent = j.body?.content ?? "";
  const body = j.body?.contentType === "html" ? stripHtml(rawContent) : rawContent;

  const mimeTypes: string[] = [j.body?.contentType === "html" ? "text/html" : "text/plain"];
  if (j.meetingMessageType && j.meetingMessageType !== "none") mimeTypes.push("text/calendar");

  if (j.hasAttachments) {
    const ar = await mfetch(`${BASE}/messages/${id}/attachments?$select=contentType`, {}, account).catch(() => null);
    if (ar?.ok) {
      const aj = await ar.json().catch(() => ({})) as { value?: GraphAttachmentRaw[] };
      for (const a of aj.value ?? []) {
        if (!a.contentType) continue;
        mimeTypes.push(a.contentType);
        if (CALENDAR_CONTENT_TYPES.has(a.contentType.toLowerCase())) mimeTypes.push("text/calendar");
      }
    }
  }

  const base = toGmailMessage(j);
  return { ...base, headers, body: body || base.snippet, mimeTypes };
}

export interface ThreadMessage { at: string; from: string; text: string }

/**
 * Earlier messages in a thread (Graph's conversationId, passed in as `threadId` to keep the same
 * call shape callers already use), oldest first. Graph's default $orderby sort is ascending, so no
 * reversal is needed to get oldest-first. Best-effort: a fetch failure returns [] rather than
 * throwing, same as the Gmail original — thread context is a nice-to-have and must never block a
 * reply or triage decision.
 */
export async function getThread(threadId: string, account: MAccount = "work", opts: { excludeId?: string; max?: number } = {}): Promise<ThreadMessage[]> {
  const max = opts.max ?? 8;
  try {
    const escaped = threadId.replace(/'/g, "''");
    const select = "id,from,receivedDateTime,bodyPreview,body";
    const r = await mfetch(
      `${BASE}/messages?$filter=${encodeURIComponent(`conversationId eq '${escaped}'`)}&$orderby=receivedDateTime&$select=${select}&$top=${max + 1}`,
      {}, account,
    );
    if (!r.ok) return [];
    const j = await r.json() as { value?: (GraphMessageRaw & { body?: { contentType?: string; content?: string } })[] };
    const out: ThreadMessage[] = [];
    for (const m of j.value ?? []) {
      if (opts.excludeId && m.id === opts.excludeId) continue;
      const text = (m.body?.contentType === "html" ? stripHtml(m.body?.content ?? "") : (m.body?.content ?? m.bodyPreview ?? "")).trim();
      out.push({ at: m.receivedDateTime ?? new Date().toISOString(), from: formatAddress(m.from), text });
    }
    return out.slice(-max);
  } catch {
    return [];
  }
}

/**
 * Search mail by free text, across the whole mailbox.
 *
 * Graph's $search is a full-text search across subject/body/etc. — the closest analogue to a
 * Gmail query, but NOT the same language: Gmail query operators like `is:unread` or `from:x@y.com`
 * are not parsed by Graph's $search, they're just literal search text here. A caller still passing
 * Gmail-style query strings will get back a text search for that literal string, not the filtered
 * result it expects — that mismatch is a follow-up fix for whichever caller does that, not handled
 * in this file.
 *
 * Throws on a non-OK response for the same reason listUnreadInbox does: an empty array must not be
 * indistinguishable from "a dead token searched nothing".
 */
export async function searchMessages(query: string, max = 20, account: MAccount = "work"): Promise<GmailMessage[]> {
  const top = Math.min(50, Math.max(1, max));
  const r = await mfetch(`${BASE}/messages?$search=${encodeURIComponent(`"${query}"`)}&$top=${top}&$select=${LIST_SELECT}`, {}, account);
  if (!r.ok) {
    throw new Error(`Graph search failed: ${r.status} ${(await r.text().catch(() => "")).slice(0, 160)}`);
  }
  const j = await r.json() as { value?: GraphMessageRaw[] };
  return (j.value ?? []).map((m) => toGmailMessage(m));
}

// ── Inbox rules (Outlook's analogue of Gmail filters) ──────────────────────────────────────────
//
// GENUINELY DIFFERENT MODEL. Gmail filters tag/untag messages with labels; Outlook inbox rules are
// folder-destination rules (move to X, optionally mark read) — there is no label concept to add or
// remove at all. There is also no Graph equivalent of Gmail's "token lacks gmail.settings.basic,
// needs re-consent" 403: MailboxSettings.ReadWrite is already requested at consent time in
// ms-auth.ts, so a 401/403 from these endpoints just means "refused", not "missing scope, re-auth
// will fix it". `needsConsent` is kept on FilterResult only so callers written against gmail.ts's
// shape (`if (result.needsConsent) ...`) don't crash on this module — that branch simply never
// fires here; it is always false/omitted. This is a deliberate simplification, not an oversight.

export interface GmailFilter {
  id: string;
  from?: string;
  subjectContains?: string;
  /** BEHAVIOR CHANGE: replaces Gmail's addLabelIds — Outlook rules move mail to a folder, they
   *  don't tag it. Holds the destination folder id. */
  moveToFolder?: string;
  /** Nearest analogue to a Gmail filter whose only action was removeLabelIds: ["UNREAD"] — mark
   *  matching mail read without moving it. */
  markAsRead?: boolean;
}

/** Distinguishes nothing, now — see the module note above. Kept only for shape compatibility. */
export interface FilterResult<T> {
  ok: boolean;
  value?: T;
  error?: string;
  needsConsent?: boolean;
}

interface GraphRuleRaw {
  id: string;
  conditions?: { fromAddresses?: GraphEmailAddress[]; subjectContains?: string[] };
  actions?: { moveToFolder?: string; markAsRead?: boolean };
}

export async function listFilters(account: MAccount = "work"): Promise<FilterResult<GmailFilter[]>> {
  const r = await mfetch(`${BASE}/mailFolders/inbox/messageRules`, {}, account);
  if (!r.ok) return { ok: false, error: `${r.status} ${(await r.text().catch(() => "")).slice(0, 160)}` };
  const j = await r.json() as { value?: GraphRuleRaw[] };
  return {
    ok: true,
    value: (j.value ?? []).map((rule) => ({
      id: rule.id,
      from: rule.conditions?.fromAddresses?.[0]?.emailAddress?.address,
      subjectContains: rule.conditions?.subjectContains?.[0],
      moveToFolder: rule.actions?.moveToFolder,
      markAsRead: rule.actions?.markAsRead,
    })),
  };
}

/**
 * Create a server-side inbox rule.
 *
 * Deliberately never sets a delete action — same discipline as the Gmail original: the strongest
 * action available here is move-to-folder plus mark-read, never destroy. `criteria.query` has no
 * Graph analogue (inbox rules have no free-text search condition) and is silently ignored; a caller
 * relying on it needs a follow-up fix, same as the searchMessages note above.
 */
export async function createFilter(
  criteria: { from?: string; subject?: string; query?: string },
  action: { moveToFolder?: string; markAsRead?: boolean },
  account: MAccount = "work",
): Promise<FilterResult<string>> {
  const body = {
    displayName: `clara-${Date.now().toString(36)}`,
    sequence: 1,
    isEnabled: true,
    conditions: {
      ...(criteria.from ? { fromAddresses: [{ emailAddress: { address: criteria.from } }] } : {}),
      ...(criteria.subject ? { subjectContains: [criteria.subject] } : {}),
    },
    actions: {
      ...(action.moveToFolder ? { moveToFolder: action.moveToFolder } : {}),
      ...(action.markAsRead ? { markAsRead: true } : {}),
      stopProcessingRules: false,
    },
  };
  const r = await mfetch(`${BASE}/mailFolders/inbox/messageRules`, { method: "POST", body: JSON.stringify(body) }, account);
  if (!r.ok) return { ok: false, error: `${r.status} ${(await r.text().catch(() => "")).slice(0, 160)}` };
  const j = await r.json() as { id: string };
  return { ok: true, value: j.id };
}

export async function deleteFilter(id: string, account: MAccount = "work"): Promise<FilterResult<true>> {
  const r = await mfetch(`${BASE}/mailFolders/inbox/messageRules/${encodeURIComponent(id)}`, { method: "DELETE" }, account);
  if (r.ok || r.status === 204) return { ok: true, value: true };
  return { ok: false, error: `${r.status} ${(await r.text().catch(() => "")).slice(0, 160)}` };
}

/** BEHAVIOR CHANGE: same label-vs-folder gap as archive() above — `labelId` must be a Graph folder
 *  id here, not a Gmail label id. Also returns `newId` for the same reason archive() does: the
 *  move reassigns the message's id, and inboxZero.ts chains addLabel then archive on one id. */
export async function addLabel(id: string, labelId: string, account: MAccount = "work"): Promise<{ ok: boolean; newId?: string }> {
  const r = await mfetch(`${BASE}/messages/${id}/move`, { method: "POST", body: JSON.stringify({ destinationId: labelId }) }, account);
  if (!r.ok) return { ok: false };
  const j = await r.json().catch(() => ({})) as { id?: string };
  return { ok: true, newId: j.id };
}

/**
 * Create an Outlook DRAFT (never sends) — the owner reviews and sends, same contract as the Gmail
 * original. Used by the client-email triage flow: CLARA drafts, the owner sends.
 *
 * SIMPLER THAN GMAIL, NOT LOSSIER. Every caller of this function in this codebase passes a bare
 * to/subject/body plus an RFC822 Message-ID string in inReplyTo/references — never the Graph
 * message id of the original — so POST /messages/{id}/createReply (which needs that Graph id, and
 * would be the better choice when it's available) isn't usable here. This instead builds a
 * structured JSON draft directly via POST /me/messages. Graph takes a JSON object, not raw MIME, so
 * there's no RFC2822 header assembly, blank-line-before-body footgun, or base64url encoding to get
 * right at all — a whole class of bugs the Gmail version had to work around simply doesn't exist on
 * this path.
 *
 * input.threadId (Gmail threadId / Graph conversationId) cannot be forced onto a freshly created
 * message — Graph/Exchange assigns conversationId from subject + participant matching, not from a
 * caller-supplied value. It's accepted here only for shape compatibility and has no effect.
 */
export async function createReplyDraft(input: {
  to: string; subject: string; body: string; cc?: string; threadId?: string; inReplyTo?: string; references?: string;
}, account: MAccount = "work"): Promise<{ ok: boolean; id?: string; error?: string }> {
  const internetMessageHeaders: { name: string; value: string }[] = [];
  if (input.inReplyTo) internetMessageHeaders.push({ name: "In-Reply-To", value: input.inReplyTo });
  if (input.references) internetMessageHeaders.push({ name: "References", value: input.references });
  const message: Record<string, unknown> = {
    subject: input.subject,
    body: { contentType: "Text", content: input.body },
    toRecipients: [{ emailAddress: { address: input.to } }],
    ...(input.cc ? { ccRecipients: [{ emailAddress: { address: input.cc } }] } : {}),
    ...(internetMessageHeaders.length ? { internetMessageHeaders } : {}),
  };
  const r = await mfetch(`${BASE}/messages`, { method: "POST", body: JSON.stringify(message) }, account);
  if (!r.ok) return { ok: false, error: `draft ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}` };
  const j = await r.json() as { id: string };
  return { ok: true, id: j.id };
}

/**
 * Send mail from the work account.
 *
 * ID RECOVERY. A plain POST /sendMail returns 202 No Content — no message id, no conversationId.
 * Two real callers (src/lib/clara/portal/triage.ts, src/lib/clara/portal/routingClarifyWatch.ts)
 * read the returned `threadId` back off a successful send and persist it as `emailThreadId`,
 * feeding it into a LATER sendMail call to keep a ticket's email follow-ups linked; mail-send.ts
 * also surfaces the returned `id` as an approval receipt. An honest `{ id: undefined }` would
 * silently break both. So instead of calling /sendMail directly, this creates the message as a
 * draft via POST /me/messages (which returns the real id + conversationId in the response), then
 * sends that exact draft via POST /messages/{id}/send. One extra round trip versus Gmail's
 * single-call send, in exchange for getting a real id and conversationId back.
 *
 * Note on input.threadId: unlike Gmail's `raw + threadId` trick, Graph gives no way to force a new
 * message onto an existing conversationId — Exchange assigns it from subject + participant
 * matching on its own. Passing input.threadId here has no effect on Graph's own threading; the
 * conversationId this function returns is whatever Graph decides for the new message, which may or
 * may not land in the conversation the caller thought it was continuing.
 *
 * BEHAVIOR CHANGE: Graph supports exactly ONE body content type per message — there is no Graph
 * equivalent of Gmail's multipart/alternative text+HTML send. When input.html is set, this sends
 * HTML ONLY and drops the plain-text alternative entirely. Intentional simplification, not a bug.
 *
 * Preserves the owner-CC policy (withOwnerCc/OWNER_WORK_EMAIL) and the X-Clara-Notify/X-Agent
 * self-sent-mail stamping unchanged from the Gmail version — those come from ./owner, ./ownerCc,
 * ./config verbatim. The stamps are set via Graph's internetMessageHeaders instead of hand-built
 * MIME header lines.
 */
export async function sendMail(input: {
  to: string; subject: string; body: string; cc?: string; inReplyTo?: string; references?: string;
  /** No effect on Graph's own conversationId assignment — see note above. Kept for call-shape compatibility. */
  threadId?: string;
  /** Extra headers, e.g. { "X-Clara-Notify": "1" }, stamped via internetMessageHeaders. */
  headers?: Record<string, string>;
  /** Optional HTML body. When set, sent HTML-only (see BEHAVIOR CHANGE above) — `body` is dropped, not attached as an alternative. */
  html?: string;
}, account: MAccount = "work"): Promise<{ ok: boolean; id?: string; threadId?: string; error?: string }> {
  // Owner rule (2026-09-15): the owner is CC'd on every email CLARA sends — see ownerCc.ts.
  const { withOwnerCc } = await import("./ownerCc");
  const { OWNER_WORK_EMAIL } = await import("./owner");
  const cc = withOwnerCc(input.to, input.cc, OWNER_WORK_EMAIL);

  // Anything addressed to a principal is Clara's own outbound mail landing in the inbox she reads
  // commands from. Stamp it so emailCommands recognises it instead of refusing it for the DMARC
  // verdict self-sent mail can never have (same reasoning as the Gmail version, 2026-09-24).
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

  const internetMessageHeaders: { name: string; value: string }[] = Object.entries(headers).map(([name, value]) => ({
    name,
    value: value.replace(/[\r\n]+/g, " "),
  }));
  if (input.inReplyTo) internetMessageHeaders.push({ name: "In-Reply-To", value: input.inReplyTo });
  if (input.references) internetMessageHeaders.push({ name: "References", value: input.references });

  const message: Record<string, unknown> = {
    subject: input.subject,
    body: input.html ? { contentType: "HTML", content: input.html } : { contentType: "Text", content: input.body },
    toRecipients: [{ emailAddress: { address: input.to } }],
    ...(cc ? { ccRecipients: [{ emailAddress: { address: cc } }] } : {}),
    ...(internetMessageHeaders.length ? { internetMessageHeaders } : {}),
  };

  const create = await mfetch(`${BASE}/messages`, { method: "POST", body: JSON.stringify(message) }, account);
  if (!create.ok) return { ok: false, error: `create ${create.status}: ${(await create.text().catch(() => "")).slice(0, 200)}` };
  const created = await create.json() as { id: string; conversationId?: string };

  const sent = await mfetch(`${BASE}/messages/${created.id}/send`, { method: "POST" }, account);
  if (!sent.ok) return { ok: false, error: `send ${sent.status}: ${(await sent.text().catch(() => "")).slice(0, 200)}` };

  return { ok: true, id: created.id, threadId: created.conversationId };
}
