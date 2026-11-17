// Clara — Wave 5 inbox-zero pass (OS schedule `clara.inbox_zero`, daily 12:30, shipped mode=off).
//
// A gradual, mutation-capped sweep of unread inbox mail OLDER THAN 24H, driven by triage.ts's
// classifier:
//   newsletter                    → archive + label "Clara/Archived"; listed as an UNSUBSCRIBE
//                                   CANDIDATE (report-only — Clara never clicks unsubscribe links)
//   routine, older than 3 days    → dead scheduling/confirm thread → archive + label
//   routine, 1–3 days old         → uncertain — markRead ONLY (stays in the inbox, just not unread)
//   vip / family                  → NEVER archived or marked read (they stay unread); listed as
//                                   VIP CATCH-UP (report-only). The one gentle touch permitted:
//                                   star (a visibility flag that leaves UNREAD intact) when the
//                                   message is 2+ days old and "star" is in the allowlist.
//   escalate (unknown sender)     → never touched, no exceptions
//   classification error          → never touched (fail-safe)
//
// Every mutation is triple-gated: (1) the schedule row's config.allowed_mutations is a HARD
// filter — a kind not in the list is skipped and counted in skippedByPolicy; (2) a per-run cap
// (config max_mutations, default 50) makes the first pass against a huge backlog gradual;
// (3) dryRun computes the full would-do report without a single Gmail call (ensureLabel included —
// creating a label is a mutation too).

// ── Mutation safety rail ──────────────────────────────────────────────────
// The ONLY mail mutations this module may ever perform are the four kinds the OS schedule
// allowlists: markRead, archive, star, addLabel (plus ensureLabel, the folder-id plumbing that
// addLabel requires). sendMail and any delete/trash helper are deliberately NOT imported —
// enforcement is structural (this import list is the module's entire mail surface) plus the
// compile-time assertion below.
//
// Microsoft Graph migration (see ms-mail.ts): archive()/addLabel() both move the message to a
// different folder, and Graph reassigns the message a NEW id on every move — unlike Gmail, where
// adding/removing a label never changed the id. Every place below that could legitimately chain a
// second mutation onto the same message (block-archive-then-markRead; label-then-archive) now
// tracks a local `id` variable and updates it from `newId` after each successful move, instead of
// reusing the original `m.id`. Skipping this would silently 404 the second call once the token is
// live — see archive()'s doc comment in ms-mail.ts for the concrete case this was caught from.
import { listUnreadInbox, markRead, archive, star, ensureLabel, addLabel } from "./ms-mail";
import { classify, type Verdict } from "./triage";
import { readBlocklist, isBlocked } from "./blocklist";
import { refineVerdicts } from "./mailBrain";
import { append as ledgerAppend } from "./ledger";
import { notifyOwner } from "./notify";

export const MUTATION_KINDS = ["markRead", "archive", "star", "addLabel"] as const;
export type MutationKind = (typeof MUTATION_KINDS)[number];

// Unit-style compile-time assertion (see plan Verification #9): MutationKind must be EXACTLY the
// four allowed names. If anyone widens MUTATION_KINDS (adds "send", "delete", "trash", …) or
// renames a kind, this line stops typechecking — the module fails the build before it can run.
type AllowedUniverse = "markRead" | "archive" | "star" | "addLabel";
const _assertOnlyAllowedMutationKinds: MutationKind extends AllowedUniverse
  ? (AllowedUniverse extends MutationKind ? true : never)
  : never = true;
void _assertOnlyAllowedMutationKinds;

// One taxonomy, four labels (rebuilt 2026-08-03). Previously everything archived landed under a
// single `Clara/Archived`, and `escalate` — the DEFAULT verdict — got no label at all, so the
// largest group of mail was both untouched and invisible.
export const ARCHIVE_LABEL = "Clara/Archived";      // routine dead threads, archived
export const NEWSLETTER_LABEL = "Clara/Newsletter"; // bulk/promotional, archived
export const REVIEW_LABEL = "Clara/Review";         // unclassified — STAYS in the inbox, labeled
export const VIP_LABEL = "Clara/VIP";               // vip/family catch-up — stays unread

