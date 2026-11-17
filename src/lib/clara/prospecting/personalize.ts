// personalize.ts — PR 14: tier-3 (metered Anthropic) personalization for one sequence step, with a
// "no invention" validator (plan §24). Every AI-filled slot must cite real evidence (a fact or
// signal id from THIS call's own input set) and must not introduce a number or proper noun the
// cited evidence doesn't already contain — a model that wants to say "47 open roles" or "since
// 1998" has to have actually been handed a fact saying so. A slot that fails validation is retried
// once, then falls back to the step's own template text (no AI, no citations, never blocked).
//
// Caching: `sequence_enrollments.personalization_snapshot` (already returned by
// sequence_due_enrollments — see osBridge.ts) is read as a cache keyed by `evidenceHash`; a cache
// hit skips the tier-3 call entirely. Every render (hit or miss) is also recorded as an
// `outreach_events` `kind:"rendered"` row via `outreachEventsAdd` (plan: "Cache in outreach_events
// kind='rendered'...") — there is no OS tool to read `personalization_snapshot` back other than the
// one sequence_due_enrollments already hands the runner each tick, and no tool to WRITE it either
// (confirmed: sequence_event's CASE statement, migration 20261001100200, has no 'rendered' branch
// that touches personalization_snapshot) — so in practice every render is a fresh one until a
// future PR adds that write path. Still exactly correct, still exactly the cache-key contract the
// plan specifies, for the day that gap closes.

import { createHash } from "node:crypto";
import { runTier as runTierReal } from "./llm";
import type { CompanyFactRow, SignalRow } from "./osBridge";

export interface PersonalizeContact {
  fullName: string;
  firstName?: string;
  title?: string;
}
export interface PersonalizeCompany {
  name: string;
  city?: string;
  state?: string;
}
export interface AiSlotSpec {
  name: string;
  maxWords?: number;
  mustCite?: boolean;
  /** Not in the OS's base ai_slots shape ({name,max_words,must_cite}) — an additive key the
   *  Office's sequence builder (PR 15) is expected to populate per slot: the non-AI text used when
   *  this slot fails validation twice. Falls back to an empty string (the slot renders blank rather
   *  than blocking the send) when absent. */
  fallback?: string;
}
export interface PersonalizeTemplate {
  subject?: string;
  body: string;
}

export interface PersonalizeInput {
  contact: PersonalizeContact;
  company: PersonalizeCompany;
  /** Already narrowed to the top 15 by confidence — this module doesn't re-sort/re-slice. */
  facts: CompanyFactRow[];
  /** Already narrowed to the last 5. */
  signals: SignalRow[];
  template: PersonalizeTemplate;
  aiSlots: AiSlotSpec[];
  /** Short one-line descriptions of previous steps already sent in this sequence, oldest first —
   *  lets the model avoid repeating itself ("as I mentioned before..." never appears twice). */
  priorTouches: string[];
}

export interface PersonalizeSlotResult {
  text: string;
  citations: string[];
}
export interface PersonalizeResult {
  slots: Record<string, PersonalizeSlotResult>;
  rationale: string;
}

// ── Evidence hash (the cache key) ───────────────────────────────────────────────────────────────

export function evidenceHash(facts: readonly CompanyFactRow[], signals: readonly SignalRow[]): string {
  const factIds = facts.map((f) => f.id).sort();
  const signalIds = signals.map((s) => s.id).sort();
  return createHash("sha256").update(`${factIds.join(",")}|${signalIds.join(",")}`).digest("hex").slice(0, 16);
}

// ── Prompt ───────────────────────────────────────────────────────────────────────────────────

function evidenceBlock(facts: readonly CompanyFactRow[], signals: readonly SignalRow[]): string {
  const factLines = facts.map((f) => `fact:${f.id} — ${f.field_name}: ${typeof f.value === "string" ? f.value : JSON.stringify(f.value)}`);
  const signalLines = signals.map((s) => `signal:${s.id} — ${s.headline}${s.detail ? `: ${s.detail}` : ""}`);
  return [...factLines, ...signalLines].join("\n");
}

