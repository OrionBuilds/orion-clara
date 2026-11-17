// tech/dns.ts — cached MX/TXT lookups for the tech detector's mail-provider inference.
//
// node:dns/promises is a Node builtin — no new dependency. ENOTFOUND/ENODATA (no MX or TXT records
// for a domain at all) is a normal, cacheable "nothing here" result, not an error worth failing the
// task over. Any other DNS failure (timeout, SERVFAIL, etc.) comes back as a soft `{ok:false,error}`
// value — cache.ts's cachedCall treats an `.error`-shaped value as a $0 soft failure (not cached, not
// thrown), matching how places.ts/brave-search.ts already report provider trouble.
//
// Mirrors crawler/httpFetch.ts's shape exactly: the cachedCall wrapping lives in THIS file (the
// lowest-level module that does the actual lookup), so tech/detect.ts can inject `resolveMx`/
// `resolveTxt` wholesale in tests — same convention crawler/waterfall.ts's tests use for httpFetch
// (see waterfall.test.ts), rather than reaching into cachedCall's internals.

import { resolveMx as resolveMxReal, resolveTxt as resolveTxtReal } from "node:dns/promises";
import { cachedCall, cacheKey } from "../cache";
import { loadRates } from "../estimator";

export interface MxRecord {
  exchange: string;
  priority: number;
}

export interface DnsMxResult {
  ok: boolean;
  records?: MxRecord[];
  error?: string;
}

export interface DnsTxtResult {
  ok: boolean;
  /** Each inner array is one TXT record's string chunks — matches node:dns's own resolveTxt shape
   *  (a long TXT record can arrive split across multiple strings); callers join each record's parts. */
  records?: string[][];
  error?: string;
}

const NO_RECORDS_CODES: ReadonlySet<string> = new Set(["ENOTFOUND", "ENODATA"]);

function isNoRecordsError(e: unknown): boolean {
  return Boolean(e && typeof e === "object" && "code" in e && NO_RECORDS_CODES.has(String((e as { code?: unknown }).code)));
}

async function rawResolveMx(domain: string): Promise<DnsMxResult> {
  try {
    return { ok: true, records: await resolveMxReal(domain) };
  } catch (e) {
    if (isNoRecordsError(e)) return { ok: true, records: [] };
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

async function rawResolveTxt(domain: string): Promise<DnsTxtResult> {
  try {
    return { ok: true, records: await resolveTxtReal(domain) };
  } catch (e) {
    if (isNoRecordsError(e)) return { ok: true, records: [] };
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export interface DnsLookupOpts {
  jobId?: string;
  allowLive: boolean;
}

/** Resolves `domain`'s MX records, cached 7 days under cache.ts's shared "dns" kind. */
export async function dnsResolveMx(domain: string, opts: DnsLookupOpts): Promise<DnsMxResult> {
  const rates = await loadRates();
  const r = await cachedCall<DnsMxResult>({
    provider: "dns",
    kind: "dns",
    key: cacheKey([domain, "mx"]),
    jobId: opts.jobId,
    costUsd: rates.dns_lookup,
    allowLive: opts.allowLive,
    fn: () => rawResolveMx(domain),
  });
  if (r.skipped) return { ok: false, error: "dns lookup skipped (shadow mode, nothing cached yet)" };
  return r.value ?? { ok: false, error: "dns mx lookup failed" };
}

/** Resolves `domain`'s TXT records, cached 7 days under cache.ts's shared "dns" kind. */
export async function dnsResolveTxt(domain: string, opts: DnsLookupOpts): Promise<DnsTxtResult> {
  const rates = await loadRates();
  const r = await cachedCall<DnsTxtResult>({
    provider: "dns",
    kind: "dns",
    key: cacheKey([domain, "txt"]),
    jobId: opts.jobId,
    costUsd: rates.dns_lookup,
    allowLive: opts.allowLive,
    fn: () => rawResolveTxt(domain),
  });
  if (r.skipped) return { ok: false, error: "dns lookup skipped (shadow mode, nothing cached yet)" };
  return r.value ?? { ok: false, error: "dns txt lookup failed" };
}
