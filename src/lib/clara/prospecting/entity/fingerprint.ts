// §11 — fingerprint match scoring between a discovered candidate and an existing company.
//
// Signals ADD (not max): domain 100 + phone 100 + place_id 100 + address 80 + name(≥0.85) 40. A
// single strong signal (domain/phone/place_id) alone already clears the merge floor; address or
// name alone land in "possible duplicate"; address+name together clear it too. This mirrors the
// blueprint's §11 formula directly rather than picking the single best signal, so two independent
// weak-ish signals can still add up to a confident merge.

import { isAggregatorDomain, type NormalizedCandidate } from "./normalize";

export interface ExistingEntity extends NormalizedCandidate {
  id: string;
}

export const SCORE = { domain: 100, phone: 100, placeId: 100, address: 80, name: 40 } as const;
export const NAME_SIMILARITY_THRESHOLD = 0.85;

/** Normalized Levenshtein similarity in [0,1]. Adequate at company-name lengths; no external dep. */
export function nameSimilarity(a: string, b: string): number {
  if (!a && !b) return 1;
  if (!a || !b) return 0;
  if (a === b) return 1;
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
    }
  }
  const dist = dp[m][n];
  return 1 - dist / Math.max(m, n);
}

export interface MatchResult {
  score: number;
  matchedOn: string[];
}

export function matchScore(a: NormalizedCandidate, b: ExistingEntity): MatchResult {
  const matchedOn: string[] = [];
  let score = 0;
  if (a.domain && b.domain && a.domain === b.domain && !isAggregatorDomain(a.domain)) {
    score += SCORE.domain;
    matchedOn.push("domain");
  }
  if (a.phoneKey && b.phoneKey && a.phoneKey === b.phoneKey) {
    score += SCORE.phone;
    matchedOn.push("phone");
  }
  if (a.placeId && b.placeId && a.placeId === b.placeId) {
    score += SCORE.placeId;
    matchedOn.push("place_id");
  }
  if (a.addressKey && b.addressKey && a.addressKey === b.addressKey) {
    score += SCORE.address;
    matchedOn.push("address");
  }
  if (a.normalizedName && b.normalizedName && nameSimilarity(a.normalizedName, b.normalizedName) >= NAME_SIMILARITY_THRESHOLD) {
    score += SCORE.name;
    matchedOn.push("name");
  }
  return { score, matchedOn };
}