const DEFAULT_CAP = 50;
const DEAD_THREAD_DAYS = 3; // routine mail older than this is a dead scheduling thread
const STAR_CATCHUP_DAYS = 2; // vip/family unread this old gets the (optional) star flag

export interface InboxZeroOptions {
  /** The schedule row's config.allowed_mutations — the HARD filter. Unknown names are ignored;
   *  omitted → all four kinds allowed (the module can't do anything else regardless). */
  allowedMutations?: string[];
  /** Max Gmail mutation calls this run (archive + label on one message = 2). Default 50. */
  maxMutations?: number;
  /**
   * How many unread messages to FETCH. Default 100, Gmail's own ceiling is 500.
   *
   * Separate from maxMutations because they bound different things: this bounds how much of the
   * backlog is even looked at, that bounds how much is changed. A scan cap of 100 quietly meant
   * "clear the whole backlog" was impossible however high the mutation cap went.
   */
  maxScan?: number;
  /** True → full classification + would-do counts, ZERO Gmail mutations. */
  dryRun?: boolean;
}

export interface InboxZeroResult {
  dryRun: boolean;
  scanned: number;      // unread inbox messages fetched
  eligible: number;     // of those, older than 24h (the only ones this pass may act on)
  archived: number;
  markedRead: number;
  starred: number;
  labeled: number;
  /**
   * Eligible mail the classifier could not confidently place (verdict `escalate`) — labeled
   * Clara/Review and left in the inbox.
   *
   * Does NOT include messages skipped for being under 24h; those are `tooYoung`. The two were the
   * same counter until a dry run reported "103 I couldn't place" for a mailbox where 26 of them
   * were simply recent. Conflating "I don't understand this" with "this isn't in scope yet"
   * overstates how confused the classifier is and hides how much of the backlog is genuinely stuck.
   */
  untouched: number;
  /** Skipped because they're newer than 24h — out of scope by design, not a failure. */
  tooYoung: number;
  /**
   * Messages left alone because `classify()` THREW, not because a verdict said to leave them.
   *
   * Split out of `untouched` after an audit found the two were indistinguishable: a classifier
   * crash and a deliberate "escalate to the owner" incremented the same counter, so a run where the
   * model was down reported the same numbers as a healthy run that escalated everything. On a task
   * that mutates the owner's real mailbox, "broken" must not be able to look like "working".
   *
   * Non-zero is a defect, not a state — `runInboxZero` alerts on it.
   */
  classifyFailed: number;
  /**
   * Gmail write calls that were attempted and FAILED.
   *
   * `mutate` used to end in `fn().catch(() => false)` — every 403/429/network error was swallowed,
   * incremented nothing, alerted nothing, and still burned a cap slot. A run where all 50 modify
   * calls failed reported "0 archived, 0 marked read" and read as a clean sweep of a tidy mailbox.
   * Same defect `classifyFailed` was created to fix, one layer further down.
   */
  mutationFailed: number;
  /**
   * Messages archived because their sender is on the blocklist.
   *
   * Counted separately from `archived` on purpose. Blocked mail is the one category acted on with
   * NO classification at all, so folding it into the general archive count would hide both how much
   * the blocklist is doing and — if an entry were ever too broad — how much it is eating.
   */
  blocked: number;
  /** Messages the regexes could not place that the LLM second pass DID place. */
  brainRefined: number;
  /** Second-pass batches that could not be classified at all — the model was unreachable. */
  brainFailedBatches: number;
  capReached: boolean;
  /** Mutations skipped because their kind wasn't in allowed_mutations, counted per kind. */
  skippedByPolicy: Record<string, number>;
  /** REPORT-ONLY: newsletters worth unsubscribing from. Surfaced in the brief; never acted on. */
  unsubscribeCandidates: { from: string; subject: string }[];
  /** REPORT-ONLY: vip/family mail still unread after 24h — the owner's catch-up list. */
  vipCatchUp: { from: string; subject: string; ageDays: number }[];
}

function cleanFrom(header: string): string {
  return header.replace(/<.*>/, "").trim() || header.trim();
}

function ageDays(dateHeader: string, nowMs: number): number | null {
  const t = Date.parse(dateHeader);
  if (!Number.isFinite(t)) return null;
  return Math.floor((nowMs - t) / 86_400_000);
}

