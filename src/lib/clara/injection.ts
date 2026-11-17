// Clara — inbound prompt-injection defense. Port of FRIDAY's src/lib/friday/promptInjection.ts,
// with tool-name callouts updated to Clara's own internals, and wired more broadly than FRIDAY's
// (SMS/voice only there) — Clara's threat surface includes OCR'd documents and researched
// research findings, both of which can drive a spend/booking approval, not just a reply.
//
// Two-layer detection, both pure + side-effect-free:
//   1. Canary token check — proof of prompt exfiltration if a seeded canary comes back in
//      inbound content. A canary hit is proof, not a heuristic guess, so it hard-blocks
//      regardless of CLARA_INJECTION_HARD (a deliberate improvement over FRIDAY, where every
//      trigger — canary or keyword — is fail-open by default).
//   2. Heuristic classifier — deterministic pattern match for the common injection shapes.
//
// Fail-open by DEFAULT for keyword matches (log + page the owner; the reply/action still proceeds) —
// the classifier is string-matched, so a false positive on a legitimate message must never
// suppress it. Set CLARA_INJECTION_HARD=1 to flip keyword matches to hard-suppress too.

import { OWNER_FIRST } from "./owner";

// The owner's first name, regex-escaped, for the impersonation pattern below (from the owner profile).
const OWNER_RX = OWNER_FIRST.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").toLowerCase();

export interface InjectionVerdict {
  triggered: boolean;
  reasons: string[];
  canaryLeak?: string;
  hardBlock: boolean; // true for a canary leak, or a keyword match when CLARA_INJECTION_HARD=1
}

function canaries(): string[] {
  const raw = (process.env.CLARA_PROMPT_CANARIES ?? "").trim();
  if (!raw) return [];
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

export function injectionHardSuppressEnabled(): boolean {
  return (process.env.CLARA_INJECTION_HARD ?? "").trim() === "1";
}

// Ordered most-specific to least so the first match wins the "primary reason" label. Single-line
// patterns (no multiline flag) — cross-line matching risks catching innocuous multi-sentence text.
const PATTERNS: Array<[RegExp, string]> = [
  [/\b(ignore|disregard|forget)\s+(all\s+)?(prior|previous|earlier|above|the)\s+(instructions?|prompts?|rules?|context)/i, "ignore-previous-instructions"],
  [/\byou\s+are\s+now\s+(a|an|the)\b/i, "role-override"],
  [/\bnew\s+(system|role|persona|instructions?)[:\s]/i, "new-system-role"],
  [/\bpretend\s+(you|to\s+be)/i, "pretend-to-be"],
  [/\bact\s+as\s+(a|an|the|if)\b/i, "act-as-different-role"],
  [/\b(reveal|show|print|repeat|output|display)\s+(your|the)\s+(system\s+)?(prompt|instructions?|rules?)/i, "prompt-exfiltration"],
  [/\bwhat\s+(are|were)\s+your\s+(system\s+)?(instructions?|prompts?|rules?)/i, "prompt-exfiltration-question"],
  [/\b(DAN|jailbreak|developer\s+mode)\b/i, "jailbreak-phrase"],
  [/\bbypass\s+(your|the)\s+(safety|rules?|restrictions?|filters?)/i, "bypass-safety"],
  // Owner impersonation — matters because ownerCommands.ts already gates by verified
  // OWNER_PHONE, not claimed identity in text; this pattern is the detection/alerting half of
  // that same principle, for content that isn't itself the approval-command channel.
  [new RegExp(`\\b(this\\s+is\\s+${OWNER_RX}|${OWNER_RX}\\s+here|from\\s+${OWNER_RX}|on\\s+behalf\\s+of\\s+${OWNER_RX}|${OWNER_RX}\\s+(said|asked|told)\\s+me)`, "i"), "owner-impersonation"],
  [/\bapprove\s+(the|all|any|my)\s+(pending|open|next)?\s*approvals?/i, "approve-approvals-command"],
  // Clara's own internal identifiers — a client/stranger shouldn't know these names, so seeing
  // one is a sign someone is trying to invoke Clara's internals by name.
  [/\b(placeApprovedBusinessCall|findBusiness|mergeDocuments|notifyOwner|queueApproval|dispatchApproval|CLARA_(?:DISABLE_AUTH|SESSION_SECRET))\b/i, "tool-name-callout"],
  [/(?:<\/system>|<\/instructions>|```\s*end\s+of\s+system)/i, "delimiter-smuggling"],
  [/\b(curl|wget|fetch)\s+http[s]?:\/\//i, "shell-command-injection"],
];

/** Deterministic scan of untrusted inbound content (SMS, email, OCR'd text, research findings). */
export function detectPromptInjection(text: string | undefined): InjectionVerdict {
  const s = String(text ?? "");
  if (!s.trim()) return { triggered: false, reasons: [], hardBlock: false };

  const reasons: string[] = [];
  let canaryLeak: string | undefined;
  for (const canary of canaries()) {
    if (canary && s.includes(canary)) {
      canaryLeak = canary;
      reasons.push(`canary-leak:${canary.slice(0, 12)}`);
      break;
    }
  }
  for (const [re, label] of PATTERNS) {
    if (re.test(s)) reasons.push(label);
  }

  const triggered = reasons.length > 0;
  const hardBlock = Boolean(canaryLeak) || (triggered && injectionHardSuppressEnabled());
  return { triggered, reasons, canaryLeak, hardBlock };
}
