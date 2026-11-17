// §11 — entity normalization: the inputs fingerprinting and resolution compare.
//
// Pure string munging, no I/O. Kept deliberately simple (no public-suffix list, no libphonenumber)
// — the roofing/home-service space is overwhelmingly .com/.net/.org and US phone numbers, and the
// worst case of the simplifications below is "slightly too eager to call two things the same",
// which the fingerprint score's other signals (phone, place_id, address) catch anyway.

import type { DiscoveredCandidate } from "../types";

/** Domains that host many companies' listings — a shared domain here is not evidence of being the
 *  same company (two roofers both having a Yelp page). Checked before counting a domain match. */
export const AGGREGATOR_DOMAINS: ReadonlySet<string> = new Set([
  "facebook.com", "yelp.com", "angi.com", "homeadvisor.com", "thumbtack.com", "bbb.org",
  "yellowpages.com", "mapquest.com", "nextdoor.com", "instagram.com", "linkedin.com",
  "manta.com", "chamberofcommerce.com", "superpages.com", "foursquare.com", "google.com",
  "indeed.com", "glassdoor.com", "buildzoom.com", "porch.com", "houzz.com", "x.com", "twitter.com",
]);

/** etld+1-ish: strips scheme/path/www/port, lowercases, keeps the last two labels. Good enough
 *  without a public-suffix list for this vertical; worst case over-coarsens a rare co.uk-style
 *  domain, which only makes dedupe slightly more eager, never less. */
export function normalizeDomain(raw: string | undefined | null): string | undefined {
  if (!raw) return undefined;
  let s = raw.trim().toLowerCase();
  if (!s) return undefined;
  s = s.replace(/^https?:\/\//, "").replace(/^www\./, "");
  s = s.split("/")[0].split("?")[0].split("#")[0].split(":")[0];
  if (!s || !s.includes(".")) return undefined;
  const parts = s.split(".").filter(Boolean);
  return parts.length > 2 ? parts.slice(-2).join(".") : s;
}

export function isAggregatorDomain(domain: string | undefined): boolean {
  return Boolean(domain && AGGREGATOR_DOMAINS.has(domain));
}

/** US-centric key: digits only, last 10 kept (drops a leading country code of 1). Numbers that
 *  don't reduce to 10 digits (bad data, extensions) normalize to undefined rather than a false match. */
export function normalizePhoneKey(raw: string | undefined | null): string | undefined {
  if (!raw) return undefined;
  const digits = raw.replace(/\D/g, "");
  if (!digits) return undefined;
  const last10 = digits.length > 10 ? digits.slice(-10) : digits;
  return last10.length === 10 ? last10 : undefined;
}

const LEGAL_SUFFIX_RE = /\b(llc|inc|incorporated|corp|corporation|co|company|ltd|llp|pllc)\.?\b/g;

export function normalizeName(raw: string | undefined | null): string {
  if (!raw) return "";
  return raw
    .toLowerCase()
    .replace(/[.,'’]/g, "")
    .replace(LEGAL_SUFFIX_RE, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function normalizeAddressKey(address?: { line1?: string; city?: string; state?: string; postal_code?: string }): string | undefined {
  if (!address) return undefined;
  const line1 = (address.line1 ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const zip = (address.postal_code ?? "").trim().slice(0, 5);
  if (!line1 || !zip) return undefined;
  return `${line1}|${zip}`;
}

export interface NormalizedCandidate {
  name: string;
  normalizedName: string;
  domain?: string;
  phoneKey?: string;
  placeId?: string;
  addressKey?: string;
}

export function normalizeCandidate(c: DiscoveredCandidate): NormalizedCandidate {
  return {
    name: c.name,
    normalizedName: normalizeName(c.name),
    domain: normalizeDomain(c.website_url),
    phoneKey: normalizePhoneKey(c.phone),
    placeId: c.google_place_id,
    addressKey: normalizeAddressKey(c.address),
  };
}
