// publicdata/flDbpr.ts — Florida DBPR (Dept of Business & Professional Regulation) contractor
// license lookup, off DBPR's public bulk licensee extract.
//
// VERIFIED (WebFetch against the live page, October 2026): the Construction Industry public-records
// page at https://www2.myfloridalicense.com/construction-industry/public-records/ links a primary
// licensee file at:
//   https://www2.myfloridalicense.com/sto/file_download/extracts//CONSTRUCTIONLICENSE_1.csv
// (the doubled slash before the filename is real, not a typo — DBPR's own link is built that way).
// The page describes the file as "ASCII text, quote/comma delimited" (CSV) and documents its column
// layout as: Board Number, Occupation Code, Licensee Name, Doing Business As Name, Class Code,
// Address Line 1/2/3, City, State, Zip, County Code, License Number, Primary Status, Secondary
// Status, Original Licensure Date, Effective Date, Expiration Date, Renewal Period, Alternate Lic#.
// ASSUMED (not independently confirmed against a real downloaded row — the live file is large and
// this environment's network egress to myfloridalicense.com was not exercised beyond the page
// fetch): the column ORDER exactly matches the order DBPR's own page lists them in, and that order is
// stable across refreshes. If a future refresh shows different column positions, DBPR_COLUMNS below
// is the one place to fix it — everything downstream reads named fields off it, not raw indices.
//
// License-type filtering: DBPR issues each contractor a license NUMBER prefixed by a board/category
// code (e.g. "CCC1234567"). This module filters the bulk file to the roofing-relevant prefixes:
//   CCC — Certified Roofing Contractor      RC  — Registered Roofing Contractor
//   CGC — Certified General Contractor      RG  — Registered General Contractor
//   CBC — Certified Building Contractor     RB  — Registered Building Contractor
//   CRC — Certified Residential Contractor  RR  — Registered Residential Contractor
// CCC/RC are roofing-specific; the General/Building/Residential categories are included too (per the
// plan's "be inclusive of roofing-relevant codes") because those license types are legally permitted
// to perform roofing work in Florida and commonly appear as a roofing company's license-of-record.

import path from "node:path";
import { promises as fsReal } from "node:fs";
import { normalizeName } from "../entity/normalize";
import type { DbprRecord } from "./types";

export const DBPR_EXTRACT_URL = "https://www2.myfloridalicense.com/sto/file_download/extracts//CONSTRUCTIONLICENSE_1.csv";

/** Named column positions in the extract, per DBPR's own documented layout (see module doc for what's
 *  verified vs. assumed about this order). */
export const DBPR_COLUMNS = {
  boardNumber: 0,
  occupationCode: 1,
  licenseeName: 2,
  businessName: 3,
  classCode: 4,
  addressLine1: 5,
  addressLine2: 6,
  addressLine3: 7,
  city: 8,
  state: 9,
  zip: 10,
  countyCode: 11,
  licenseNumber: 12,
  primaryStatus: 13,
  secondaryStatus: 14,
  originalLicensureDate: 15,
  effectiveDate: 16,
  expirationDate: 17,
  renewalPeriod: 18,
  alternateLicNumber: 19,
} as const;
const MIN_COLUMNS = DBPR_COLUMNS.primaryStatus + 1;

/** Roofing-specific + related construction license-number prefixes — see module doc for what each
 *  code means and why the non-roofing-specific ones are included. */
export const DBPR_ROOFING_RELEVANT_PREFIXES: readonly string[] = ["CCC", "RC", "CGC", "CBC", "CRC", "RG", "RB", "RR"];

const ACTIVE_STATUS_VALUES: ReadonlySet<string> = new Set(["current", "active"]);

/** Parses one quote/comma-delimited CSV line into fields, handling embedded commas inside double
 *  quotes and doubled-quote escaping (`""` -> `"`) — the two things a naive `split(",")` gets wrong
 *  on a real DBPR extract row. Pure. */
export function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

