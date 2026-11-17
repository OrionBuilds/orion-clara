// Clara — generic two-way sync machinery, shared by Microsoft To Do and Outlook Contacts.
//
// Deliberately thin: hashing, 3-way merge, link bookkeeping, and the run loop. It knows nothing
// about task or contact shapes — each side supplies a SyncAdapter that projects its records into
// a common normalized form.
//
// Two decisions worth understanding before touching this:
//
// 1. CHANGE DETECTION IS BY CONTENT HASH, NEVER BY TIMESTAMP. Clara's own stores bump `updatedAt`
//    on every write including sync-driven ones, and the scheduler runs server-local time against
//    Google's UTC. Hashing a normalized projection that excludes volatile fields is also what
//    prevents echo loops: after any write we recompute both hashes from the write's own response,
//    so Google's `updated` bumping is invisible on the next pass. No suppression window, no clock
//    skew sensitivity.
//
// 2. DELETES NEVER PROPAGATE. A record vanishing on one side marks the link orphaned; it never
//    deletes on the other. Reaping is explicit and manual (see reapOrphans).

import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { loadConfig } from "./config";
import type { MAccount } from "./ms-auth";

export type SyncKind = "tasks" | "contacts";
export type LinkState = "linked" | "orphan-local" | "orphan-remote" | "conflict";

export interface LinkRow<N> {
  remoteId: string;
  etag?: string;
  base: N;            // last-synced agreed state — the 3-way merge base
  localHash: string;
  remoteHash: string;
  state: LinkState;
  lastSyncAt: string;
  failCount: number;
  lastError?: string;
}

export interface LinkStore<N> {
  version: 1;
  kind: SyncKind;
  account: MAccount;
  listId?: string;
  lastRunAt?: string;
  links: Record<string, LinkRow<N>>;   // localId -> link
  byRemote: Record<string, string>;    // remoteId -> localId
}

export interface PendingMatch<N> {
  localId?: string;
  remoteId?: string;
  reason: string;
  candidates: { id: string; confidence: number }[];
  preview: Partial<N>;
}

export interface SyncReport {
  kind: SyncKind;
  account: MAccount;
  dryRun: boolean;
  createdRemote: number;
  updatedRemote: number;
  createdLocal: number;
  updatedLocal: number;
  linked: number;
  unchanged: number;
  conflicts: number;
  pending: number;
  orphanedLocal: number;
  orphanedRemote: number;
  errors: { id: string; op: string; message: string }[];
  plan: string[];
  ranAt: string;
}

export interface SyncAdapter<L, R, N extends object> {
  kind: SyncKind;
  account: MAccount;

  listLocal(): Promise<L[]>;
  localId(l: L): string;
  normalizeLocal(l: L): N;

  listRemote(): Promise<R[]>;
  remoteId(r: R): string;
  remoteEtag?(r: R): string | undefined;
  normalizeRemote(r: R): N;
  // Clara's local id is embedded in the remote record (Tasks: a notes marker; Contacts:
  // userDefined). Lets links rebuild exactly if the link store is ever lost or an id changes.
  embeddedLocalId?(r: R): string | undefined;

  // Fields Clara owns outright — remote can never clear or overwrite these.
  localOnlyFields: (keyof N)[];

  createRemote(n: N, localId: string): Promise<{ remoteId: string; etag?: string; raw: R }>;
  updateRemote(remoteId: string, n: N, etag: string | undefined, localId: string): Promise<{ etag?: string; raw: R }>;
  applyLocal(localId: string | null, n: N): Promise<string>;
  markLocalOrphaned?(localId: string): Promise<void>;

  matchCandidate(n: N, pool: { id: string; n: N }[]): { id: string; confidence: number } | null;
}

// ── hashing ──────────────────────────────────────────────────────────────
function stable(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stable);
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>)
      .filter(([, x]) => x !== undefined && x !== null && x !== "")
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, x]) => [k, stable(x)]));
  }
  return v;
}

export function hashRecord(n: unknown): string {
  return crypto.createHash("sha1").update(JSON.stringify(stable(n))).digest("hex");
}

function eq(a: unknown, b: unknown): boolean {
  return JSON.stringify(stable(a)) === JSON.stringify(stable(b));
}

