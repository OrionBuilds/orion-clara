// Clara — the owner's SMS approval commands. Port of FRIDAY's src/lib/friday/ownerCommands.ts: "approve
// #<code>" / "approve all" / "reject #<code>" / a bare "yes" when exactly one item is pending.
//
// Rows are addressed by SHORT CODE, never by position — an ordinal ("approve 2") silently
// mis-targets if another approval was decided between the SMS being sent and the reply arriving.
// On a gate whose whole job is guarding money, an addressing scheme that can quietly resolve to
// the wrong row is not acceptable.
//
// Autonomy Spec v0.1, item #3: the owner wants "approve two" to work when they're mid-drive, which the
// short-code-only rule above deliberately didn't allow. Compromise, not a reversal: an ordinal
// only resolves against the SPECIFIC numbered list just sent to THIS sender, and only within a
// 5-minute window (approval-batch.json sidecar, tmp+rename like every other dataDir store) — and
// even then, the resolved id is re-checked against the live pending set before acting, closing
// the exact race the short-code rule exists to avoid. Past the window, or if the target already
// resolved, this fails closed and asks for the short code instead of guessing.

import { promises as fs } from "node:fs";
import path from "node:path";
import { listPending, approve, reject, shortCode, type Approval } from "./approvals";
import { loadConfig } from "./config";

const BATCH_WINDOW_MS = 5 * 60_000;

// Hidden compat only (owner-comms overhaul, 2026-09-24): this whole grammar now runs behind
// decisionReply.ts and is reached only when the owner types a literal code or "approve all".
// Names, never codes, in anything it says back.
function numbered(list: Approval[]): string {
  return list.map((a, i) => `${i + 1}. ${a.title}`).join("\n");
}

async function batchFile(): Promise<string> {
  const cfg = await loadConfig();
  await fs.mkdir(cfg.dataDir, { recursive: true });
  return path.join(cfg.dataDir, "approval-batch.json");
}

type BatchStore = Record<string, { ids: string[]; sentAt: string }>;

async function loadBatches(): Promise<BatchStore> {
  try { return JSON.parse(await fs.readFile(await batchFile(), "utf8")); } catch { return {}; }
}

/** Called every time a numbered list is sent — records what "approve 2" would mean for this sender. */
async function recordBatch(fromE164: string, list: Approval[]): Promise<void> {
  const f = await batchFile();
  const store = await loadBatches();
  store[fromE164] = { ids: list.map((a) => a.id), sentAt: new Date().toISOString() };
  const tmp = `${f}.tmp`;
  try {
    await fs.writeFile(tmp, JSON.stringify(store, null, 2), "utf8");
    await fs.rename(tmp, f);
  } catch (e) {
    console.error("[clara-owner-commands] approval-batch persist failed:", e);
  }
}

const WORD_NUMBERS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};

