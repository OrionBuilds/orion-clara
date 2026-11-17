// Clara — subscription inventory and unsubscribing, the safe way.
//
// The sweep already archives bulk mail and counts what it saw ("25 newsletters worth
// unsubscribing from"), but it flags and never acts, and it reports only a NUMBER — the senders
// themselves stayed inside the result object and never reached anyone. So the owner could see that
// 25 subscriptions were worth leaving and had no way to find out which 25.
//
// HOW UNSUBSCRIBING IS DONE HERE, and why it isn't just clicking the link.
//
// Clicking the unsubscribe link in a message body is the obvious implementation and a bad one. The
// link is sender-controlled HTML: for a spammer it confirms a live human reads this address, and
// for anyone it can be a tracker or a redirect. That is why inboxZero.ts refuses to do it and says
// so in its report.
//
// The correct mechanism already exists in the standard. Legitimate bulk senders are REQUIRED to
// carry a `List-Unsubscribe` header, and RFC 8058 defines a one-click form: when the message also
// carries `List-Unsubscribe-Post: List-Unsubscribe=One-Click`, a plain POST to the https URL in
// that header unsubscribes with no page load, no JavaScript, and nothing sender-controlled being
// rendered. Mail that lacks the header is exactly the mail nobody should be clicking anyway — so
// "does this have a List-Unsubscribe header" doubles as a decent legitimacy filter.
//
// Order of preference, most to least safe:
//   1. RFC 8058 one-click POST  — no rendering, no navigation, no token in a URL bar.
//   2. mailto:                  — send a plain unsubscribe email. Outbound, so it confirms the
//                                 address is live; only used when there is no one-click option.
//   3. nothing                  — reported as "manual", with the URL shown so the owner can decide.
//      An http link is NEVER auto-opened.

// GRAPH REWRITE, not a mechanical import swap. Gmail's query language (`label:Clara/Newsletter OR
// category:promotions OR category:updates`) and its Promotions/Updates auto-categorization have
// no Graph equivalent — Outlook does no such ML categorization at all. The replacement source is
// Clara's OWN "Clara/Newsletter" mail folder (the same one inboxZero.ts already files bulk mail
// into) rather than an approximation of Gmail's categories — this is actually a better-grounded
// signal, not a degraded one, since it's mail Clara has already positively classified herself
// rather than mail Google guessed about. List-Unsubscribe is read via internetMessageHeaders, the
// same mechanism ms-mail.ts's fetchMessageFull uses for Authentication-Results.
import { mfetch, type MAccount } from "./ms-auth";
import { sendMail, ensureLabel } from "./ms-mail";
import { append as ledgerAppend } from "./ledger";

const BASE = "https://graph.microsoft.com/v1.0/me";

export interface UnsubMethod {
  /** RFC 8058 one-click endpoint — the preferred path. */
  oneClick?: string;
  /** mailto: address (with any subject) parsed out of the header. */
  mailto?: { to: string; subject?: string };
  /** A plain https link with no one-click support. Reported, never auto-opened. */
  http?: string;
}

export interface SubscriptionGroup {
  /** Bare email address of the sender — the grouping key. */
  sender: string;
  /** Display name, when the From header carried one. */
  name: string;
  /** How many messages from this sender in the scanned window. */
  count: number;
  /** Most recent subject, so the owner can recognise it. */
  lastSubject: string;
  method: UnsubMethod;
  /** True when we can act without the owner opening anything. */
  actionable: boolean;
}

function addressOf(from: string): { email: string; name: string } {
  const m = from.match(/^\s*"?([^"<]*)"?\s*<([^>]+)>/);
  if (m) return { name: m[1].trim(), email: m[2].trim().toLowerCase() };
  return { name: "", email: from.trim().toLowerCase() };
}

/**
 * Parse a List-Unsubscribe header. The format is one or more angle-bracketed URIs, comma
 * separated: `<mailto:x@y.com?subject=unsub>, <https://…>`.
 */
export function parseUnsubHeader(header: string, postHeader: string | undefined): UnsubMethod {
  const out: UnsubMethod = {};
  const uris = [...header.matchAll(/<([^>]+)>/g)].map((m) => m[1].trim());
  // RFC 8058: one-click is only valid when the POST header is present AND there is an https URI.
  const oneClickAllowed = /one-?click/i.test(postHeader ?? "");

  for (const uri of uris) {
    if (uri.toLowerCase().startsWith("mailto:")) {
      const withoutScheme = uri.slice(7);
      const [to, query] = withoutScheme.split("?");
      const subject = new URLSearchParams(query ?? "").get("subject") ?? undefined;
      if (to) out.mailto = { to: to.trim(), subject: subject ?? undefined };
    } else if (/^https:\/\//i.test(uri)) {
      // http:// is deliberately not accepted — an unsubscribe that travels in clear text is not
      // one we should be making on the owner's behalf.
      if (oneClickAllowed) out.oneClick = uri;
      else out.http = uri;
    }
  }
  return out;
}

async function headersFor(id: string, account: MAccount): Promise<Map<string, string> | null> {
  const r = await mfetch(
    `${BASE}/messages/${encodeURIComponent(id)}?$select=subject,from,receivedDateTime,internetMessageHeaders`,
    {}, account,
  );
  if (!r.ok) return null;
  const j = await r.json() as {
    subject?: string;
    from?: { emailAddress?: { name?: string; address?: string } };
    internetMessageHeaders?: { name: string; value: string }[];
  };
  const h = new Map<string, string>();
  for (const { name, value } of j.internetMessageHeaders ?? []) h.set(name.toLowerCase(), value);
  // internetMessageHeaders can omit the structured From/Subject Graph already gives us directly
  // (and does, reliably, unlike the raw header which may be absent on some transport paths) — seed
  // those from the structured fields so addressOf()/h.get("subject") below keep working unchanged.
  if (j.subject && !h.has("subject")) h.set("subject", j.subject);
  const from = j.from?.emailAddress;
  if (from?.address && !h.has("from")) h.set("from", from.name ? `${from.name} <${from.address}>` : from.address);
  return h;
}

