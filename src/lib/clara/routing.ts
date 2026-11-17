// Clara — cross-agent routing from a single phone thread.
//
// Before this, each Twilio number was a closed loop to one agent: to get dev work done you texted
// FRIDAY's number, and you had to already know which agent owned the problem. The `interagent`
// contract and the CLARA->FRIDAY bridge both existed and neither was ever called from SMS. This wires
// them to the front door, so one thread reaches the whole bench. Paid ads / marketing are not a
// delegated service; SEO is FRIDAY's.
//
// ── Why a confirm step ────────────────────────────────────────────────────────────────────────
// Classification is a guess, and the cost of a wrong guess is asymmetric: handing "raise the bid on
// the Miller campaign" to FRIDAY does nothing useful, but it also means the real request silently
// never happens. So Clara proposes and waits ("That looks like dev work — send to FRIDAY?"). One
// extra round trip buys certainty about where work went.
//
// ── Why it only offers on high confidence ────────────────────────────────────────────────────
// A classifier that offers to route everything is worse than none: every ordinary message becomes a
// yes/no interrogation. Routing is offered ONLY when the text carries strong, domain-specific
// signals. Everything else falls through to Clara answering herself, exactly as before — so the
// conservative failure is "Clara handled it", which is the status quo, never a dropped request.

import { promises as fs } from "node:fs";
import { isPaidAdsOrMarketing } from "./retiredServices";
import path from "node:path";
import { loadConfig } from "./config";
import { append as ledgerAppend } from "./ledger";
import { delegate } from "./friday-bridge";
import { record as recordDelegation, type DelegationRecord } from "./delegations";

export type RouteTarget = "friday";

export interface RouteProposal {
  target: RouteTarget;
  /** Human-readable justification, used verbatim in the confirm question. */
  why: string;
}

/** A confirm offer that is waiting on a yes/no, keyed by the phone number that will answer. */
export interface PendingRoute {
  from: string;
  /** "ask" = the text matched BOTH benches; the reply must name one (readAgentChoice). */
  target: RouteTarget | "ask";
  prompt: string;
  why: string;
  offeredAt: string;
}

/**
 * A stale offer is dangerous in a way a stale question is not: answering "yes" tomorrow to a
 * proposal you have forgotten dispatches work you are no longer thinking about. Ten minutes is
 * roughly one conversational turn's patience.
 */
const OFFER_TTL_MS = 10 * 60_000;

// Domain signals. These are intentionally specific nouns from each agent's actual job rather than
// generic verbs — "fix the deploy" is unambiguous, "fix it" is not and must NOT match.
const FRIDAY_SIGNALS =
  /\b(deploy|deployment|build (is )?(failing|broken)|repo|repository|pull request|\bPR\b|merge conflict|migration|typescript|lint|test suite|stack ?trace|exception|codebase|refactor|hotfix|rollback|staging|edge function|api endpoint)\b/i;
// SEO is FRIDAY's. Paid ads / marketing match nothing:
// Clara answers those herself (the service is not offered), never a hand-off.
const SEO_SIGNALS =
  /\b(seo|backlinks?|google business profile|\bGBP\b|search rankings?|schema markup|meta descriptions?|sitemap)\b/i;

/**
 * Decide whether this message obviously belongs to another agent.
 *
 * Returns null when no signal fires (Clara handles it, or the intent router's delegate_to_agent
 * does). FRIDAY is the only bench now, so a match is never ambiguous; the `{ ambiguous: true }`
 * shape stays in the return type for the SMS path's existing handling.
 */
export function proposeRoute(text: string): RouteProposal | { ambiguous: true } | null {
  const t = text.trim();
  if (t.length < 8) return null; // too short to carry a real request

  // A mixed ask ("fix the deploy and raise the ad budget") is never offered whole to FRIDAY: the
  // ads half isn't a service we offer. Leave it with Clara, whose delegate tool only passes the
  // supported part on (retiredServices.ts).
  if (isPaidAdsOrMarketing(t)) return null;
  if (FRIDAY_SIGNALS.test(t)) return { target: "friday", why: "that looks like dev work" };
  if (SEO_SIGNALS.test(t)) return { target: "friday", why: "that looks like SEO work" };
  return null;
}

// ── Pending-offer store ───────────────────────────────────────────────────────────────────────
// A file rather than memory: the confirm arrives as a SEPARATE webhook request, and Next may have
// recycled the process (or be serving from a different worker) in between. An in-memory Map would
// drop the offer exactly often enough to be maddening and rarely enough to look like a fluke.