// ── 3-way merge ──────────────────────────────────────────────────────────
// Changed on one side only → take that side. Changed on both to different values → Google wins,
// and the discarded local value is reported so the caller can ledger it.
export function threeWayMerge<N extends object>(
  base: N | undefined,
  local: N,
  remote: N,
  localOnly: (keyof N)[],
): { merged: N; conflicts: { field: keyof N; local: unknown; remote: unknown }[] } {
  const merged = {} as N;
  const conflicts: { field: keyof N; local: unknown; remote: unknown }[] = [];
  const keys = new Set<keyof N>([...Object.keys(local), ...Object.keys(remote)] as (keyof N)[]);

  for (const k of keys) {
    const lv = local[k];
    const rv = remote[k];

    if (localOnly.includes(k)) { merged[k] = lv; continue; }
    if (eq(lv, rv)) { merged[k] = lv; continue; }

    if (base) {
      const bv = base[k];
      if (eq(lv, bv)) { merged[k] = rv; continue; }   // only remote moved
      if (eq(rv, bv)) { merged[k] = lv; continue; }   // only local moved
    }

    // Genuine divergence (or no base to reason from) — Google wins, but surface it.
    merged[k] = rv;
    conflicts.push({ field: k, local: lv, remote: rv });
  }
  return { merged, conflicts };
}

// ── link store ───────────────────────────────────────────────────────────
async function syncDir(): Promise<string> {
  const cfg = await loadConfig();
  const d = path.join(cfg.dataDir, "sync");
  await fs.mkdir(d, { recursive: true });
  return d;
}

function storePath(dir: string, kind: SyncKind, account: MAccount): string {
  return path.join(dir, `${kind}-${account}.json`);
}

export async function loadLinks<N>(kind: SyncKind, account: MAccount): Promise<LinkStore<N>> {
  const d = await syncDir();
  try {
    return JSON.parse(await fs.readFile(storePath(d, kind, account), "utf8")) as LinkStore<N>;
  } catch {
    return { version: 1, kind, account, links: {}, byRemote: {} };
  }
}