/**
 * Inventory the owner's subscriptions, grouped by sender and ranked by volume.
 *
 * Scans mail already known to be bulk — Clara's own "Clara/Newsletter" folder, the same one
 * inboxZero.ts files newsletter/promo mail into — rather than the whole mailbox, because that
 * population is what actually carries List-Unsubscribe headers and it keeps header fetches
 * bounded. (No Promotions/Updates category here — Outlook has no equivalent auto-categorization;
 * the Newsletter folder is the one population this scan has.)
 */
export async function scanSubscriptions(opts: { max?: number; account?: MAccount } = {}): Promise<SubscriptionGroup[]> {
  const account = opts.account ?? "work";
  const max = Math.min(400, Math.max(1, opts.max ?? 250));

  const folderId = await ensureLabel("Clara/Newsletter", account);
  if (!folderId) return [];

  const ids: string[] = [];
  let url: string | null = `${BASE}/mailFolders/${encodeURIComponent(folderId)}/messages?$top=${Math.min(max, 999)}&$select=id`;
  while (url && ids.length < max) {
    const r = await mfetch(url, {}, account);
    if (!r.ok) throw new Error(`Graph subscription scan failed: ${r.status} ${(await r.text().catch(() => "")).slice(0, 160)}`);
    const j = await r.json() as { value?: { id: string }[]; "@odata.nextLink"?: string };
    ids.push(...(j.value ?? []).map((m) => m.id));
    url = j["@odata.nextLink"] ?? null;
  }
  ids.length = Math.min(ids.length, max);

  const groups = new Map<string, SubscriptionGroup>();
  // Sequential-ish in small batches: a few hundred parallel header fetches will trip Graph's
  // per-user rate limit, and a 429 mid-scan would silently truncate the inventory.
  const BATCH = 12;
  for (let i = 0; i < ids.length; i += BATCH) {
    const chunk = await Promise.all(ids.slice(i, i + BATCH).map((id) => headersFor(id, account)));
    for (const h of chunk) {
      if (!h) continue;
      const listUnsub = h.get("list-unsubscribe");
      // No header means we have no safe way to act, and it is also a signal about the sender.
      if (!listUnsub) continue;
      const { email, name } = addressOf(h.get("from") ?? "");
      if (!email) continue;

      const method = parseUnsubHeader(listUnsub, h.get("list-unsubscribe-post"));
      const existing = groups.get(email);
      if (existing) {
        existing.count++;
        continue;
      }
      groups.set(email, {
        sender: email,
        name: name || email,
        count: 1,
        lastSubject: (h.get("subject") ?? "").slice(0, 90),
        method,
        actionable: Boolean(method.oneClick || method.mailto),
      });
    }
  }

  // Loudest first — that ordering is the actual product. "You got 47 of these last month" is what
  // makes the decision obvious.
  return [...groups.values()].sort((a, b) => b.count - a.count);
}

export interface UnsubResult {
  sender: string;
  ok: boolean;
  via: "one-click" | "mailto" | "manual" | "none";
  detail: string;
}

/**
 * Unsubscribe from ONE sender. Never bulk, never by pattern — the caller has to name it, and the
 * intent router puts this behind a confirmation before it ever gets here.
 */
export async function unsubscribeFrom(group: SubscriptionGroup, account: MAccount = "work"): Promise<UnsubResult> {
  const { sender, method } = group;

  if (method.oneClick) {
    try {
      const r = await fetch(method.oneClick, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "List-Unsubscribe=One-Click",
        signal: AbortSignal.timeout(20_000),
        // Do not follow a redirect chain into arbitrary territory; the POST either works or it
        // doesn't. RFC 8058 endpoints answer 200 directly.
        redirect: "manual",
      });
      const ok = r.status >= 200 && r.status < 400;
      await ledgerAppend({
        kind: "action", actor: "clara",
        what: `unsubscribed from ${sender} via RFC 8058 one-click (${r.status})`,
        meta: { sender, via: "one-click", status: String(r.status) },
      }).catch(() => {});
      return { sender, ok, via: "one-click", detail: ok ? `one-click accepted (${r.status})` : `one-click returned ${r.status}` };
    } catch (e) {
      return { sender, ok: false, via: "one-click", detail: `one-click failed: ${String(e).slice(0, 120)}` };
    }
  }

  if (method.mailto) {
    try {
      await sendMail({
        to: method.mailto.to,
        subject: method.mailto.subject || "unsubscribe",
        body: "Please unsubscribe this address from your mailing list.",
      }, account);
      await ledgerAppend({
        kind: "action", actor: "clara",
        what: `unsubscribed from ${sender} by emailing ${method.mailto.to}`,
        meta: { sender, via: "mailto" },
      }).catch(() => {});
      return { sender, ok: true, via: "mailto", detail: `sent an unsubscribe email to ${method.mailto.to}` };
    } catch (e) {
      return { sender, ok: false, via: "mailto", detail: `unsubscribe email failed: ${String(e).slice(0, 120)}` };
    }
  }

  // An http link with no one-click support is reported, never opened. Opening it would mean
  // rendering sender-controlled content on the owner's behalf, which is the thing this module
  // exists to avoid.
  if (method.http) {
    return { sender, ok: false, via: "manual", detail: `no one-click support — open this yourself if you trust it: ${method.http}` };
  }

  return { sender, ok: false, via: "none", detail: "no usable unsubscribe method in the headers" };
}
