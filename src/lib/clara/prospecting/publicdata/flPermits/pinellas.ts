// publicdata/flPermits/pinellas.ts — Pinellas County building-permit lookup.
//
// RESEARCHED, NOT CONFIRMED: unlike Hillsborough's ArcGIS FeatureServer (flPermits/hillsborough.ts),
// no genuinely public, unauthenticated, queryable JSON endpoint carrying contractor-indexed permit
// data was found for Pinellas County in this environment's research pass:
//   - egis.pinellas.gov's ArcGIS REST catalog (`/gis/rest/services`) was reachable and has an
//     `Accela/AccelaMobile/MapServer` service, but the layer actually queried there (layer 1,
//     "Parcel") is Property Appraiser parcel data — no permit or contractor fields at all. The
//     catalog may have another layer/service that does carry permits, but none was located and
//     confirmed before this PR's research budget ran out.
//   - Pinellas's permitting front-end is Accela Citizen Access (aca-prod.accela.com/pinellas), which
//     — consistent with Accela Citizen Access deployments generally — does not expose an
//     unauthenticated JSON API; it's a session-authenticated web UI.
// This module is therefore written against a BEST-GUESS endpoint shape (PINELLAS_PERMITS_QUERY_URL
// below, modeled on Hillsborough's confirmed-real ArcGIS FeatureServer query pattern, since Pinellas
// County's eGIS environment is the same ArcGIS Server product) rather than a confirmed-real one. The
// parser (parsePinellasResponse) is defensive by construction: ANY non-matching shape — a 404, an
// HTML error page, a differently-named field set, a layer that doesn't exist — degrades to []
// through the same `try { fetchJson } catch { return [] }` path lookupPermits uses, never throwing.
// A future PR correcting this module only needs to fix PINELLAS_PERMITS_QUERY_URL and the field-name
// mapping inside parsePinellasResponse; the adapter's shape (PermitRecord[], same call signature as
// Hillsborough's) is already right.

import type { PermitRecord } from "../types";

/** BEST-GUESS — see module doc. Modeled on Hillsborough's confirmed-real ArcGIS FeatureServer query
 *  shape under the assumption Pinellas's eGIS environment is also ArcGIS Server; the service name/
 *  layer index are placeholders, not a confirmed real service. */
export const PINELLAS_PERMITS_QUERY_URL = "https://egis.pinellas.gov/gis/rest/services/Permits/MapServer/0/query";

function escapeSqlLiteral(s: string): string {
  return s.replace(/'/g, "''");
}

export function buildPinellasQueryUrl(searchTerm: string, resultRecordCount = 25): string {
  const escaped = escapeSqlLiteral(searchTerm.toUpperCase());
  const where = `UPPER(CONTRACTOR_NAME) LIKE '%${escaped}%' OR UPPER(CONTRACTOR_LICENSE) LIKE '%${escaped}%'`;
  const params = new URLSearchParams({ where, outFields: "*", f: "json", resultRecordCount: String(resultRecordCount) });
  return `${PINELLAS_PERMITS_QUERY_URL}?${params.toString()}`;
}

export interface ArcGisFeature {
  attributes?: Record<string, unknown>;
}
export interface ArcGisQueryResponse {
  features?: ArcGisFeature[];
  error?: { code?: number; message?: string };
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}
function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
function dateStr(v: unknown): string | undefined {
  if (typeof v === "number" && Number.isFinite(v)) {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? undefined : d.toISOString().slice(0, 10);
  }
  return str(v);
}

/**
 * Parses a BEST-GUESS field-name mapping (PERMIT_NUMBER/CONTRACTOR_NAME/CONTRACTOR_LICENSE/
 * DESCRIPTION/PERMIT_TYPE/JOB_VALUE/ISSUE_DATE/STATUS/SITE_ADDRESS — a plausible Accela-style permit
 * export's column names, not confirmed against a real Pinellas response) into PermitRecord[]. Same
 * defensive contract as Hillsborough's parser: a missing/malformed `features` array, or an ArcGIS
 * `.error` envelope, returns [] rather than throwing.
 */
export function parsePinellasResponse(raw: unknown): PermitRecord[] {
  if (!raw || typeof raw !== "object") return [];
  const r = raw as ArcGisQueryResponse;
  if (r.error || !Array.isArray(r.features)) return [];

  const out: PermitRecord[] = [];
  for (const f of r.features) {
    const a = f?.attributes;
    if (!a || typeof a !== "object") continue;
    const permitNumber = str(a.PERMIT_NUMBER) ?? str(a.PERMIT_NO) ?? str(a.PERMITNUM);
    if (!permitNumber) continue;
    out.push({
      permitNumber,
      jurisdiction: "pinellas",
      contractorName: str(a.CONTRACTOR_NAME),
      contractorLicenseNumber: str(a.CONTRACTOR_LICENSE),
      description: str(a.DESCRIPTION),
      permitType: str(a.PERMIT_TYPE),
      valuation: num(a.JOB_VALUE) ?? num(a.VALUATION),
      issueDate: dateStr(a.ISSUE_DATE),
      status: str(a.STATUS),
      address: str(a.SITE_ADDRESS) ?? str(a.ADDRESS),
    });
  }
  return out;
}

export interface PinellasPermitsDeps {
  fetchJson: (url: string) => Promise<unknown>;
}

async function defaultFetchJson(url: string): Promise<unknown> {
  const r = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`pinellas permits query ${r.status}`);
  return r.json();
}

export const defaultPinellasPermitsDeps: PinellasPermitsDeps = { fetchJson: defaultFetchJson };

/**
 * Looks up Pinellas permit records by contractor name or license number. Best-guess endpoint (see
 * module doc) — in practice, until PINELLAS_PERMITS_QUERY_URL is confirmed/corrected, every real call
 * is expected to fail the fetch or return a shape parsePinellasResponse doesn't recognize, and this
 * returns [] either way. That's the intended, safe degradation for an unconfirmed endpoint — never a
 * thrown error out of the public_data stage.
 */
export async function lookupPermits(contractorNameOrLicense: string, deps: PinellasPermitsDeps = defaultPinellasPermitsDeps): Promise<PermitRecord[]> {
  const term = contractorNameOrLicense.trim();
  if (!term) return [];
  try {
    const raw = await deps.fetchJson(buildPinellasQueryUrl(term));
    return parsePinellasResponse(raw);
  } catch {
    return [];
  }
}