// Atomic: a half-written link store would orphan every record on the next run.
export async function saveLinks<N>(store: LinkStore<N>): Promise<void> {
  const d = await syncDir();
  const target = storePath(d, store.kind, store.account);
  const tmp = `${target}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(store, null, 2), "utf8");
  await fs.rename(tmp, target);
}

export async function loadPending<N>(kind: SyncKind, account: MAccount): Promise<PendingMatch<N>[]> {
  const d = await syncDir();
  try { return JSON.parse(await fs.readFile(path.join(d, `pending-${kind}-${account}.json`), "utf8")); }
  catch { return []; }
}
export async function savePending<N>(kind: SyncKind, account: MAccount, rows: PendingMatch<N>[]): Promise<void> {
  const d = await syncDir();
  await fs.writeFile(path.join(d, `pending-${kind}-${account}.json`), JSON.stringify(rows, null, 2), "utf8");
}

// ── retry ────────────────────────────────────────────────────────────────
export function isRetryable(e: unknown): boolean {
  const m = String((e as Error)?.message ?? e);
  return /\b(429|500|502|503|504)\b/.test(m) || /ECONNRESET|ETIMEDOUT|network|timeout/i.test(m);
}

export async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); }
    catch (e) {
      last = e;
      if (!isRetryable(e) || i === attempts - 1) throw e;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** i));
    }
  }
  throw last;
}

const MIN_CONFIDENCE = 0.7;

// ── the run loop ─────────────────────────────────────────────────────────
export async function runSync<L, R, N extends object>(
  a: SyncAdapter<L, R, N>,
  opts: { dryRun?: boolean } = {},
): Promise<SyncReport> {
  const dryRun = opts.dryRun ?? false;
  const now = new Date().toISOString();
  const rep: SyncReport = {
    kind: a.kind, account: a.account, dryRun,
    createdRemote: 0, updatedRemote: 0, createdLocal: 0, updatedLocal: 0,
    linked: 0, unchanged: 0, conflicts: 0, pending: 0,
    orphanedLocal: 0, orphanedRemote: 0, errors: [], plan: [], ranAt: now,
  };

  const store = await loadLinks<N>(a.kind, a.account);
  const pending: PendingMatch<N>[] = [];

  let locals: L[], remotes: R[];
  try {
    [locals, remotes] = await Promise.all([a.listLocal(), a.listRemote()]);
  } catch (e) {
    rep.errors.push({ id: "-", op: "list", message: String((e as Error).message ?? e) });
    return rep;
  }

  const localById = new Map(locals.map((l) => [a.localId(l), l]));
  const remoteById = new Map(remotes.map((r) => [a.remoteId(r), r]));
  const normLocal = new Map([...localById].map(([id, l]) => [id, a.normalizeLocal(l)]));
  const normRemote = new Map([...remoteById].map(([id, r]) => [id, a.normalizeRemote(r)]));

  // Pass 0 — rebuild links from ids embedded in the remote records. Exact, zero ambiguity, and
  // recovers fully if the link store was lost or a local id changed (e.g. a contact rename).
  if (a.embeddedLocalId) {
    for (const [rid, r] of remoteById) {
      const emb = a.embeddedLocalId(r);
      if (!emb || store.byRemote[rid] || !localById.has(emb)) continue;
      if (store.links[emb]) continue;
      store.links[emb] = {
        remoteId: rid, etag: a.remoteEtag?.(r),
        base: normRemote.get(rid)!, localHash: "", remoteHash: "",
        state: "linked", lastSyncAt: now, failCount: 0,
      };
      store.byRemote[rid] = emb;
      rep.linked++;
      rep.plan.push(`link (embedded id): local ${emb} ↔ remote ${rid}`);
    }
  }

  const handledRemote = new Set<string>();

  // Pass 1 — every existing link.
  for (const [localId, link] of Object.entries(store.links)) {
    if (link.state === "conflict" && link.failCount >= 3) { rep.unchanged++; handledRemote.add(link.remoteId); continue; }

    const local = normLocal.get(localId);
    const remote = normRemote.get(link.remoteId);
    handledRemote.add(link.remoteId);

    if (!local && !remote) continue;

    if (!local) {
      // Local record is gone. Never delete remotely — just mark it.
      if (link.state !== "orphan-local") { link.state = "orphan-local"; rep.orphanedLocal++; rep.plan.push(`orphan-local: ${localId} (remote ${link.remoteId} left untouched)`); }
      continue;
    }
    if (!remote) {
      if (link.state !== "orphan-remote") {
        link.state = "orphan-remote";
        rep.orphanedRemote++;
        rep.plan.push(`orphan-remote: ${link.remoteId} gone; local ${localId} kept`);
        if (!dryRun) await a.markLocalOrphaned?.(localId).catch(() => {});
      }
      continue;
    }

    const lh = hashRecord(local);
    const rh = hashRecord(remote);
    const localChanged = lh !== link.localHash;
    const remoteChanged = rh !== link.remoteHash;

    if (!localChanged && !remoteChanged) { rep.unchanged++; continue; }

    const { merged, conflicts } = threeWayMerge(link.base, local, remote, a.localOnlyFields);
    if (conflicts.length) {
      rep.conflicts++;
      rep.plan.push(`conflict on ${localId}: ${conflicts.map((c) => String(c.field)).join(", ")} — Google wins`);
    }

    const mergedHash = hashRecord(merged);
    const needRemoteWrite = mergedHash !== rh;
    const needLocalWrite = mergedHash !== lh;

    if (dryRun) {
      if (needRemoteWrite) { rep.updatedRemote++; rep.plan.push(`would update remote ${link.remoteId}`); }
      if (needLocalWrite) { rep.updatedLocal++; rep.plan.push(`would update local ${localId}`); }
      continue;
    }

    try {
      let effectiveRemote = merged;
      if (needRemoteWrite) {
        const res = await withRetry(() => a.updateRemote(link.remoteId, merged, link.etag, localId));
        link.etag = res.etag ?? link.etag;
        effectiveRemote = a.normalizeRemote(res.raw);
        rep.updatedRemote++;
      }
      if (needLocalWrite) {
        await a.applyLocal(localId, merged);
        rep.updatedLocal++;
      }
      // Recompute BOTH hashes from post-write truth — this is the echo-loop guard. The remote
      // hash comes from the write's own response (so Google's `updated` bump is already absorbed);
      // the local hash is the merged record itself, which holds because adapters guarantee
      // normalizeLocal(applyLocal(n)) === n — the projection excludes volatile fields by design.
      link.localHash = hashRecord(needLocalWrite ? merged : local);
      link.remoteHash = hashRecord(effectiveRemote);
      link.base = merged;
      link.state = "linked";
      link.failCount = 0;
      delete link.lastError;
      link.lastSyncAt = now;
    } catch (e) {
      link.failCount = (link.failCount ?? 0) + 1;
      link.lastError = String((e as Error).message ?? e);
      if (link.failCount >= 3) link.state = "conflict";
      rep.errors.push({ id: localId, op: "sync", message: link.lastError });
    }
  }

  // Pass 2 — remote records with no link: match an existing local, else create locally.
  const unlinkedLocalPool = [...normLocal].filter(([id]) => !store.links[id]).map(([id, n]) => ({ id, n }));

  for (const [rid, rn] of normRemote) {
    if (handledRemote.has(rid) || store.byRemote[rid]) continue;

    const match = a.matchCandidate(rn, unlinkedLocalPool);
    if (match && match.confidence >= MIN_CONFIDENCE) {
      if (!dryRun) {
        store.links[match.id] = {
          remoteId: rid, etag: a.remoteEtag?.(remoteById.get(rid)!),
          base: rn, localHash: hashRecord(normLocal.get(match.id)!), remoteHash: hashRecord(rn),
          state: "linked", lastSyncAt: now, failCount: 0,
        };
        store.byRemote[rid] = match.id;
      }
      rep.linked++;
      rep.plan.push(`link (matched ${match.confidence.toFixed(2)}): local ${match.id} ↔ remote ${rid}`);
      continue;
    }
    if (match) {
      // Plausible but not confident enough to act on — park it for a human decision.
      pending.push({ remoteId: rid, reason: `low-confidence match (${match.confidence.toFixed(2)})`, candidates: [match], preview: rn });
      rep.pending++;
      continue;
    }

    if (dryRun) { rep.createdLocal++; rep.plan.push(`would create local from remote ${rid}`); continue; }
    try {
      const newLocalId = await a.applyLocal(null, rn);
      store.links[newLocalId] = {
        remoteId: rid, etag: a.remoteEtag?.(remoteById.get(rid)!),
        base: rn, localHash: hashRecord(rn), remoteHash: hashRecord(rn),
        state: "linked", lastSyncAt: now, failCount: 0,
      };
      store.byRemote[rid] = newLocalId;
      rep.createdLocal++;
    } catch (e) {
      rep.errors.push({ id: rid, op: "create-local", message: String((e as Error).message ?? e) });
    }
  }

  // Pass 3 — local records with no link: push them up.
  for (const [lid, ln] of normLocal) {
    if (store.links[lid]) continue;
    if (pending.some((p) => p.localId === lid)) continue;

    if (dryRun) { rep.createdRemote++; rep.plan.push(`would create remote from local ${lid}`); continue; }
    try {
      const res = await withRetry(() => a.createRemote(ln, lid));
      const rn = a.normalizeRemote(res.raw);
      store.links[lid] = {
        remoteId: res.remoteId, etag: res.etag,
        base: rn, localHash: hashRecord(ln), remoteHash: hashRecord(rn),
        state: "linked", lastSyncAt: now, failCount: 0,
      };
      store.byRemote[res.remoteId] = lid;
      rep.createdRemote++;
    } catch (e) {
      rep.errors.push({ id: lid, op: "create-remote", message: String((e as Error).message ?? e) });
    }
  }

  if (!dryRun) {
    store.lastRunAt = now;
    await saveLinks(store);
    await savePending(a.kind, a.account, pending);
  }
  return rep;
}

// Explicit, never scheduled: the only way an orphan is actually removed.
export async function reapOrphans<N>(
  kind: SyncKind, account: MAccount, ids: string[],
): Promise<{ removed: string[] }> {
  const store = await loadLinks<N>(kind, account);
  const removed: string[] = [];
  for (const id of ids) {
    const link = store.links[id];
    if (!link) continue;
    delete store.byRemote[link.remoteId];
    delete store.links[id];
    removed.push(id);
  }
  await saveLinks(store);
  return { removed };
}