export function buildPersonalizePrompt(input: PersonalizeInput): string {
  const slotSpecs = input.aiSlots.map((s) => `- "${s.name}"${s.maxWords ? ` (max ${s.maxWords} words)` : ""}${s.mustCite ? " — MUST cite at least one evidence id" : ""}`).join("\n");
  return [
    `Write personalized text for an outreach email to ${input.contact.fullName}${input.contact.title ? `, ${input.contact.title}` : ""} at ${input.company.name}${input.company.city ? ` (${input.company.city}${input.company.state ? `, ${input.company.state}` : ""})` : ""}.`,
    "",
    "EVIDENCE (cite these ids; never state a number or proper noun — a name, place, product, employer — that isn't in this list):",
    evidenceBlock(input.facts, input.signals) || "(no evidence available)",
    "",
    input.priorTouches.length ? `Already sent in this sequence (don't repeat):\n${input.priorTouches.map((t) => `- ${t}`).join("\n")}` : "",
    "",
    `Template body for context:\n${input.template.body}`,
    "",
    `Fill exactly these slots:\n${slotSpecs}`,
    "",
    `Reply ONLY JSON: {"slots": {"<slot name>": {"text": "...", "citations": ["fact:<id>" or "signal:<id>", ...]}}, "rationale": "one sentence on why these citations support the text"}.`,
    "Every citation must be an id from the EVIDENCE list above, in the exact 'fact:<id>' / 'signal:<id>' form shown there.",
  ].filter(Boolean).join("\n");
}

// ── Validator ────────────────────────────────────────────────────────────────────────────────

