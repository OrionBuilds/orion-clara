// publicdata/flPermits/hillsborough.ts — Hillsborough County building-permit/CO lookup.
//
// CONFIRMED REAL (WebFetch against the live service, October 2026): the ArcGIS FeatureServer at
//   https://services.arcgis.com/apTfC6SUmnNfnxuF/arcgis/rest/services/AccelaDashBoard_MapService20211019/FeatureServer/0
// is real and publicly queryable with a plain GET (`?f=json` for metadata, `?where=...&outFields=*&
// f=json` for records — no auth). Its layer name is "GIS_Dashboard_Issued_CO_Merged" and its real
// field list (confirmed via `?f=json`) is: OBJECTID, PERMIT__, STATUS_1, TYPE, COMPLETE_DATE, PARCEL,
// ADDRESS, CITY_1, Value, OCCUPANCY_TYPE, OCCUPANCY_CATEGORY, DESCRIPTION, BEDROOMS, BATHROOMS,
// House_Cnt, Unit_Cnt, SF_Living, SF_Cover, SF_Total, CATEGORY, TYPE2, ISSUED_DATE, ACA_LINK,
// COMBINED_DATE. A 3-record sample pull confirmed COMPLETE_DATE/ISSUED_DATE are epoch-ms integers and
// DESCRIPTION is a free-text permit description (e.g. "NC17/COM/NEW/STOAGE BLDG #2/NR(C) #4187").
//
// IMPORTANT, CONFIRMED LIMITATION: this layer carries NO contractor-name or contractor-license field
// — it's an issued-CO (certificate of occupancy) dashboard layer, not a contractor-indexed permit
// roll. lookupPermits below can therefore only match a contractor name/license by free-text scanning
// DESCRIPTION (which sometimes, not reliably, embeds a contractor reference number like "NR(C)
// #4187" — not a usable cross-reference against a DBPR license number) — every returned PermitRecord
// here has `contractorName`/`contractorLicenseNumber` left undefined. This is an honest reflection of
// what the real endpoint returns, not a parsing gap; a future PR wanting real contractor-level permit
// data for Hillsborough would need a different county data source (e.g. its Accela Citizen Access
// portal, which this adapter does not attempt).

import type { PermitRecord } from "../types";

export const HILLSBOROUGH_FEATURE_SERVER_QUERY_URL =
  "https://services.arcgis.com/apTfC6SUmnNfnxuF/arcgis/rest/services/AccelaDashBoard_MapService20211019/FeatureServer/0/query";

function escapeSqlLiteral(s: string): string {
  return s.replace(/'/g, "''");
}

export function buildHillsboroughQueryUrl(searchTerm: string, resultRecordCount = 25): string {
  const where = `UPPER(DESCRIPTION) LIKE UPPER('%${escapeSqlLiteral(searchTerm)}%')`;
  const params = new URLSearchParams({ where, outFields: "*", f: "json", resultRecordCount: String(resultRecordCount) });
  return `${HILLSBOROUGH_FEATURE_SERVER_QUERY_URL}?${params.toString()}`;
}

export interface ArcGisFeature {
  attributes?: Record<string, unknown>;
}
export interface ArcGisQueryResponse {
  features?: ArcGisFeature[];
  error?: { code?: number; message?: string };
}

function epochToIsoDate(v: unknown): string | undefined {
  const n = typeof v === "number" ? v : undefined;
  if (n === undefined || !Number.isFinite(n)) return undefined;
  const d = new Date(n);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString().slice(0, 10);
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/** Parses one ArcGIS `query` response's `features[].attributes` into PermitRecord[]. Pure, and
 *  defensive: a malformed/empty/error response (missing `features`, non-array, an ArcGIS `.error`
 *  envelope) returns [] rather than throwing — a real, non-rare outcome for a public ArcGIS service
 *  under load or mid-schema-change. */
export function parseHillsboroughResponse(raw: unknown): PermitRecord[] {
  if (!raw || typeof raw !== "object") return [];
  const r = raw as ArcGisQueryResponse;
  if (r.error || !Array.isArray(r.features)) return [];

  const out: PermitRecord[] = [];
  for (const f of r.features) {
    const a = f?.attributes;
    if (!a || typeof a !== "object") continue;
    const permitNumber = str(a.PERMIT__);
    if (!permitNumber) continue;
    const city = str(a.CITY_1);
    const address = [str(a.ADDRESS), city].filter(Boolean).join(", ") || undefined;
    const value = typeof a.Value === "number" && Number.isFinite(a.Value) ? a.Value : undefined;
    out.push({
      permitNumber,
      jurisdiction: "hillsborough",
      contractorName: undefined, // see module doc — this layer carries no contractor field
      contractorLicenseNumber: undefined,
      description: str(a.DESCRIPTION),
      permitType: str(a.TYPE2) ?? str(a.TYPE),
      valuation: value,
      issueDate: epochToIsoDate(a.ISSUED_DATE) ?? epochToIsoDate(a.COMPLETE_DATE),
      status: str(a.STATUS_1),
      address,
    });
  }
  return out;
}

export interface HillsboroughPermitsDeps {
  fetchJson: (url: string) => Promise<unknown>;
}

async function defaultFetchJson(url: string): Promise<unknown> {
  const r = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`hillsborough permits query ${r.status}`);
  return r.json();
}

export const defaultHillsboroughPermitsDeps: HillsboroughPermitsDeps = { fetchJson: defaultFetchJson };

/**
 * Looks up Hillsborough permit/CO records by free-text contractor-name-or-license matching against
 * DESCRIPTION (see module doc for why this is the best this real endpoint supports). Never throws —
 * a fetch/parse failure returns [].
 */
export async function lookupPermits(contractorNameOrLicense: string, deps: HillsboroughPermitsDeps = defaultHillsboroughPermitsDeps): Promise<PermitRecord[]> {
  const term = contractorNameOrLicense.trim();
  if (!term) return [];
  try {
    const raw = await deps.fetchJson(buildHillsboroughQueryUrl(term));
    return parseHillsboroughResponse(raw);
  } catch {
    return [];
  }
}
