// intel/callBrief.ts — PR 12: tier-3 call brief generation on promotion (plan §25: "call brief
// (tier 3: facts + signals + opener + objections)"). Stored both in the Drive research doc (see
// report/composeCompany.ts) and as a `call_brief` fact on the company (so it shows up in the
// Office's Facts tab and survives even if the Drive doc upload fails).
//
// Tier 3, not tier 2: a human-facing opener/objection script is exactly the kind of judgment call
// the plan reserves for the metered Anthropic path (extract/qualify.ts's own tier-3 escalation is
// the precedent) — never the claude CLI, never free-tier LM Studio for this one.

import { runTier as runTierReal } from "../llm";
import type { CompanyFullRow } from "../osBridge";
import type { CompanyTimelineRow } from "../osBridge";
import { BUSINESS_NAME, BUSINESS_PITCH } from "../branding";

export interface CallBrief {
  opener: string;
  talkingPoints: string[];
  objections: { objection: string; response: string }[];
}

function isCallBrief(v: unknown): v is CallBrief {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return typeof o.opener === "string"
    && Array.isArray(o.talkingPoints) && o.talkingPoints.every((t) => typeof t === "string")
    && Array.isArray(o.objections) && o.objections.every((x) => x && typeof x === "object" && typeof (x as Record<string, unknown>).objection === "string" && typeof (x as Record<string, unknown>).response === "string");
}

function str(v: unknown): string {
  return typeof v === "string" ? v : v === null || v === undefined ? "" : String(v);
}

export function buildCallBriefPrompt(full: CompanyFullRow, timeline: CompanyTimelineRow[]): string {
  const name = str(full.company.name) || "this company";
  const industry = Array.isArray(full.company.industry) ? (full.company.industry as unknown[]).join("/") : "home services";
  const dm = full.people.find((p) => p.is_decision_maker) ?? full.people[0];
  const topFacts = [...full.facts].sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0)).slice(0, 10)
    .map((f) => `${f.field_name}: ${typeof f.value === "string" ? f.value : JSON.stringify(f.value)}`);
  const topSignals = full.signals.slice(0, 5).map((s) => str(s.headline));
  const recentTimeline = timeline.slice(0, 5).map((t) => t.summary ?? t.event_type ?? "").filter(Boolean);

  return [
    `You are writing a short call brief for a salesperson about to call ${name}, a ${industry} business, about ${BUSINESS_NAME}'s services (${BUSINESS_PITCH}).`,
    dm ? `The decision maker is ${str(dm.full_name)}${dm.title ? `, ${str(dm.title)}` : ""}.` : "No confirmed decision maker yet — address the business generically.",
    topFacts.length ? `Known facts:\n${topFacts.map((f) => `- ${f}`).join("\n")}` : "",
    topSignals.length ? `Recent buying signals:\n${topSignals.map((s) => `- ${s}`).join("\n")}` : "",
    recentTimeline.length ? `Recent activity:\n${recentTimeline.map((s) => `- ${s}`).join("\n")}` : "",
    "",
    "Write a one-sentence opener referencing something SPECIFIC and true about this company (from the facts/signals above — never invent a detail not listed), 2-4 short talking points, and 2-3 likely objections with a one-line response to each.",
    `Reply ONLY JSON: {"opener": "...", "talkingPoints": ["...", "..."], "objections": [{"objection": "...", "response": "..."}]}`,
  ].filter(Boolean).join("\n\n");
}

export interface CallBriefDeps {
  runTier: typeof runTierReal;
}
export const defaultCallBriefDeps: CallBriefDeps = { runTier: runTierReal };

export async function composeCallBrief(full: CompanyFullRow, timeline: CompanyTimelineRow[], deps: CallBriefDeps = defaultCallBriefDeps): Promise<CallBrief | undefined> {
  const r = await deps.runTier(3, buildCallBriefPrompt(full, timeline), { purpose: "prospect:call_brief", json: true, maxTokens: 500 });
  if (!r.ok || !r.text) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(r.text);
  } catch {
    return undefined;
  }
  return isCallBrief(parsed) ? parsed : undefined;
}
