// Clara — email as a command channel.
//
// The owner can text her, call her, and talk to her in the UI, and all three reach the intent router.
// Email was the one channel with no inbound command path at all: she READ mail to triage it, and
// that was the end of it. "Clara, book Casey Thursday" sent by email did nothing.
//
// SECURITY IS THE WHOLE DESIGN HERE, because unlike the other three channels, anybody in the world
// can put a message in this inbox. SMS has a phone number Twilio verifies; voice has a caller ID;
// the UI is behind a session. Email has a From header, which is a string anyone can type.
//
// So this fails closed, three times over:
//
//   1. THE SENDER MUST BE A PRINCIPAL. The owner, by address, via principals.ts.
//   2. DMARC MUST PASS. Gmail records the verdict in `Authentication-Results`. Without an explicit
//      dmarc=pass the message is refused — no header, no verdict, unparseable verdict, all refused.
//      This is the check that makes (1) mean anything: a From header alone is trivially forged, and
//      an attacker who can forge the owner's address gets the owner's full tier-1 authority.
//   3. THE BODY IS DATA, NEVER INSTRUCTIONS. Forwarded content especially — "deal with this" on top
//      of a forwarded vendor email must not let the vendor's text issue commands. The quoted section
//      is stripped before routing, and what remains is screened by injection.ts.
//
// Every refusal is ledgered. A channel that silently ignores things is indistinguishable from a
// broken one, and this is the channel where "it didn't do anything" is the expected symptom of both
// an attack and an outage.
//
// NOTHING HERE SENDS ON ITS OWN AUTHORITY. The router's normal gates apply unchanged: reversible
// work runs, anything outbound or irreversible queues for a confirmation the owner gives by text.
//
// A CONSEQUENCE OF CHECK 2 WORTH STATING PLAINLY (2026-09-24): Clara reads the SAME mailbox she
// sends from. Mail the owner's address sends to the owner's address never leaves Google, so Gmail records no
// DMARC verdict for it and it can never pass check 2. Every brief, digest and reply Clara emails them
// therefore looks like a refused command unless it is recognised as her own (isClaraNotification:
// X-Clara-Notify / X-Agent headers, or self-addressed). Those are marked read, labelled
// Clara/Notifications and excluded from the next search. A refused id is remembered in
// email-commands-refused.json so it is refused ONCE, not every tick for a day. Practical upshot:
// for the owner to command Clara by email they must write from a DIFFERENT principal address than the one
// she sends from; until one exists this channel is effectively receive-only.

import { searchMessages, fetchMessageFull, markRead, addLabel, ensureLabel, sendMail, type GmailFullMessage } from "./ms-mail";
import { resolveByEmail } from "./principals";
import { detectPromptInjection } from "./injection";
import { append as ledgerAppend } from "./ledger";
import { appendMessage, recentMessagesFor } from "./messages";
import { isClaraNotification, redactAddress } from "./mailFilters";
import { loadConfig } from "./config";
import { promises as fs } from "node:fs";
import path from "node:path";

/** Mail Clara has already acted on. Visible in Gmail so the trail is inspectable without her. */
export const HANDLED_LABEL = "Clara/Commands";
/** Clara's own outbound mail to the owner (briefs, digests, replies), filed out of the command scan. */
export const NOTIFY_LABEL = "Clara/Notifications";

const REFUSED_TTL_MS = 2 * 24 * 3600_000;
type RefusedIndex = Record<string, string>; // messageId → ISO ts of the refusal

