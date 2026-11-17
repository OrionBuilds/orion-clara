// sequencePreview.ts — PR 15: renders one sequence step against a real company for the Office
// builder's "Preview" panel (SequencePreview.tsx) — no send, no enrollment. Orchestrates
// sequencesGet (find the step at the requested position) + companiesGetFull (facts/signals/
// people) + personalize.ts's AI-slot fill + sequenceRunner.ts's {{token}} substitution: the same
// pipeline a real send uses, minus the actual send and minus the compliance footer (the preview
// shows raw copy, not the mailed version — appendComplianceFooter is sequenceRunner's job alone).
//
// Deps-injected (not a thin osBridge-calling route body) so the whole pipeline — including the
// AI generation step — is testable without a live OS connection or a live Anthropic call; see
// sequencePreview.test.ts.

import { renderStep as renderStepReal, type RenderStepResult } from "./personalize";
import { BOOKING_URL } from "./branding";
import { renderTemplate, pickSubjectVariant, topFacts, recentSignals } from "./sequenceRunner";
import {
  sequencesGet as sequencesGetReal,
  companiesGetFull as companiesGetFullReal,
  type SequenceStep,
  type CompanyFactRow,
  type SignalRow,
} from "./osBridge";

export interface SequencePreviewDeps {
  sequencesGet: typeof sequencesGetReal;
  companiesGetFull: typeof companiesGetFullReal;
  renderStep: typeof renderStepReal;
}
export const defaultSequencePreviewDeps: SequencePreviewDeps = {
  sequencesGet: sequencesGetReal,
  companiesGetFull: companiesGetFullReal,
  renderStep: renderStepReal,
};

export interface SequencePreviewResult {
  subject?: string;
  body?: string;
  task_title?: string;
  /** slot name → resolved source URLs (what the cited fact/signal's `source_url` points at; a
   *  citation with no source_url on file renders as `#fact:<id>` / `#signal:<id>` so the Office's
   *  "source N ↗" link still appears, just non-navigating, rather than silently disappearing). */
  citations: Record<string, string[]>;
  rationale?: string;
  used_fallback: boolean;
}

export type SequencePreviewError =
  | { kind: "sequence_not_found" }
  | { kind: "step_not_found"; position: number }
  | { kind: "company_not_found" };

export type SequencePreviewOutcome = { ok: true; result: SequencePreviewResult } | { ok: false; error: SequencePreviewError };

function citationUrls(ids: string[], facts: readonly CompanyFactRow[], signals: readonly SignalRow[]): string[] {
  return ids.map((c) => {
    const [kind, id] = c.split(":");
    const row = kind === "fact" ? facts.find((f) => f.id === id) : kind === "signal" ? signals.find((s) => s.id === id) : undefined;
    return row?.source_url || `#${c}`;
  });
}

interface PickedContact {
  fullName: string;
  firstName?: string;
  title?: string;
}
/** Prefers a flagged decision-maker; falls back to the first known person; falls back (when the
 *  company has no people on file yet) to a generic "there" greeting rather than blocking preview. */
function pickContact(people: ReadonlyArray<Record<string, unknown>>): PickedContact | undefined {
  const chosen = people.find((p) => p.is_decision_maker === true) ?? people[0];
  if (!chosen || typeof chosen.full_name !== "string" || !chosen.full_name) return undefined;
  return {
    fullName: chosen.full_name,
    firstName: typeof chosen.first_name === "string" && chosen.first_name ? chosen.first_name : chosen.full_name.split(" ")[0],
    title: typeof chosen.title === "string" ? chosen.title : undefined,
  };
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}

export async function renderSequencePreview(
  args: { sequenceId: string; companyId: string; stepPosition: number },
  deps: SequencePreviewDeps = defaultSequencePreviewDeps,
): Promise<SequencePreviewOutcome> {
  const detail = await deps.sequencesGet(args.sequenceId);
  if (!detail.sequence) return { ok: false, error: { kind: "sequence_not_found" } };

  const step: SequenceStep | undefined = detail.steps.find((s) => s.position === args.stepPosition);
  if (!step) return { ok: false, error: { kind: "step_not_found", position: args.stepPosition } };

  const full = await deps.companiesGetFull(args.companyId);
  if (typeof full.company.id !== "string" || !full.company.id) return { ok: false, error: { kind: "company_not_found" } };

  const facts = topFacts(full.facts);
  const signals = recentSignals(full.signals as unknown as SignalRow[]);
  const companyName = str(full.company.name) ?? "";
  const contact = pickContact(full.people) ?? { fullName: companyName || "there" };

  const rendered: RenderStepResult = await deps.renderStep(
    {
      contact: { fullName: contact.fullName, firstName: contact.firstName, title: contact.title },
      company: { name: companyName, city: str(full.company.city), state: str(full.company.state) },
      facts,
      signals,
      template: { subject: step.template.subject, body: step.template.body },
      aiSlots: (step.ai_slots ?? []).map((s) => ({ name: s.name, maxWords: s.max_words, mustCite: s.must_cite, fallback: s.fallback })),
      priorTouches: [],
    },
    undefined,
  );

  const crmFact = facts.find((f) => f.field_name === "crm");
  const tokens: Record<string, string> = {
    "contact.first_name": contact.firstName || contact.fullName.split(" ")[0] || "there",
    "company.name": companyName,
    "fact.crm": typeof crmFact?.value === "string" ? crmFact.value : "",
    "signal.latest.headline": signals[0]?.headline ?? "",
    "book_url": BOOKING_URL,
  };
  for (const [name, text] of Object.entries(rendered.slots)) tokens[`ai:${name}`] = text;

  const citations: Record<string, string[]> = {};
  for (const [slot, ids] of Object.entries(rendered.citations)) citations[slot] = citationUrls(ids, facts, signals);

  const result: SequencePreviewResult = { citations, used_fallback: rendered.usedFallback, rationale: rendered.rationale };
  if (step.template.subject !== undefined || step.template.subject_variants?.length) {
    const variant = pickSubjectVariant(args.companyId, step.template.subject_variants, step.template.subject);
    result.subject = renderTemplate(variant.text ?? "", tokens).text;
  }
  result.body = renderTemplate(step.template.body, tokens).text;
  if (step.template.task_title) result.task_title = renderTemplate(step.template.task_title, tokens).text;
  return { ok: true, result };
}
