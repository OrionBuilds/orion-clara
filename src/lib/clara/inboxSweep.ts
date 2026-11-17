// Clara — on-demand inbox sweep command ("clean up my inbox").
//
// Deterministic command shared by the Twilio SMS route and /api/chat: matched BEFORE the
// conversational LLM (and, in the SMS route's existing layering, AFTER opt-out/approval/injection
// handling), so the sweep never depends on the model recognizing its own capability. The sweep
// itself is inboxZero.runInboxZero — the exact same triple-gated pass the OS schedule
// `clara.inbox_zero` runs daily at 12:30 — so all of that module's rails apply unchanged:
// markRead/archive/star/label ONLY, per-run mutation cap (50), VIP/family never archived or marked
// read, unsubscribe candidates report-only.
//
// Ledger: runInboxZero already appends one "action" row per REAL pass — this module never writes a
// second success row (that would double-count the sweep in the brief). It only logs its own
// failures.

import { runInboxZero, type InboxZeroOptions, type InboxZeroResult } from "./inboxZero";
import { append as ledgerAppend } from "./ledger";

export const INBOX_SWEEP_ACK = "On it — sweeping your inbox now, results in a minute.";

// Requires a cleanup VERB alongside "inbox" (or the literal "inbox zero"), so ordinary mentions —
// "what's in my inbox?", "any inbox news?" — never start a mutation pass.
const SWEEP_RE = /\b(clean(?:\s*up)?|tidy(?:\s*up)?|zero|sweep)\b.*\binbox\b|\binbox\s*zero\b/i;
// Cheap negation guard: "don't clean up my inbox" is an instruction NOT to sweep.
const NEGATED_RE = /\b(don'?t|do not|never|stop|without)\b[^.?!]*\b(clean|tidy|zero|sweep)\b/i;

export function isInboxSweepCommand(text: string): boolean {
  const t = text.trim();
  return SWEEP_RE.test(t) && !NEGATED_RE.test(t);
}

/**
 * Conversational follow-up for the person who asked — warmer than summarizeInboxZero's log line.
 *
 * This function used to be a quieter version of the very bug the engine works hard to avoid. It
 * opened with the flat headline "Inbox swept." on ANY non-dry run — including one that scanned
 * nothing — and reported only the success counters, dropping `classifyFailed` and
 * `skippedByPolicy` entirely. A pass where the classifier died on all 54 messages read as
 * "Inbox swept. 0 archived, 0 marked read — 54 eligible of 72 unread." Every failure mode this
 * module can have was invisible on the one surface the owner actually reads.
 *
 * It now leads with the problem when there is one, and never claims a sweep happened when nothing
 * was scanned.
 */
export function sweepFollowUp(r: InboxZeroResult): string {
  // Nothing scanned is not a clean mailbox — it is a sweep that found no work, and saying
  // "Inbox swept" over it is the exact false-completion this whole change exists to kill.
  if (!r.dryRun && r.scanned === 0) {
    return "I looked and there was nothing unread to sweep — inbox is already clear. Nothing was changed.";
  }

  const head = r.dryRun
    ? `Dry run — here's what a sweep WOULD do (no changes made): `
    : `Inbox swept. `;
  const counts = [`${r.archived} archived`, `${r.markedRead} marked read`];
  if (r.labeled) counts.push(`${r.labeled} labeled`);
  if (r.starred) counts.push(`${r.starred} VIP starred for visibility`);
  const lines = [`${head}${counts.join(", ")} — ${r.eligible} eligible of ${r.scanned} unread.`];

  if (r.blocked) {
    lines.push(`${r.blocked} from senders you've blocked — archived and marked read (still in All Mail, nothing deleted).`);
  }
  if (r.untouched) {
    lines.push(`${r.untouched} I couldn't confidently place — tagged Clara/Review and left in your inbox.`);
  }
  if (r.tooYoung) {
    lines.push(`${r.tooYoung} arrived in the last 24h — left alone on purpose, they'll be in scope tomorrow.`);
  }
  if (r.unsubscribeCandidates.length) {
    lines.push(`${r.unsubscribeCandidates.length} newsletter${r.unsubscribeCandidates.length === 1 ? "" : "s"} worth unsubscribing from (I flag these, never click the links).`);
  }
  if (r.vipCatchUp.length) {
    lines.push(`${r.vipCatchUp.length} VIP/family email${r.vipCatchUp.length === 1 ? "" : "s"} still waiting on you — left unread on purpose.`);
  }
  if (r.capReached) lines.push(`Hit the per-run safety cap; the rest gets picked up next pass.`);

  // The failure lines go LAST and are unmissable — a reader skimming green counts must not be able
  // to miss that the pass was partly broken.
  if (r.brainFailedBatches) {
    lines.push(`⚠ ${r.brainFailedBatches} batch${r.brainFailedBatches === 1 ? "" : "es"} couldn't reach a model for the second-pass read, so that mail stayed in Review unexamined.`);
  }
  if (r.classifyFailed) {
    lines.push(`⚠ ${r.classifyFailed} couldn't be classified at all, so they weren't triaged — usually the local model being down.`);
  }
  if (r.mutationFailed) {
    lines.push(`⚠ ${r.mutationFailed} Gmail write${r.mutationFailed === 1 ? "" : "s"} FAILED — the counts above are lower than the work I tried to do. Usually an expired token.`);
  }
  const policy = Object.entries(r.skippedByPolicy).map(([k, n]) => `${k}×${n}`).join(", ");
  if (policy) lines.push(`Skipped by policy: ${policy}.`);

  return lines.join(" ");
}

/** Awaitable core — runs the pass and returns the human follow-up. Exposed for tests/smoke runs. */
export async function runInboxSweep(opts: InboxZeroOptions = {}): Promise<string> {
  return sweepFollowUp(await runInboxZero(opts));
}

/**
 * Fire-and-forget wrapper for the conversational surfaces: caller sends the ACK first, then this
 * runs the real pass detached and delivers the follow-up (or an apology) via the surface's own
 * `deliver`. Errors are logged and reported — never silent.
 */
export function startInboxSweepDetached(deliver: (msg: string) => Promise<void>): void {
  void (async () => {
    try {
      await deliver(await runInboxSweep({ dryRun: false }));
    } catch (e) {
      await ledgerAppend({
        kind: "action",
        actor: "clara",
        what: `on-demand inbox sweep FAILED: ${String(e).slice(0, 200)}`,
        meta: { command: "inbox-sweep" },
      }).catch(() => {});
      await deliver("Sorry — the inbox sweep hit an error and didn't finish. I've logged it; ask me to try again in a bit.").catch(() => {});
    }
  })();
}