/** Digit or word-number immediately following the approve/reject verb — "approve 2" / "reject two". */
function parseOrdinal(text: string): number | null {
  const m = text.match(/\b(?:approve[d]?|reject|decline|deny|ship it|go ahead|do it|send it|release|confirm|proceed|green ?light|cancel)\b\s+(?:#|number\s+)?(\d{1,2}|[a-z]+)\b/i);
  if (!m) return null;
  const raw = m[1].toLowerCase();
  const n = /^\d+$/.test(raw) ? parseInt(raw, 10) : WORD_NUMBERS[raw];
  return n && n >= 1 ? n : null;
}

/** Resolve an ordinal against the batch just sent to this sender. Fails closed on any doubt. */
async function resolveOrdinal(ordinal: number, fromE164: string, pending: Approval[]): Promise<{ approval?: Approval; expired?: boolean }> {
  const store = await loadBatches();
  const batch = store[fromE164];
  if (!batch) return {};
  const age = Date.now() - Date.parse(batch.sentAt);
  if (!(age >= 0) || age > BATCH_WINDOW_MS) return { expired: true };
  const id = batch.ids[ordinal - 1];
  if (!id) return {};
  const stillPending = pending.find((p) => p.id === id);
  // The target resolved (approved/rejected/expired) between send and reply — the exact race
  // short-codes exist to avoid. Do not guess at a substitute; fail closed.
  if (!stillPending) return { expired: true };
  return { approval: stillPending };
}

export const STRONG_APPROVE = /\b(approve[d]?|ship it|go ahead|do it|send it|release|confirm|proceed|green ?light)\b/i;
export const STRONG_REJECT = /\b(reject|decline|deny|cancel|hold off|do not|don'?t)\b/i;
export const SOFT_YES = /^(yes|yep|yeah|yup|ok|okay|sure|approved?)\b/i;
export const SOFT_NO = /^(no|nope|nah)\b/i;

// A token only counts as a code when it's '#'-prefixed (stripped) OR carries at least one digit —
// otherwise hex-shaped English matches live rows ("go ahead" contains AHEAD -> ... "DEAD"/"CAFE"/etc).
function matchShortCodes(text: string, pending: Approval[]): Approval[] {
  const raw = text.toUpperCase().split(/[^#0-9A-Z]+/).filter(Boolean);
  const tokens: string[] = [];
  for (const r of raw) {
    const hashed = r.startsWith("#");
    const word = hashed ? r.replace(/^#+/, "") : r;
    if (!/^[0-9A-F]{3,6}$/.test(word)) continue;
    if (hashed || /\d/.test(word)) tokens.push(word);
  }
  const byId = new Map<string, Approval>();
  for (const token of tokens) {
    for (const a of pending) {
      if (shortCode(a.id) === token || a.id.replace(/-/g, "").toUpperCase().endsWith(token)) byId.set(a.id, a);
    }
  }
  return [...byId.values()];
}

function normalizePhone(p: string): string {
  return p.replace(/[^\d+]/g, "");
}

/** Only the owner's own number may issue approve/reject commands — never an arbitrary inbound number. */
export async function isOwnerNumber(fromE164: string): Promise<boolean> {
  const { ownerPhones, samePhone } = await import("./ownerPhones");
  const from = normalizePhone(fromE164);
  return (await ownerPhones()).some((p) => samePhone(p, from));
}

// Returns a reply string if this was an owner approval command, else null (let normal chat handling run).
export async function tryHandleApprovalCommand(text: string, fromE164: string): Promise<string | null> {
  if (!(await isOwnerNumber(fromE164))) return null;
  const pending = await listPending();
  if (!pending.length) return null;
  const t = text.trim();

  const strongApprove = STRONG_APPROVE.test(t);
  const strongReject = STRONG_REJECT.test(t);
  const softYes = SOFT_YES.test(t);
  const softNo = SOFT_NO.test(t);
  if (!strongApprove && !strongReject && !softYes && !softNo) return null;

  const decision: "approved" | "rejected" = (strongReject || (softNo && !strongApprove)) ? "rejected" : "approved";
  const verbNow = decision === "approved" ? "approve" : "reject";

  let targets: Approval[] = [];
  if (/\ball\b/i.test(t)) targets = pending;
  else {
    const hits = matchShortCodes(t, pending);
    if (hits.length === 1) targets = hits;
    else if (hits.length > 1) {
      await recordBatch(fromE164, hits);
      return `That matches ${hits.length} pending:\n${numbered(hits)}\nTell me which one by name (or "${verbNow} <number>") so I release the right one.`;
    } else if (pending.length === 1) {
      targets = [pending[0]]; // unambiguous single — a bare "yes" is safe
    } else {
      const ordinal = parseOrdinal(t);
      if (ordinal !== null) {
        const { approval, expired } = await resolveOrdinal(ordinal, fromE164, pending);
        if (approval) targets = [approval];
        else if (expired) return `That list expired — tell me which one by name, e.g. "${verbNow} ${pending[0].title.slice(0, 40)}".`;
        // else: no batch on file for this sender — fall through to the "awaiting approval" prompt below.
      }
    }
  }

  if (!targets.length) {
    await recordBatch(fromE164, pending);
    return `You have ${pending.length} awaiting your OK:\n${numbered(pending)}\nTell me which one by name, "${verbNow} <number>", or "${verbNow} all".`;
  }

  const done: string[] = [];
  for (const a of targets) {
    const row = decision === "approved" ? await approve(a.id) : await reject(a.id);
    done.push(row?.title ?? a.title);
  }
  const verb = decision === "approved" ? "Approved" : "Rejected";
  const tail = decision === "approved" ? (targets.length === 1 ? " — running it now." : " — running them now.") : ".";
  const left = pending.filter((p) => !targets.some((x) => x.id === p.id));
  const tailLine = left.length ? `\n${left.length} still awaiting your OK — next up: ${left[0].title.slice(0, 60)}.` : "";
  return `${verb}: ${done.map((d) => `"${d}"`).join(", ")}${tail}${tailLine}`;
}
