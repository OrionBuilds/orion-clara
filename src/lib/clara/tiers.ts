// Clara — autonomy tier table.
//
// Every action Clara considers taking passes through can(). If posture is "auto" and any
// ceiling is respected, she proceeds. Otherwise she drafts and pushes for approval.
//
// Guardrails encoded here match the original design plan.

import type { ActionCategory, PrincipalId, Posture, TierRule } from "./types";
import { OWNER_FIRST } from "./owner";

const TABLE: TierRule[] = [
  { category: "calendar.external",   posture: "auto" },
  { category: "calendar.internal",   posture: "auto" },
  { category: "email.work",          posture: "auto",              note: `VIPs always escalate to ${OWNER_FIRST}` },
  { category: "email.personal",      posture: "blocked",           note: "Personal Gmail excluded by policy" },
  { category: "travel.research",     posture: "auto" },
  { category: "event.coordinate",    posture: "auto",              note: `${OWNER_FIRST} decides concept` },
  { category: "sensitive.read",      posture: "auto",              note: "Local LLM only — enforced in sensitivity.ts" },
  { category: "call.outbound",       posture: "auto" },
  { category: "call.business",       posture: "draft-then-approve", note: `Clara has no purchase power — calls to outside businesses always need ${OWNER_FIRST}'s OK first` },
  { category: "call.inbound",        posture: "auto" },
  { category: "sms.send",            posture: "auto" },
  { category: "drive.read",          posture: "auto" },
  { category: "drive.create",        posture: "auto",              note: "New files only — never overwrites existing work" },
  { category: "drive.modify",        posture: "draft-then-approve" },
  { category: "drive.delete",        posture: "draft-then-approve", note: "Trash only — permanent delete is never implemented" },
  { category: "drive.share",         posture: "blocked",           note: "The full Drive scope can grant public access — closed by policy" },
  { category: "research.run",        posture: "auto",              note: "Reads the supplied sources and answers from them — benign and reversible. Findings are treated as external/untrusted content." },
  { category: "prospect.research",   posture: "auto",              note: "Plan/status/pause/resume/cancel/export — reversible, never spends on its own." },
  { category: "prospect.spend",      posture: "auto",              note: "The job's own cost-table confirmation (\"go ahead\" / Run) is the money rule — no second approval row." },
];

export interface Decision {
  allow: boolean;
  posture: Posture;
  reason: string;
}

// `_requestor` is retained in the signature (callers still pass the principal) but no longer gates
// anything: there is no second authority tier, since Clara is executive-assistant-only.
export async function can(_requestor: PrincipalId, category: ActionCategory): Promise<Decision> {
  const rule = TABLE.find((r) => r.category === category);
  if (!rule) return { allow: false, posture: "blocked", reason: `unknown category: ${category}` };

  if (rule.posture === "blocked") return { allow: false, posture: "blocked", reason: rule.note ?? "blocked" };

  return { allow: rule.posture === "auto", posture: rule.posture, reason: rule.note ?? "per tier table" };
}

export function tierTable(): TierRule[] {
  return [...TABLE];
}