function licensePrefix(licenseNumber: string): string {
  const m = licenseNumber.match(/^[A-Za-z]+/);
  return m ? m[0].toUpperCase() : "";
}

/** The license-number prefix is checked against DBPR_ROOFING_RELEVANT_PREFIXES, NOT occupationCode
 *  or classCode — DBPR's own column values for those two fields are free-text board terminology that
 *  varies more than the license-number prefix convention does, so the prefix is the stabler filter. */
export function isRoofingRelevantLicense(licenseNumber: string): boolean {
  return DBPR_ROOFING_RELEVANT_PREFIXES.includes(licensePrefix(licenseNumber));
}

function normalizeStatus(raw: string): boolean {
  return ACTIVE_STATUS_VALUES.has(raw.trim().toLowerCase());
}

/** Parses the raw extract's full text (one record per line, optionally with a header row DBPR's
 *  real file may or may not carry — a header row is detected and skipped by checking whether the
 *  "license number" column of the first row looks like a license number at all) into DbprRecord[],
 *  already filtered to DBPR_ROOFING_RELEVANT_PREFIXES. Pure. */
export function parseDbprExtract(raw: string): DbprRecord[] {
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const out: DbprRecord[] = [];
  for (const [i, line] of lines.entries()) {
    const cols = parseCsvLine(line);
    if (cols.length < MIN_COLUMNS) continue;
    const licenseNumber = cols[DBPR_COLUMNS.licenseNumber]?.trim() ?? "";
    if (i === 0 && !/^[A-Za-z]{2,4}\d+/.test(licenseNumber)) continue; // header row, skip
    if (!licenseNumber || !isRoofingRelevantLicense(licenseNumber)) continue;

    const licenseeName = cols[DBPR_COLUMNS.licenseeName]?.trim() ?? "";
    const businessName = cols[DBPR_COLUMNS.businessName]?.trim() || undefined;
    if (!licenseeName && !businessName) continue;

    out.push({
      licenseNumber,
      licenseType: licensePrefix(licenseNumber),
      licenseeName,
      businessName,
      status: cols[DBPR_COLUMNS.primaryStatus]?.trim() ?? "",
      statusActive: normalizeStatus(cols[DBPR_COLUMNS.primaryStatus] ?? ""),
      address: {
        line1: cols[DBPR_COLUMNS.addressLine1]?.trim() || undefined,
        city: cols[DBPR_COLUMNS.city]?.trim() || undefined,
        state: cols[DBPR_COLUMNS.state]?.trim() || undefined,
        postalCode: cols[DBPR_COLUMNS.zip]?.trim() || undefined,
      },
      issueDate: cols[DBPR_COLUMNS.originalLicensureDate]?.trim() || undefined,
      expiryDate: cols[DBPR_COLUMNS.expirationDate]?.trim() || undefined,
    });
  }
  return out;
}

export const DBPR_CACHE_TTL_DAYS = 30;

export interface DbprCacheFile {
  fetchedAt: string;
  count: number;
  records: DbprRecord[];
}

export interface DbprDeps {
  readFile: (path: string) => Promise<string>;
  writeFile: (path: string, data: string) => Promise<void>;
  mkdir: (dir: string) => Promise<void>;
  fetchText: (url: string) => Promise<string>;
  now: () => number;
  dataDir: string;
}

async function defaultMkdir(dir: string): Promise<void> {
  await fsReal.mkdir(dir, { recursive: true });
}

async function defaultFetchText(url: string): Promise<string> {
  const r = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!r.ok) throw new Error(`dbpr extract fetch ${r.status}`);
  return r.text();
}

async function liveDataDir(): Promise<string> {
  const { loadConfig } = await import("../../config");
  const cfg = await loadConfig();
  return path.join(cfg.dataDir, "prospecting", "publicdata");
}

