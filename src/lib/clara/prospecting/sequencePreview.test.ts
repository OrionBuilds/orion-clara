import { test } from "node:test";
import assert from "node:assert/strict";
import { renderSequencePreview, type SequencePreviewDeps } from "./sequencePreview";
import type { SequencesGetResult, CompanyFullRow } from "./osBridge";

function sequenceDetail(overrides: Partial<SequencesGetResult> = {}): SequencesGetResult {
  return {
    sequence: { id: "seq_1", name: "Welcome", status: "draft" },
    steps: [
      { position: 1, channel: "email", template: { subject: "Hi {{company.name}}", body: "Hi {{contact.first_name}}, {{ai:opener}}" }, ai_slots: [{ name: "opener", max_words: 20, must_cite: true, fallback: "wanted to reach out." }] },
    ],
    enrollment_counts: {},
    ...overrides,
  };
}

function companyFull(overrides: Partial<CompanyFullRow> = {}): CompanyFullRow {
  return {
    company: { id: "co_1", name: "Acme Roofing", city: "Tampa", state: "FL" },
    people: [{ id: "p1", full_name: "Jane Smith", first_name: "Jane", title: "Owner", is_decision_maker: true }],
    contact_methods: [],
    technologies: [],
    facts: [{ id: "fact_1", field_name: "owner", value: "Jane Smith", source_url: "https://acme.example/about" }],
    signals: [{ id: "signal_1", company_id: "co_1", signal_type: "hiring", headline: "Hiring 2 roofers", observed_at: new Date().toISOString(), source_url: "https://acme.example/careers" }],
    enrollments: [],
    ...overrides,
  };
}

function fakeDeps(overrides: Partial<SequencePreviewDeps> = {}): SequencePreviewDeps {
  return {
    sequencesGet: async () => sequenceDetail(),
    companiesGetFull: async () => companyFull(),
    renderStep: async () => ({
      slots: { opener: "Saw you're hiring roofers." },
      citations: { opener: ["signal:signal_1"] },
      usedFallback: false,
      fromCache: false,
      evidenceHash: "abc123",
      rationale: "cites the hiring signal",
    }),
    ...overrides,
  };
}

test("renderSequencePreview: renders body/subject tokens and resolves citations to source URLs", async () => {
  const outcome = await renderSequencePreview({ sequenceId: "seq_1", companyId: "co_1", stepPosition: 1 }, fakeDeps());
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.result.subject, "Hi Acme Roofing");
  assert.equal(outcome.result.body, "Hi Jane, Saw you're hiring roofers.");
  assert.equal(outcome.result.rationale, "cites the hiring signal");
  assert.equal(outcome.result.used_fallback, false);
  assert.deepEqual(outcome.result.citations, { opener: ["https://acme.example/careers"] });
});

test("renderSequencePreview: a citation with no source_url on file renders a stable non-navigating anchor, never drops the citation", async () => {
  const deps = fakeDeps({
    companiesGetFull: async () => companyFull({ facts: [{ id: "fact_1", field_name: "owner", value: "Jane Smith" }] }),
    renderStep: async () => ({ slots: { opener: "Saw the team grew." }, citations: { opener: ["fact:fact_1"] }, usedFallback: false, fromCache: false, evidenceHash: "x" }),
  });
  const outcome = await renderSequencePreview({ sequenceId: "seq_1", companyId: "co_1", stepPosition: 1 }, deps);
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.deepEqual(outcome.result.citations, { opener: ["#fact:fact_1"] });
});

test("renderSequencePreview: no contact on file falls back to the company name as the greeting, never blocks", async () => {
  const deps = fakeDeps({ companiesGetFull: async () => companyFull({ people: [] }) });
  const outcome = await renderSequencePreview({ sequenceId: "seq_1", companyId: "co_1", stepPosition: 1 }, deps);
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.match(outcome.result.body ?? "", /^Hi Acme/);
});

test("renderSequencePreview: an unknown sequence id is reported, not thrown", async () => {
  const deps = fakeDeps({ sequencesGet: async () => sequenceDetail({ sequence: null }) });
  const outcome = await renderSequencePreview({ sequenceId: "missing", companyId: "co_1", stepPosition: 1 }, deps);
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.error.kind, "sequence_not_found");
});

test("renderSequencePreview: a step_position with no matching step is reported, not a crash on undefined.template", async () => {
  const deps = fakeDeps();
  const outcome = await renderSequencePreview({ sequenceId: "seq_1", companyId: "co_1", stepPosition: 99 }, deps);
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.error.kind, "step_not_found");
});

test("renderSequencePreview: an unknown company_id is reported, not a silent empty render", async () => {
  const deps = fakeDeps({ companiesGetFull: async () => companyFull({ company: {} }) });
  const outcome = await renderSequencePreview({ sequenceId: "seq_1", companyId: "missing", stepPosition: 1 }, deps);
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.error.kind, "company_not_found");
});
