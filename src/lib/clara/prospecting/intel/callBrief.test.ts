import { test } from "node:test";
import assert from "node:assert/strict";
import { composeCallBrief, buildCallBriefPrompt, type CallBriefDeps } from "./callBrief";
import type { CompanyFullRow } from "../osBridge";

function fullRow(): CompanyFullRow {
  return {
    company: { id: "co_1", name: "Acme Roofing", industry: ["roofing"] },
    people: [{ id: "p1", full_name: "Jane Smith", title: "Owner", is_decision_maker: true }],
    contact_methods: [], technologies: [],
    facts: [{ id: "f1", field_name: "owner", value: "Jane Smith", confidence: 0.8 }],
    signals: [{ headline: "Hiring 2 roofers" }],
    enrollments: [],
  };
}

test("buildCallBriefPrompt: names the decision maker and cites facts/signals, asks for strict JSON", () => {
  const prompt = buildCallBriefPrompt(fullRow(), []);
  assert.match(prompt, /Jane Smith/);
  assert.match(prompt, /Owner/);
  assert.match(prompt, /Hiring 2 roofers/);
  assert.match(prompt, /Reply ONLY JSON/);
  assert.match(prompt, /never invent a detail/);
});

test("composeCallBrief: a well-formed tier-3 JSON reply parses into a CallBrief", async () => {
  const deps: CallBriefDeps = { runTier: async () => ({ ok: true, engine: "anthropic", text: JSON.stringify({ opener: "Hi Jane", talkingPoints: ["a", "b"], objections: [{ objection: "busy", response: "15 min" }] }) }) };
  const brief = await composeCallBrief(fullRow(), [], deps);
  assert.deepEqual(brief, { opener: "Hi Jane", talkingPoints: ["a", "b"], objections: [{ objection: "busy", response: "15 min" }] });
});

test("composeCallBrief: a failed tier-3 call returns undefined, never throws", async () => {
  const deps: CallBriefDeps = { runTier: async () => ({ ok: false, engine: "anthropic", error: "timeout" }) };
  assert.equal(await composeCallBrief(fullRow(), [], deps), undefined);
});

test("composeCallBrief: malformed JSON returns undefined", async () => {
  const deps: CallBriefDeps = { runTier: async () => ({ ok: true, engine: "anthropic", text: "not json" }) };
  assert.equal(await composeCallBrief(fullRow(), [], deps), undefined);
});

test("composeCallBrief: JSON missing a required field is rejected (the shape guard)", async () => {
  const deps: CallBriefDeps = { runTier: async () => ({ ok: true, engine: "anthropic", text: JSON.stringify({ opener: "Hi", talkingPoints: [] }) }) };
  assert.equal(await composeCallBrief(fullRow(), [], deps), undefined);
});
