// publicdata/types.ts — shared types for PR 9's Florida public-data adapters: DBPR (contractor
// licenses), Sunbiz (business entities) and the two county permit adapters. Plain data only — each
// adapter normalizes whatever shape its real (or best-researched) source returns into these, so
// publicdata/index.ts and intel/revenue.ts never deal with provider-specific field names.

/** A Florida DBPR (Dept of Business & Professional Regulation) contractor license record, normalized
 *  off the bulk licensee extract (see flDbpr.ts's header comment for exactly what's confirmed vs.
 *  researched about that file's real column layout). */
export interface DbprRecord {
  /** e.g. "CCC1234567". The board-prefixed license number DBPR uses as its public identifier. */
  licenseNumber: string;
  /** Raw license-type code from the extract, e.g. "CCC", "RC". */
  licenseType: string;
  /** Human label for `licenseType` when known (flDbpr.ts's LICENSE_TYPE_LABELS table). */
  licenseTypeLabel?: string;
  /** The individual licensee of record (DBPR licenses are issued to a person, not a company). */
  licenseeName: string;
  /** DBA / business name on file, when the extract carries one — this is what name-matching runs
   *  against first; licenseeName is the fallback. */
  businessName?: string;
  /** Raw status text from the file, e.g. "Current", "Active", "Delinquent", "Null and Void". */
  status: string;
  /** Derived: true when `status` normalizes to an active/good-standing state (see flDbpr.ts's
   *  ACTIVE_STATUS_VALUES) — the signal publicdata/index.ts's fit-score bump actually checks. */
  statusActive: boolean;
  address?: { line1?: string; city?: string; state?: string; postalCode?: string };
  issueDate?: string;
  expiryDate?: string;
}

/** A Florida Sunbiz business-entity record, parsed off a search.sunbiz.org result page's text (see
 *  flSunbiz.ts's header comment). */
export interface SunbizRecord {
  entityName: string;
  documentNumber: string;
  status: string;
  statusActive: boolean;
  entityType?: string;
  filingDate?: string;
  registeredAgentName?: string;
  registeredAgentAddress?: string;
  principalAddress?: string;
  officers?: { name: string; title?: string }[];
}

export type PermitJurisdiction = "hillsborough" | "pinellas";

/** A county building/permit record. The two counties' real field names differ (see
 *  flPermits/hillsborough.ts and flPermits/pinellas.ts for exactly what each adapter maps from) —
 *  this is the normalized shape both produce. */
export interface PermitRecord {
  permitNumber: string;
  jurisdiction: PermitJurisdiction;
  contractorName?: string;
  contractorLicenseNumber?: string;
  description?: string;
  permitType?: string;
  /** Declared job/permit value in USD, when the source carries one. */
  valuation?: number;
  issueDate?: string;
  status?: string;
  address?: string;
}

/** The shared lookup-by-name-or-license input the three adapter families all accept a version of.
 *  DBPR hands permit adapters a license number to cross-reference against a contractor-name match. */
export interface PublicDataLookupInput {
  name: string;
  state?: string;
  licenseNumber?: string;
  city?: string;
}