async function refusedFile(): Promise<string> {
  const cfg = await loadConfig();
  await fs.mkdir(cfg.dataDir, { recursive: true });
  return path.join(cfg.dataDir, "email-commands-refused.json");
}
/** Ids refused within the TTL. Pruned on read so the file never grows past two days of mail. */
export async function loadRefusedIndex(now = Date.now()): Promise<RefusedIndex> {
  try {
    const raw = JSON.parse(await fs.readFile(await refusedFile(), "utf8")) as RefusedIndex;
    const out: RefusedIndex = {};
    for (const [id, ts] of Object.entries(raw ?? {})) if (now - Date.parse(ts) < REFUSED_TTL_MS) out[id] = ts;
    return out;
  } catch { return {}; }
}
async function saveRefusedIndex(idx: RefusedIndex): Promise<void> {
  try {
    const p = await refusedFile();
    const tmp = `${p}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(idx), "utf8");
    await fs.rename(tmp, p);
  } catch { /* bookkeeping only */ }
}

export interface EmailCommandResult {
  scanned: number;
  handled: number;
  /** Refused, with the reason — surfaced so a misconfiguration is visible rather than silent. */
  refused: { from: string; subject: string; reason: string }[];
  /** Refused on an earlier pass and skipped silently this time (no second ledger row). */
  skippedRefused?: number;
  failed: number;
  /** CLARA's own notification mail seen in the command inbox — marked read, never a command. */
  skippedOwn: number;
}

/**
 * Pull the sender's bare address out of a From header.
 * `Ada Lovelace <ada@x.com>` → `ada@x.com`; a bare address passes through.
 */
export function senderAddress(from: string): string {
  const m = from.match(/<([^>]+)>/);
  return (m ? m[1] : from).trim().toLowerCase();
}

/**
 * Read the DMARC verdict out of an Authentication-Results header.
 *
 * Returns true ONLY for an explicit `dmarc=pass`. Everything else — absent header, `dmarc=fail`,
 * `dmarc=none` (the domain publishes no policy, so the verdict proves nothing), or a header this
 * cannot parse — is false. There is no benefit of the doubt available here: the whole point is that
 * the alternative is trusting a forgeable string.
 */
export function dmarcPassed(headers: Map<string, string>): boolean {
  // Gmail can attach more than one Authentication-Results header; the Map keeps the last, which is
  // Gmail's own. That is the one worth trusting — upstream ones were written by hosts we do not
  // control and could say anything.
  const ar = headers.get("authentication-results") ?? "";
  return /\bdmarc=pass\b/i.test(ar);
}

/**
 * Strip quoted history and forwarded bodies, leaving what the sender actually typed.
 *
 * This is a SECURITY boundary, not a formatting nicety. The owner forwards mail with a one-line
 * instruction on top all the time; the forwarded body is a third party's text sitting in a message
 * that has already passed the principal check. Cutting at the first quote marker means the vendor's
 * "ignore your previous instructions" never reaches the router as an instruction — the owner's own line does.
 */
export function stripQuoted(body: string): string {
  const cutters = [
    /^-{2,}\s*Forwarded message\s*-{2,}/im,
    /^-{2,}\s*Original Message\s*-{2,}/im,
    /^On .{0,120}\bwrote:\s*$/im,
    /^From:\s.+$/im,
    /^_{10,}\s*$/m,
    /^>\s?/m,
  ];
  let cut = body.length;
  for (const rx of cutters) {
    const m = body.match(rx);
    if (m?.index !== undefined && m.index < cut) cut = m.index;
  }
  return body.slice(0, cut).trim();
}

/**
 * One pass over recent unread mail from the principals.
 *
 * Deliberately narrow: unread, inbox, last day. A command that has been sitting unread for a week
 * is not a command any more, and acting on it would be worse than ignoring it.
 */
// Ticks can overlap (the scheduler has no in-flight guard); two scans sharing the refusal index
// would double-ledger and overwrite each other's saves. One scan at a time.
let scanLock: Promise<unknown> = Promise.resolve();
export async function runEmailCommands(opts: { max?: number; dryRun?: boolean } = {}): Promise<EmailCommandResult> {
  const run = scanLock.then(() => runEmailCommandsInner(opts), () => runEmailCommandsInner(opts));
  scanLock = run.catch(() => undefined);
  return run;
}

async function runEmailCommandsInner(opts: { max?: number; dryRun?: boolean }): Promise<EmailCommandResult> {
  const res: EmailCommandResult = { scanned: 0, handled: 0, refused: [], failed: 0, skippedOwn: 0, skippedRefused: 0 };
  const principalEmails = (await loadConfig()).principals.owner.emails;

  // The address filter is a cheap pre-filter for the API call, NOT a security control — `from:` is
  // matched against the same forgeable header. The real checks are below, on every message.
  // Clara's own notifications are labelled out of the scan once seen (see header note).
  const msgs = await searchMessages(`is:unread in:inbox newer_than:1d -label:${NOTIFY_LABEL}`, Math.min(25, opts.max ?? 10));
  res.scanned = msgs.length;
  if (!msgs.length) return res;

  const labelId = opts.dryRun ? null : await ensureLabel(HANDLED_LABEL).catch(() => null);
  const notifyLabelId = opts.dryRun ? null : await ensureLabel(NOTIFY_LABEL).catch(() => null);
  const refusedIdx = await loadRefusedIndex();
  let refusedDirty = false;

  for (const stub of msgs) {
    const addr = senderAddress(stub.from);
    // Cheapest check first, and it discards the overwhelming majority: ordinary mail is not from a
    // principal. No ledger row for these — every newsletter in the inbox would generate one.
    const principal = await resolveByEmail(addr).catch(() => null);
    if (!principal) continue;

    const full: GmailFullMessage | null = await fetchMessageFull(stub.id).catch(() => null);
    if (!full) { res.failed++; continue; }

    // CLARA's own digest/notify mail lands in the very inbox she reads commands from, FROM the owner's
    // address, and has no DMARC verdict to show — so it was refused on every tick, forever. Not a
    // command, not an attack: mark it read (delivery already happened when it was sent) and move on.
    // Provenance first: the notification headers and the self-addressed shape are as forgeable as
    // From. Only mail Gmail itself marks as SENT from this mailbox (or that passed DMARC) may take
    // the quiet path; a forged look-alike falls through to the refusal below and stays visible.
    const trustedProvenance = (full.labelIds ?? []).includes("SENT") || dmarcPassed(full.headers);
    if (trustedProvenance && isClaraNotification({ from: full.from, subject: full.subject, headers: full.headers, to: full.headers.get("to") }, principalEmails)) {
      if (!opts.dryRun) {
        await markRead(full.id).catch(() => {});
        if (notifyLabelId) await addLabel(full.id, notifyLabelId).catch(() => {});
      }
      res.skippedOwn++;
      continue;
    }

    // Refused once already: it is still unread on purpose (the owner should see it), but a second pass
    // must not ledger it again — that loop produced ~700 rows a day.
    if (refusedIdx[full.id]) { res.skippedRefused = (res.skippedRefused ?? 0) + 1; continue; }

    const refuse = async (reason: string) => {
      res.refused.push({ from: addr, subject: full.subject, reason });
      try {
        await ledgerAppend({
          kind: "action", actor: "clara",
          what: `email command REFUSED from ${redactAddress(addr)} re "${full.subject.slice(0, 80)}" — ${reason}`,
          meta: { channel: "email", refused: reason, subject: full.subject.slice(0, 120), messageId: full.id },
        });
      } catch {
        return; // not recorded → the next pass ledgers it; recording without a ledger row would hide it
      }
      refusedIdx[full.id] = new Date().toISOString();
      refusedDirty = true;
    };

    // Check 2. This is the one that makes the principal check mean anything. Mail Gmail itself
    // marks SENT from this mailbox (the owner replying to their own brief) is authentic by construction:
    // no DMARC verdict exists for it, and none is needed.
    if (!dmarcPassed(full.headers) && !trustedProvenance) {
      await refuse("DMARC did not pass — the sender address could be forged");
      // Left UNREAD on purpose. A refused message is something the owner should see with their own eyes;
      // marking it read would hide a possible impersonation attempt in their archive.
      continue;
    }

    const instruction = stripQuoted(full.body);
    if (!instruction) {
      await refuse("nothing outside the quoted section — no instruction to act on");
      continue;
    }

    // Check 3. The quoted body is already gone; this catches an injection typed into, or pasted
    // above, the visible part.
    const verdict = detectPromptInjection(instruction);
    if (verdict.triggered) {
      await refuse(`prompt-injection pattern in the message body (${verdict.reasons.join(", ")})`);
      continue;
    }

    if (opts.dryRun) { res.handled++; continue; }

    try {
      // Reply threading fields, shared by the decision path and the router path below.
      const messageId = full.headers.get("message-id") ?? "";
      const refs = [full.headers.get("references") ?? "", messageId].filter(Boolean).join(" ");
      const subject = /^re:/i.test(full.subject) ? full.subject : `Re: ${full.subject}`;

      // A reply to a question Clara asked (the brief's "Questions for you", or a same-day ask) is a
      // decision, possibly several: "yes to the Acme Co report; hold the Initech budget bump". Resolved
      // before the router (decisionReply.ts) so a yes is never paraphrased.
      const { tryHandleDecisionReply } = await import("./decisionReply");
      const decided = await tryHandleDecisionReply(instruction, { channel: "email", from: addr, requestRef: full.id }).catch(() => null);
      if (decided !== null) {
        await sendMail({ to: addr, subject, body: decided, inReplyTo: messageId || undefined, references: refs || undefined });
        await appendMessage("user", instruction, undefined, { channel: "email", from: addr, principal: true }).catch(() => {});
        await markRead(full.id).catch(() => {});
        if (labelId) await addLabel(full.id, labelId).catch(() => {});
        res.handled++;
        await ledgerAppend({ kind: "action", actor: "clara", what: `email decision from ${addr}: "${instruction.slice(0, 80)}" → ${decided.slice(0, 120)}`, meta: { channel: "email", messageId: full.id } }).catch(() => {});
        continue;
      }

      // Cross-channel owner memory (ownerTurn.ts): the router gets the owner's recent turns from every
      // surface as real history — the inlined per-address block this replaced predates the router
      // having a history parameter at all.
      const { ownerTurn } = await import("./ownerTurn");
      const { outcome } = await ownerTurn({ channel: "email", from: addr, text: `${principal.displayName}'s email:\n${instruction}`, requestRef: full.id });

      // Reply in the same thread so the answer lands under the question. In-Reply-To/References is
      // what makes a mail client thread it; without them the reply reads as an unrelated message.
      await sendMail({
        to: addr,
        subject,
        body: outcome.reply,
        inReplyTo: messageId || undefined,
        references: refs || undefined,
      });
      await appendMessage("user", instruction, undefined, { channel: "email", from: addr, principal: true }).catch(() => {});
      await appendMessage("clara", outcome.reply, undefined, { channel: "email", from: addr, principal: true }).catch(() => {});

      await markRead(full.id).catch(() => {});
      if (labelId) await addLabel(full.id, labelId).catch(() => {});
      res.handled++;

      await ledgerAppend({
        kind: "action", actor: "clara",
        what: `email command from ${addr}: "${instruction.slice(0, 120)}" → ${outcome.calls.length} tool(s)${outcome.failed ? " (ROUTER FAILED)" : ""}`,
        meta: {
          channel: "email",
          tools: outcome.calls.map((c) => c.name),
          failed: outcome.failed,
          messageId: full.id,
        },
      }).catch(() => {});
    } catch (e) {
      res.failed++;
      await ledgerAppend({
        kind: "action", actor: "clara",
        what: `email command FAILED from ${addr}: ${String(e).slice(0, 200)}`,
        meta: { channel: "email", messageId: full.id },
      }).catch(() => {});
    }
  }

  if (refusedDirty && !opts.dryRun) await saveRefusedIndex(refusedIdx);
  return res;
}

/** One-line summary for the scheduler log and the brief. */
export function summarizeEmailCommands(r: EmailCommandResult): string {
  const bits = [`${r.handled} handled of ${r.scanned} scanned`];
  if (r.refused.length) bits.push(`${r.refused.length} refused (${r.refused.map((x) => x.reason.split(" —")[0]).join("; ")})`);
  if (r.skippedOwn) bits.push(`${r.skippedOwn} own notification(s) skipped`);
  if (r.skippedRefused) bits.push(`${r.skippedRefused} previously refused skipped`);
  if (r.failed) bits.push(`⚠ ${r.failed} FAILED`);
  return `Email commands: ${bits.join(", ")}.`;
}