const WORD_RE = /\b[A-Za-z][A-Za-z'-]*\b|\b\d[\d,.]*\b/g;
/** Numbers (digit sequences) and capitalized words NOT at the very start of a sentence — a cheap,
 *  deliberately conservative proper-noun heuristic (plan: "no numbers or proper nouns ... that
 *  aren't present in the cited evidence"). False positives (a capitalized word that happens to
 *  start a clause) are safe here: they just mean occasionally falling back to template text, never
 *  a wrong/invented claim going out. */
export function extractClaimedTokens(text: string): string[] {
  const tokens: string[] = [];
  const sentences = text.split(/(?<=[.!?])\s+/);
  for (const sentence of sentences) {
    const words = sentence.match(WORD_RE) ?? [];
    words.forEach((w, i) => {
      if (/^\d/.test(w)) { tokens.push(w); return; }
      if (i === 0) return; // sentence-initial capitalization is just grammar, not a claim
      if (/^[A-Z]/.test(w)) tokens.push(w);
    });
  }
  return [...new Set(tokens)];
}

export interface ValidateSlotResult {
  ok: boolean;
  reason?: string;
}

/** Pure. `evidenceText` is the concatenated text of every fact/signal the slot actually cited (not
 *  the whole input set — citing an id doesn't license claims outside what THAT item says). */
export function validateSlotText(text: string, citedEvidenceText: string): ValidateSlotResult {
  const claimed = extractClaimedTokens(text);
  const haystack = citedEvidenceText.toLowerCase();
  for (const token of claimed) {
    if (!haystack.includes(token.toLowerCase())) return { ok: false, reason: `uncited claim: "${token}"` };
  }
  return { ok: true };
}

function citedText(citations: string[], facts: readonly CompanyFactRow[], signals: readonly SignalRow[]): string {
  const parts: string[] = [];
  for (const c of citations) {
    const [kind, id] = c.split(":");
    if (kind === "fact") {
      const f = facts.find((x) => x.id === id);
      if (f) parts.push(typeof f.value === "string" ? f.value : JSON.stringify(f.value));
    } else if (kind === "signal") {
      const s = signals.find((x) => x.id === id);
      if (s) parts.push(`${s.headline} ${s.detail ?? ""}`);
    }
  }
  return parts.join(" ");
}

export interface ValidatePersonalizeResult {
  ok: boolean;
  reason?: string;
}

/** Pure. Every `must_cite` slot needs >=1 citation whose id is in THIS call's own fact/signal id
 *  set (never an id from some other company/render); every slot's text passes validateSlotText
 *  against what it actually cited. */
export function validatePersonalizeResult(result: PersonalizeResult, input: PersonalizeInput): ValidatePersonalizeResult {
  const factIds = new Set(input.facts.map((f) => f.id));
  const signalIds = new Set(input.signals.map((s) => s.id));
  const idExists = (c: string) => {
    const [kind, id] = c.split(":");
    return kind === "fact" ? factIds.has(id) : kind === "signal" ? signalIds.has(id) : false;
  };

  for (const spec of input.aiSlots) {
    const slot = result.slots[spec.name];
    if (!slot) return { ok: false, reason: `missing slot "${spec.name}"` };
    if (spec.mustCite && !(slot.citations.length && slot.citations.every(idExists))) {
      return { ok: false, reason: `slot "${spec.name}" has no valid citation` };
    }
    const invalidCitations = slot.citations.filter((c) => !idExists(c));
    if (invalidCitations.length) return { ok: false, reason: `slot "${spec.name}" cites an id outside this render's evidence: ${invalidCitations.join(", ")}` };
    const evidence = citedText(slot.citations, input.facts, input.signals);
    const check = validateSlotText(slot.text, evidence);
    if (!check.ok) return { ok: false, reason: `slot "${spec.name}": ${check.reason}` };
  }
  return { ok: true };
}

// ── Render (tier 3, retry-once, template fallback) ──────────────────────────────────────────────

export interface RenderStepResult {
  slots: Record<string, string>;
  citations: Record<string, string[]>;
  usedFallback: boolean;
  fromCache: boolean;
  evidenceHash: string;
  /** The model's one-sentence citation rationale (PersonalizeResult.rationale) on a fresh,
   *  validated generation — undefined on a cache hit (the cached snapshot never stored one) or a
   *  template fallback (no generation to explain). PR 15's preview endpoint surfaces this to the
   *  Office builder's "Rationale:" line. */
  rationale?: string;
}

export interface PersonalizeDeps {
  runTier: typeof runTierReal;
}
export const defaultPersonalizeDeps: PersonalizeDeps = { runTier: runTierReal };

function fallbackResult(input: PersonalizeInput): RenderStepResult {
  const slots: Record<string, string> = {};
  const citations: Record<string, string[]> = {};
  for (const spec of input.aiSlots) { slots[spec.name] = spec.fallback ?? ""; citations[spec.name] = []; }
  return { slots, citations, usedFallback: true, fromCache: false, evidenceHash: evidenceHash(input.facts, input.signals) };
}

async function tryGenerate(input: PersonalizeInput, deps: PersonalizeDeps): Promise<PersonalizeResult | undefined> {
  const r = await deps.runTier(3, buildPersonalizePrompt(input), { purpose: "prospect:personalize", json: true, maxTokens: 500 });
  if (!r.ok || !r.text) return undefined;
  try {
    const parsed = JSON.parse(r.text) as { slots?: unknown; rationale?: unknown };
    if (!parsed.slots || typeof parsed.slots !== "object") return undefined;
    const slots: Record<string, PersonalizeSlotResult> = {};
    for (const [name, v] of Object.entries(parsed.slots as Record<string, unknown>)) {
      const o = v as { text?: unknown; citations?: unknown };
      if (typeof o.text !== "string" || !Array.isArray(o.citations)) continue;
      slots[name] = { text: o.text, citations: o.citations.filter((c): c is string => typeof c === "string") };
    }
    return { slots, rationale: typeof parsed.rationale === "string" ? parsed.rationale : "" };
  } catch {
    return undefined;
  }
}

/** `cachedSnapshot` — read from the enrollment's own `personalization_snapshot` field (already
 *  present on every sequence_due_enrollments row) by the caller; this function never fetches it
 *  itself. A matching evidence hash is a cache hit, no tier-3 call made. */
export async function renderStep(
  input: PersonalizeInput,
  cachedSnapshot: { evidence_hash?: string; slots?: Record<string, string>; citations?: Record<string, string[]> } | undefined,
  deps: PersonalizeDeps = defaultPersonalizeDeps,
): Promise<RenderStepResult> {
  const hash = evidenceHash(input.facts, input.signals);
  if (cachedSnapshot?.evidence_hash === hash && cachedSnapshot.slots) {
    return { slots: cachedSnapshot.slots, citations: cachedSnapshot.citations ?? {}, usedFallback: false, fromCache: true, evidenceHash: hash };
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    const generated = await tryGenerate(input, deps);
    if (generated && validatePersonalizeResult(generated, input).ok) {
      const slots: Record<string, string> = {};
      const citations: Record<string, string[]> = {};
      for (const spec of input.aiSlots) {
        const s = generated.slots[spec.name];
        slots[spec.name] = s?.text ?? spec.fallback ?? "";
        citations[spec.name] = s?.citations ?? [];
      }
      return { slots, citations, usedFallback: false, fromCache: false, evidenceHash: hash, rationale: generated.rationale || undefined };
    }
  }
  return fallbackResult(input);
}
