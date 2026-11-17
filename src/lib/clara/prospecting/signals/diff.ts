// signals/diff.ts — pure hashing/diff helpers shared by every signal check.
//
// hashContent uses the SAME algorithm (sha256, hex) as crawler/evidence.ts's writeEvidence, so a
// hash computed here is directly comparable to one computed there if a future PR wants to reuse
// evidence's own content_hash instead of re-hashing text itself.

import { createHash } from "node:crypto";

export function hashContent(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Whether a hash transition is a genuine, signal-worthy CHANGE.
 *
 * `prevHash === undefined` means this is the first time we've ever hashed this page/field for this
 * company — there is nothing to diff against, so that is a BASELINE, never a change. Only a real
 * hash-to-DIFFERENT-hash transition counts. This keeps a company's very first scan from firing a
 * "website changed" signal against nothing.
 */
export function diffChanged(prevHash: string | undefined, nextHash: string): boolean {
  if (prevHash === undefined) return false;
  return prevHash !== nextHash;
}
