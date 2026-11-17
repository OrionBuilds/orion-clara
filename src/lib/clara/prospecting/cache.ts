// cache.ts — TTL-aware cache over the local provider-call ledger (see ledger.ts for why local).
//
// TTLs per §31: places/serper 30d, crawl 14d, dns 7d, email 180d, mobile 365d, sunbiz 90d (brave
// grouped with the search providers at 30d).

import { readProviderCalls, recordProviderCall, type ProviderCallRecord } from "./ledger";

export type CacheKind = "places" | "serper" | "brave" | "crawl" | "dns" | "email" | "mobile" | "sunbiz";

export const TTL_DAYS: Record<CacheKind, number> = {
  places: 30, serper: 30, brave: 30, crawl: 14, dns: 7, email: 180, mobile: 365, sunbiz: 90,
};

export function ttlMs(kind: CacheKind): number {
  return TTL_DAYS[kind] * 24 * 3600_000;
}

export function cacheKey(parts: Array<string | number | undefined | null>): string {
  return parts.map((p) => String(p ?? "").trim().toLowerCase()).join("|");
}

export function isFresh(cachedAtIso: string, kind: CacheKind, now: number = Date.now()): boolean {
  const t = Date.parse(cachedAtIso);
  return Number.isFinite(t) && now - t <= ttlMs(kind);
}

/** The most recent successful (non-error) call matching provider+key, if still fresh for `kind`. */
export async function cacheLookup(provider: string, kind: CacheKind, key: string, now: number = Date.now()): Promise<ProviderCallRecord | undefined> {
  let best: ProviderCallRecord | undefined;
  for (const r of await readProviderCalls()) {
    if (r.provider !== provider || r.cacheKey !== key || r.status === "error" || r.response === undefined) continue;
    if (!best || r.ts > best.ts) best = r;
  }
  return best && isFresh(best.ts, kind, now) ? best : undefined;
}

export interface CachedCallArgs<T> {
  provider: string;
  kind: CacheKind;
  key: string;
  jobId?: string;
  /** PR 17 — threaded straight to ledger.ts's ProviderCallRecord.companyId for signal-scan calls
   *  (no jobId; see ledger.ts's doc comment on that field). */
  companyId?: string;
  /** What a LIVE (non-cached) call costs — recorded only when `fn()` actually runs and succeeds. */
  costUsd: number;
  /** false (shadow mode on a paid kind) makes a miss a no-op instead of a real call. */
  allowLive: boolean;
  fn: () => Promise<T>;
}

export interface CachedCallResult<T> {
  value?: T;
  cached: boolean;
  skipped?: boolean;
  costUsd: number;
}

function hasSoftError(value: unknown): string | undefined {
  if (value && typeof value === "object" && "error" in value) {
    const e = (value as { error?: unknown }).error;
    return typeof e === "string" && e ? e : undefined;
  }
  return undefined;
}

/**
 * Run `fn()` only on a cache miss. A hit replays the cached value at $0 (matching the blueprint's
 * "cache hits write cost_usd=0, cached=true"). A miss with `allowLive:false` is a no-op (shadow
 * mode never pays for a paid provider). `fn()` returning a value with a truthy `.error` field (the
 * provider helpers' own convention — see places.ts/brave-search.ts) is recorded as a $0 soft
 * failure rather than cached or billed.
 */
export async function cachedCall<T>(args: CachedCallArgs<T>): Promise<CachedCallResult<T>> {
  const hit = await cacheLookup(args.provider, args.kind, args.key);
  if (hit) {
    await recordProviderCall({ provider: args.provider, cacheKey: args.key, jobId: args.jobId, companyId: args.companyId, costUsd: 0, cached: true, status: "ok" });
    return { value: hit.response as T, cached: true, costUsd: 0 };
  }
  if (!args.allowLive) return { cached: false, skipped: true, costUsd: 0 };
  try {
    const value = await args.fn();
    const softError = hasSoftError(value);
    const costUsd = softError ? 0 : args.costUsd;
    await recordProviderCall({
      provider: args.provider, cacheKey: args.key, jobId: args.jobId, companyId: args.companyId, costUsd,
      cached: false, status: softError ? "error" : "ok", error: softError,
      response: softError ? undefined : value,
    });
    return { value, cached: false, costUsd };
  } catch (e) {
    await recordProviderCall({
      provider: args.provider, cacheKey: args.key, jobId: args.jobId, companyId: args.companyId, costUsd: 0,
      cached: false, status: "error", error: e instanceof Error ? e.message : String(e),
    });
    throw e;
  }
}