async function offerFile(): Promise<string> {
  const cfg = await loadConfig();
  await fs.mkdir(cfg.dataDir, { recursive: true });
  return path.join(cfg.dataDir, "pending-routes.json");
}

async function readOffers(): Promise<PendingRoute[]> {
  try {
    const raw = await fs.readFile(await offerFile(), "utf8");
    const rows = JSON.parse(raw) as PendingRoute[];
    const cutoff = Date.now() - OFFER_TTL_MS;
    return rows.filter((r) => Date.parse(r.offeredAt) > cutoff);
  } catch {
    return [];
  }
}

async function writeOffers(rows: PendingRoute[]): Promise<void> {
  const p = await offerFile();
  const tmp = `${p}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(rows, null, 2), "utf8");
  await fs.rename(tmp, p); // same atomic write-through the other dataDir stores use
}

/** Keep this many live offers per number — two routable texts in a row used to overwrite each other. */
export const OFFERS_PER_NUMBER = 3;

/** Pure: add an offer, keeping the newest OFFERS_PER_NUMBER for that number. */
export function applyOffer(rows: PendingRoute[], offer: PendingRoute): PendingRoute[] {
  const mine = rows.filter((r) => r.from === offer.from);
  const others = rows.filter((r) => r.from !== offer.from);
  return [...others, ...[...mine, offer].slice(-OFFERS_PER_NUMBER)];
}

/**
 * Pure: the offer a reply resolves — the newest for that number. A bare "yes" cannot answer an
 * "ask" (both-bench) offer; a named choice resolves it to that bench.
 */
export function pickOffer(rows: PendingRoute[], from: string, choice?: RouteTarget): PendingRoute | null {
  const mine = rows.filter((r) => r.from === from);
  const newest = mine[mine.length - 1] ?? null;
  if (!newest) return null;
  if (newest.target === "ask") return choice ? { ...newest, target: choice } : null;
  return newest;
}

export async function rememberOffer(from: string, proposal: RouteProposal | { target: "ask"; why: string }, prompt: string): Promise<void> {
  const rows = await readOffers();
  await writeOffers(applyOffer(rows, { from, target: proposal.target, prompt, why: proposal.why, offeredAt: new Date().toISOString() }));
}

export async function hasLiveOffer(from: string): Promise<boolean> {
  return (await readOffers()).some((r) => r.from === from);
}

export async function takeOffer(from: string, choice?: RouteTarget): Promise<PendingRoute | null> {
  const rows = await readOffers();
  const picked = pickOffer(rows, from, choice);
  if (!picked) return null;
  const mine = rows.filter((r) => r.from === from);
  const newest = mine[mine.length - 1];
  await writeOffers(rows.filter((r) => r !== newest));
  return picked;
}

/** "friday" at the start of a reply — an answer naming the bench. */
export function readAgentChoice(text: string): RouteTarget | null {
  const m = text.trim().toLowerCase().match(/^(friday)\b/);
  return m ? (m[1] as RouteTarget) : null;
}

export async function clearOffer(from: string): Promise<void> {
  await writeOffers((await readOffers()).filter((r) => r.from !== from));
}

/**
 * Read a reply as a yes/no to a pending offer. Returns null when it is neither, so an unrelated
 * message does not consume the offer — you can ask a question mid-confirm and still say yes after.
 */
export function readConfirmation(text: string): boolean | null {
  const t = text.trim().toLowerCase().replace(/[.!?]+$/, "");
  if (/^(y|ya|yes|yep|yeah|yup|ok|okay|sure|do it|go|go ahead|send it|please do|confirm)$/.test(t)) return true;
  if (/^(n|no|nope|nah|don'?t|do not|cancel|stop|never ?mind|nevermind|leave it)$/.test(t)) return false;
  return null;
}

// ── Dispatch ──────────────────────────────────────────────────────────────────────────────────

export interface DispatchResult {
  ok: boolean;
  target: RouteTarget;
  reply?: string;
  error?: string;
  /**
   * Ids of whatever the target actually QUEUED — its receipt, and the difference between handing
   * work over and being told something reassuring.
   *
   * Both agents' orchestrators already materialise real tasks and return their ids; this used to
   * parse `reply` and throw them away, so Clara could say "I passed that to FRIDAY" with nothing
   * to back it. That is the exact shape of unverifiable claim the intent router exists to prevent,
   * so the ids come back and the caller reports them. Empty is a legitimate outcome (the target
   * answered a question, or ran a tool inline rather than queueing) — it means "nothing is
   * pending", not "it failed", and must be reported as such rather than dressed up as a handoff.
   */
  taskIds?: string[];
  runId?: string;
  /**
   * The dispatch timed out, so the outcome is genuinely UNKNOWN — not known-failed.
   *
   * Learned the hard way on 2026-08-05: a delegation exceeded the 120s timeout, Clara reported
   * "nothing got queued", and the agent had in fact created the task and started running it.
   * A false negative is not the safe direction here — it invites the owner to assign the same work twice.
   * A timed-out request was still delivered; we just never heard the answer, and saying "nothing was
   * handed over" asserts something this side cannot see.
   */
  indeterminate?: boolean;
  /**
   * The target rejected the interagent secret (401/403). A config problem on our side, not a busy
   * or absent agent — reported distinctly so it isn't diagnosed as "FRIDAY is down".
   */
  authFailed?: boolean;
}

/**
 * Hand the request to the target agent and bring its answer back. The reply always returns through
 * Clara so the thread stays single — you never address another number.
 */
export async function dispatchTo(
  target: RouteTarget,
  prompt: string,
  opts: { record?: DelegationRecord } = {},
): Promise<DispatchResult> {
  const result = await dispatchOnce(target, prompt);
  // Every hand-off that was (or may have been) delivered is recorded so delegationWatch can close
  // the loop. A dispatch with no receipt is still recorded: it goes stale and the owner hears about it.
  if (opts.record && (result.ok || result.indeterminate)) {
    await recordDelegation(opts.record, target, { taskIds: result.taskIds, runId: result.runId }).catch(() => {});
  }
  return result;
}

async function dispatchOnce(target: RouteTarget, rawPrompt: string): Promise<DispatchResult> {
  // Read-before: hand the bench what Clara already knows about this subject (bounded).
  const { memoryBlock } = await import("./vaultMemory");
  // Only earlier hand-offs on the same subject cross the bus — never the owner's personal threads
  // or the general index (persona: answer the capability asked for, never the raw record).
  const mem = await memoryBlock({ query: rawPrompt, max: 1500, kinds: ["delegation"], noFallback: true }).catch(() => "");
  const prompt = mem ? `${rawPrompt}\n\n---\n${mem}` : rawPrompt;
  const r = await delegate(prompt, { kind: "generic", timeoutMs: 120_000 });
  await ledgerAppend({
    kind: "action", actor: "clara",
    what: `routed to FRIDAY: "${prompt.slice(0, 100)}"`,
    meta: { target: "friday", ok: String(r.ok), via: r.via, taskIds: r.taskIds ?? [] },
  }).catch(() => {});
  return { ok: r.ok, target, reply: r.reply, error: r.error, taskIds: r.taskIds, runId: r.runId, authFailed: r.authFailed };
}

/** The label used when speaking about an agent to the owner. */
export function agentLabel(t: RouteTarget | "ask"): string {
  void t;
  return "FRIDAY";
}

/**
 * Run a dispatch in the background and deliver the outcome, mirroring startInboxSweepDetached.
 * Delegation can take a minute or more (an orchestrator run can take minutes), far past the point
 * where holding the SMS reply would be reasonable — so Clara acks, then reports.
 */
export function dispatchDetached(
  target: RouteTarget,
  prompt: string,
  deliver: (msg: string) => Promise<void>,
  opts: { record?: DelegationRecord } = {},
): void {
  void (async () => {
    const name = agentLabel(target);
    try {
      const r = await dispatchTo(target, prompt, opts);
      if (r.ok && r.reply) {
        await deliver(`${name}: ${r.reply}`);
      } else {
        // Say who failed and that the request did not happen — the dangerous outcome here is
        // believing work was handed off when it was dropped.
        await deliver(r.authFailed
          ? `${name} refused my credentials — that's a config problem on our side, not a busy agent. Nothing was handed over.`
          : r.indeterminate
            ? `${name} didn't answer in time — she may still have queued it. Check her board before sending it again.`
            : `${name} couldn't take that — ${r.error ?? "no reply"}. Nothing ran; want me to try again or handle it myself?`);
      }
    } catch (e) {
      await ledgerAppend({
        kind: "action", actor: "clara",
        what: `routing to ${name} FAILED: ${String(e).slice(0, 200)}`,
        meta: { target },
      }).catch(() => {});
      await deliver(`${name} hit an error and I couldn't hand that over. Nothing ran.`).catch(() => {});
    }
  })();
}