export async function runInboxZero(opts: InboxZeroOptions = {}): Promise<InboxZeroResult> {
  const dryRun = !!opts.dryRun;
  const cap = Math.max(1, opts.maxMutations ?? DEFAULT_CAP);
  const allowed = new Set<MutationKind>(
    (opts.allowedMutations ?? [...MUTATION_KINDS]).filter((k): k is MutationKind =>
      (MUTATION_KINDS as readonly string[]).includes(k)),
  );

  const res: InboxZeroResult = {
    dryRun, scanned: 0, eligible: 0, archived: 0, markedRead: 0, starred: 0, labeled: 0,
    untouched: 0, tooYoung: 0, classifyFailed: 0, mutationFailed: 0, blocked: 0, brainRefined: 0, brainFailedBatches: 0, capReached: false, skippedByPolicy: {},
    unsubscribeCandidates: [], vipCatchUp: [],
  };

  let used = 0;
  // Single choke point for EVERY mutation: policy filter → cap → dryRun → real call. Returns
  // `{ ok }` when the mutation happened (or would have, in a dry run), plus `newId` when the call
  // was a folder move that reassigned the message's id (archive/addLabel only — see the import
  // comment above). markRead/star never move the message, so they always report `newId: undefined`.
  const mutate = async (kind: MutationKind, fn: () => Promise<{ ok: boolean; newId?: string }>): Promise<{ ok: boolean; newId?: string }> => {
    if (!allowed.has(kind)) {
      res.skippedByPolicy[kind] = (res.skippedByPolicy[kind] ?? 0) + 1;
      return { ok: false };
    }
    if (used >= cap) { res.capReached = true; return { ok: false }; }
    used++;
    if (dryRun) return { ok: true };
    // A failed write is COUNTED, not swallowed. Returning false silently is what let a run where
    // every mail-API call 403'd report itself as a clean sweep.
    const result = await fn().catch(() => ({ ok: false }));
    if (!result.ok) res.mutationFailed++;
    return result;
  };
  /** Wraps the two mutations (markRead/star) that return a bare boolean into the common shape. */
  const boolMutate = (kind: MutationKind, fn: () => Promise<boolean>) => mutate(kind, async () => ({ ok: await fn() }));

  // Label ids resolved lazily, once each, and NEVER in a dry run: ensureLabel creates the label
  // when missing, which is itself a mutation.
  const labelIds = new Map<string, string | null>();
  const getLabelId = async (name: string): Promise<string | null> => {
    if (dryRun) return "(dry-run)";
    if (!labelIds.has(name)) labelIds.set(name, await ensureLabel(name).catch(() => null));
    return labelIds.get(name) ?? null;
  };

  const nowMs = Date.now();
  const msgs = await listUnreadInbox(Math.min(500, Math.max(1, opts.maxScan ?? 100)));
  res.scanned = msgs.length;

  // ── Pass 1: deterministic verdicts ──────────────────────────────────────────────────────────
  // triage.classify() is two regexes plus an address list — free, instant, and correct when it
  // fires. Identity verdicts (vip/family) can ONLY come from here.
  const eligible: { m: typeof msgs[number]; age: number }[] = [];
  const firstPass = new Map<string, Verdict>();

  // Blocked senders, resolved once per run. Empty list is the overwhelmingly common case and costs
  // one file read.
  const blocklist = await readBlocklist().catch(() => []);

  for (const m of msgs) {
    // BEFORE the age gate, deliberately. The 24h rule exists so Clara never touches mail the owner
    // has not had a chance to see — but they have already said they do not want this sender, and the
    // whole point of blocking the fake-Amazon phishing was that it stops showing up. Waiting a day
    // first would mean every blocked message still spends a day in the inbox.
    //
    // Archive + mark read only. Never trashed: phishing is evidence, and a false positive on this
    // path must cost a search rather than a message.
    if (blocklist.length) {
      const hit = isBlocked(m.from, blocklist);
      if (hit) {
        let id = m.id;
        const a = await mutate("archive", () => archive(id));
        if (a.ok) { res.archived++; if (a.newId) id = a.newId; }
        if ((await boolMutate("markRead", () => markRead(id))).ok) res.markedRead++;
        res.blocked++;
        continue;
      }
    }

    const age = ageDays(m.date, nowMs);
    if (age === null || age < 1) { res.tooYoung++; continue; }
    res.eligible++;
    eligible.push({ m, age });
    try {
      firstPass.set(m.id, await classify(m));
    } catch {
      res.classifyFailed++;
    }
  }

  // ── Pass 2: the actual analysis ─────────────────────────────────────────────────────────────
  // Everything the regexes gave up on goes to the model — and ONLY that. On a real mailbox this
  // was 114 of 149 eligible messages: the sweep did exactly what it was written to do and the
  // inbox still looked untouched, because the default verdict was "leave it alone".
  //
  // The model may only move mail from `escalate` toward `newsletter`/`routine`. It can never
  // produce vip/family, and anything it is unsure of stays escalate — see mailBrain.ts.
  const unplaceable = eligible.filter(({ m }) => firstPass.get(m.id) === "escalate").map(({ m }) => m);
  if (unplaceable.length && !dryRun) {
    const brain = await refineVerdicts(unplaceable).catch(() => null);
    if (brain) {
      for (const [id, v] of brain.verdicts) firstPass.set(id, v);
      res.brainRefined = brain.verdicts.size;
      res.brainFailedBatches = brain.failedBatches;
    } else {
      res.brainFailedBatches = Math.ceil(unplaceable.length / 20);
    }
  }

  for (const { m, age } of eligible) {
    const verdict = firstPass.get(m.id);
    // classify() threw for this one in pass 1. Already counted there — never touched, and NOT
    // double-counted here.
    if (!verdict) continue;

    if (verdict === "vip") {
      res.vipCatchUp.push({ from: cleanFrom(m.from), subject: m.subject, ageDays: age });
      // Stays UNREAD, never archived. Star (which does not touch the UNREAD label) flags old
      // catch-up mail for visibility — and only when the allowlist grants "star".
      const vid = await getLabelId(VIP_LABEL);
      let id = m.id;
      if (vid) {
        const a = await mutate("addLabel", () => addLabel(id, vid));
        if (a.ok) { res.labeled++; if (a.newId) id = a.newId; }
      }
      if (age >= STAR_CATCHUP_DAYS && !m.labelIds.includes("STARRED")) {
        if ((await boolMutate("star", () => star(id))).ok) res.starred++;
      }
      continue;
    }

    // `escalate` is the classifier's DEFAULT verdict — anything not from a known VIP/family address
    // and not matching the newsletter or routine patterns lands here. It used to mean "do nothing,
    // count as untouched", which on a typical pass was ~85% of eligible mail: the largest group,
    // silently skipped and invisible in the report. Now it gets labeled and REPORTED while staying
    // in the inbox and staying unread, so it is reviewable rather than lost.
    if (verdict === "escalate") {
      res.untouched++;
      const rid = await getLabelId(REVIEW_LABEL);
      if (rid && (await mutate("addLabel", () => addLabel(m.id, rid))).ok) res.labeled++;
      continue;
    }

    if (verdict === "newsletter" || (verdict === "routine" && age >= DEAD_THREAD_DAYS)) {
      const isNews = verdict === "newsletter";
      if (isNews) res.unsubscribeCandidates.push({ from: cleanFrom(m.from), subject: m.subject });
      const lid = await getLabelId(isNews ? NEWSLETTER_LABEL : ARCHIVE_LABEL);
      // THE confirmed chaining hazard: addLabel moves the message, so archive() below must use
      // the id addLabel came back with, not the original m.id, or it 404s on a message that
      // already moved out from under it.
      let id = m.id;
      if (lid) {
        const a = await mutate("addLabel", () => addLabel(id, lid));
        if (a.ok) { res.labeled++; if (a.newId) id = a.newId; }
      }
      if ((await mutate("archive", () => archive(id))).ok) res.archived++;
      continue;
    }

    // routine, 1–3 days old — uncertain: not clearly dead, not clearly actionable. markRead only,
    // so it leaves the unread pile but stays in the inbox where the owner can still see it.
    if ((await boolMutate("markRead", () => markRead(m.id))).ok) res.markedRead++;
  }

  // The brief's Since-yesterday section reads Clara's ledger — one "action" line per real pass
  // makes the sweep show up there automatically. Dry runs (and shadow-mode OS runs, which run
  // dry) write nothing: a rehearsal is not an action.
  if (!dryRun) {
    await ledgerAppend({
      kind: "action",
      actor: "clara",
      what: `inbox-zero pass: ${res.archived} archived, ${res.markedRead} marked read, ${res.starred} starred (${res.eligible} eligible of ${res.scanned} unread)${res.blocked ? `; ${res.blocked} from blocked sender(s)` : ""}; ${res.unsubscribeCandidates.length} unsubscribe candidate(s), ${res.vipCatchUp.length} VIP catch-up${res.capReached ? "; mutation cap reached — backlog continues next run" : ""}${res.classifyFailed ? `; ${res.classifyFailed} FAILED TO CLASSIFY` : ""}${res.mutationFailed ? `; ${res.mutationFailed} GMAIL WRITE(S) FAILED` : ""}`,
      meta: {
        scanned: res.scanned, eligible: res.eligible, archived: res.archived,
        markedRead: res.markedRead, starred: res.starred, labeled: res.labeled,
        capReached: res.capReached, skippedByPolicy: res.skippedByPolicy,
        classifyFailed: res.classifyFailed, mutationFailed: res.mutationFailed,
      },
    }).catch(() => {});
  }

  // A classifier that cannot classify is a broken sweep wearing a completed sweep's clothes, so it
  // pages rather than sitting in a counter nobody reads. Threshold, not any-failure: one transient
  // timeout in a 60-message pass is noise, but a large share failing means the model is down and
  // the mailbox silently went untriaged. Dry runs page too — a rehearsal that cannot classify tells
  // you exactly as much as a real one that cannot.
  if (res.classifyFailed > 0 && res.eligible > 0) {
    const pct = Math.round((res.classifyFailed / res.eligible) * 100);
    if (pct >= 25) {
      await notifyOwner({
        kind: "inbox.classify_failed",
        priority: "critical",
        text: `📥 Inbox-zero could not classify ${res.classifyFailed} of ${res.eligible} eligible message(s) (${pct}%). Those were left untouched, so nothing was mis-filed — but the mail did NOT get triaged. Usually the local model is down.`,
        dedupeKey: `inboxzero:classifyfail:${new Date().toISOString().slice(0, 10)}`,
      }).catch(() => {});
    }
  }

  // Same reasoning one layer down: a sweep whose Gmail writes are all failing reports small,
  // plausible numbers and looks like a tidy mailbox. Any failure at all is worth saying out loud
  // here — unlike classification, a write failure is never routine noise.
  if (res.mutationFailed > 0 && !dryRun) {
    await notifyOwner({
      kind: "inbox.mutation_failed",
      priority: "critical",
      text: `📥 Inbox-zero: ${res.mutationFailed} Gmail write(s) FAILED this pass (archive/label/read). The counts it reported are lower than the work it tried to do — usually an expired token or a revoked scope.`,
      dedupeKey: `inboxzero:mutationfail:${new Date().toISOString().slice(0, 10)}`,
    }).catch(() => {});
  }

  return res;
}

/** One-line human summary — shared by the OS run report and logs. */
export function summarizeInboxZero(r: InboxZeroResult): string {
  const policy = Object.entries(r.skippedByPolicy).map(([k, n]) => `${k}×${n}`).join(", ");
  return `Inbox-zero${r.dryRun ? " (dry-run)" : ""}: ${r.eligible} eligible of ${r.scanned} unread — ` +
    `${r.archived} archived, ${r.markedRead} marked read, ${r.starred} starred, ${r.labeled} labeled` +
    `${r.blocked ? `, ${r.blocked} blocked` : ""}; ` +
    `${r.unsubscribeCandidates.length} unsubscribe candidate(s), ${r.vipCatchUp.length} VIP catch-up` +
    `${r.capReached ? "; cap reached" : ""}${policy ? `; skipped by policy: ${policy}` : ""}` +
    // Last and unmissable, because this is the line the OS run history shows. A reader skimming
    // green summaries must not be able to miss that the classifier was failing.
    `${r.classifyFailed ? ` — ⚠ ${r.classifyFailed} FAILED TO CLASSIFY (not triaged)` : ""}.`;
}