export async function defaultDbprDeps(): Promise<DbprDeps> {
  return {
    readFile: (p) => fsReal.readFile(p, "utf8"),
    writeFile: (p, data) => fsReal.writeFile(p, data, "utf8"),
    mkdir: defaultMkdir,
    fetchText: defaultFetchText,
    now: () => Date.now(),
    dataDir: await liveDataDir(),
  };
}

function cacheFilePath(dataDir: string): string {
  return path.join(dataDir, "dbpr.json");
}

export function isDbprCacheFresh(fetchedAtIso: string, now: number): boolean {
  const t = Date.parse(fetchedAtIso);
  return Number.isFinite(t) && now - t <= DBPR_CACHE_TTL_DAYS * 24 * 3600_000;
}

export interface RefreshDbprResult {
  refreshed: boolean;
  count: number;
  error?: string;
}

/** Refreshes `dataDir/dbpr.json` only when it's missing or older than 30 days (a bulk-file cache,
 *  deliberately NOT routed through cache.ts's cachedCall/provider-ledger machinery — that machinery
 *  is per-provider-CALL caching; this is a single shared 30-day snapshot of one big file, a different
 *  shape of problem). Never throws: a download/parse failure degrades to `{refreshed:false, count:0,
 *  error}` so a DBPR outage (or this sandbox's network egress being restricted, which is expected and
 *  fine) never breaks the public_data stage. */
export async function refreshDbprCache(deps: DbprDeps, opts: { force?: boolean } = {}): Promise<RefreshDbprResult> {
  const file = cacheFilePath(deps.dataDir);
  if (!opts.force) {
    try {
      const existing = JSON.parse(await deps.readFile(file)) as DbprCacheFile;
      if (isDbprCacheFresh(existing.fetchedAt, deps.now())) {
        return { refreshed: false, count: existing.count };
      }
    } catch {
      /* missing or unreadable cache — fall through to a refresh */
    }
  }

  try {
    const raw = await deps.fetchText(DBPR_EXTRACT_URL);
    const records = parseDbprExtract(raw);
    const payload: DbprCacheFile = { fetchedAt: new Date(deps.now()).toISOString(), count: records.length, records };
    await deps.mkdir(deps.dataDir);
    await deps.writeFile(file, JSON.stringify(payload));
    return { refreshed: true, count: records.length };
  } catch (e) {
    return { refreshed: false, count: 0, error: e instanceof Error ? e.message : String(e) };
  }
}

let memoCache: { file: string; records: DbprRecord[] } | null = null;

/** Fast in-memory/file lookup by normalized business/licensee name (and optional state), never a
 *  re-parse of the bulk file — reads the already-refreshed `dbpr.json` cache (building an in-process
 *  index only once per cold start, mirroring ledger.ts's readProviderCalls memoization style). Does
 *  NOT itself trigger a refresh — call refreshDbprCache first (public_data's orchestration, Task 5,
 *  does exactly that before calling this). Returns [] (never throws) when the cache doesn't exist yet
 *  or doesn't parse. */
export async function lookupDbpr(normalizedNameOrRaw: string, state: string | undefined, deps: DbprDeps): Promise<DbprRecord[]> {
  const file = cacheFilePath(deps.dataDir);
  if (!memoCache || memoCache.file !== file) {
    try {
      const cache = JSON.parse(await deps.readFile(file)) as DbprCacheFile;
      memoCache = { file, records: Array.isArray(cache.records) ? cache.records : [] };
    } catch {
      memoCache = { file, records: [] };
      return [];
    }
  }
  const target = normalizeName(normalizedNameOrRaw);
  if (!target) return [];
  return memoCache.records.filter((r) => {
    const nameMatch = normalizeName(r.businessName) === target || normalizeName(r.licenseeName) === target;
    if (!nameMatch) return false;
    if (state && r.address?.state && r.address.state.trim().toUpperCase() !== state.trim().toUpperCase()) return false;
    return true;
  });
}

/** Test-only hook: clears the in-process memo so a test's fake `deps.dataDir`/cache file is re-read. */
export function resetDbprMemoCacheForTests(): void {
  memoCache = null;
}
