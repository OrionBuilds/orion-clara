import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractFacts, buildExtractPrompt, checkGrounded, UNGROUNDED_CONFIDENCE_MULTIPLIER, type ExtractFactsDeps, type PageText,
} from "./extractFacts";
import type { EvidenceRef } from "../crawler/evidence";
import type { DiscoveredCandidate } from "../types";
import type { FactsAddInput, FactsAddResult } from "../osBridge";

const candidate: DiscoveredCandidate = { name: "Acme Roofing", source: "places", website_url: "https://acme.com" };

function evidenceFor(url: string, txtPath: string): EvidenceRef {
  return { sha: "sha1", companyId: "co_1", url, sourceType: "homepage", txtPath };
}

function depsFor(opts: {
  texts?: Record<string, string>;
  runTierText?: string;
  runTierOk?: boolean;
  runTierError?: string;
} = {}): ExtractFactsDeps & { calls: { facts?: FactsAddInput } } {
  const calls: { facts?: FactsAddInput } = {};
  return {
    readFile: async (p: string) => {
      const t = opts.texts?.[p];
      if (t === undefined) throw new Error(`no fixture text for ${p}`);
      return t;
    },
    runTier: async () => ({
      ok: opts.runTierOk ?? true,
      engine: "lmstudio",
      model: "test-model",
      text: opts.runTierText,
      error: opts.runTierError,
    }),
    factsAdd: async (args: FactsAddInput): Promise<FactsAddResult> => {
      calls.facts = args;
      return { inserted: args.facts.map((f) => ({ id: "f1", field_name: f.field_name })), signals_emitted: [] };
    },
    calls,
  };
}

// ── buildExtractPrompt ────────────────────────────────────────────────────────────────────────

test("buildExtractPrompt includes every page's URL and text, and the field-name rules", () => {
  const pages: PageText[] = [{ url: "https://acme.com/about", text: "Owned by Jane Smith since 2004." }];
  const prompt = buildExtractPrompt(pages);
  assert.ok(prompt.includes("https://acme.com/about"));
  assert.ok(prompt.includes("Owned by Jane Smith since 2004."));
  assert.ok(prompt.includes("services"));
  assert.ok(prompt.includes("year_founded"));
  assert.ok(prompt.includes("verbatim substring"));
});

test("buildExtractPrompt truncates an oversized page to the snippet cap", () => {
  const longText = "x".repeat(10_000);
  const prompt = buildExtractPrompt([{ url: "https://acme.com/", text: longText }]);
  // the whole 10,000-char run shouldn't survive uncapped into the prompt
  assert.ok(prompt.length < longText.length);
});

// ── checkGrounded ─────────────────────────────────────────────────────────────────────────────

test("checkGrounded is true for an exact substring match", () => {
  assert.equal(checkGrounded("owned by Jane Smith", "This business is owned by Jane Smith since 2004."), true);
});

test("checkGrounded normalizes whitespace and case", () => {
  assert.equal(checkGrounded("Owned   BY jane\nsmith", "this business is owned by jane smith since 2004."), true);
});

test("checkGrounded is false when the quote isn't actually in the page text", () => {
  assert.equal(checkGrounded("owned by John Doe", "This business is owned by Jane Smith since 2004."), false);
});

test("checkGrounded is false for an empty quote", () => {
  assert.equal(checkGrounded("", "any page text at all"), false);
});

// ── extractFacts end to end ──────────────────────────────────────────────────────────────────

test("extractFacts returns early (no LLM call) when no evidence text could be loaded", async () => {
  let runTierCalled = false;
  const deps = depsFor({ texts: {} });
  deps.runTier = async () => {
    runTierCalled = true;
    return { ok: true, engine: "lmstudio", text: "{}" };
  };
  const r = await extractFacts({ companyId: "co_1", candidate, evidence: [evidenceFor("https://acme.com/", "/missing.txt")] }, deps);
  assert.equal(runTierCalled, false);
  assert.equal(r.factsBuilt, 0);
  assert.ok(r.notes.some((n) => n.includes("no crawled page text")));
});

test("extractFacts parses a valid response and writes one batch facts_add call with the right field split", async () => {
  const pageUrl = "https://acme.com/about";
  const pageText = "Acme Roofing was founded in 2004 by Jane Smith. We offer roof repair and gutter installation. We are GAF certified.";
  const deps = depsFor({
    texts: { "/about.txt": pageText },
    runTierText: JSON.stringify({
      facts: [
        { field: "owner", value: "Jane Smith", quote: "founded in 2004 by Jane Smith", url: pageUrl },
        { field: "year_founded", value: 2004, quote: "founded in 2004", url: pageUrl },
        { field: "services", value: "roof repair", quote: "roof repair", url: pageUrl },
        { field: "services", value: "gutter installation", quote: "gutter installation", url: pageUrl },
        { field: "certifications", value: "GAF", quote: "GAF certified", url: pageUrl },
      ],
    }),
  });

  const r = await extractFacts({ companyId: "co_1", candidate, evidence: [evidenceFor(pageUrl, "/about.txt")] }, deps);

  assert.equal(r.factsBuilt, 5);
  assert.equal(r.groundedCount, 5);
  assert.equal(r.ungroundedCount, 0);
  assert.ok(deps.calls.facts);
  assert.equal(deps.calls.facts?.facts.length, 5);

  const servicesFacts = deps.calls.facts!.facts.filter((f) => f.field_name === "services");
  assert.equal(servicesFacts.length, 2); // one facts_add entry PER distinct value (multi-valued field)
  assert.deepEqual(servicesFacts.map((f) => f.value).sort(), ["gutter installation", "roof repair"]);

  const ownerFact = deps.calls.facts!.facts.find((f) => f.field_name === "owner");
  assert.equal(ownerFact?.value, "Jane Smith");
  assert.equal(ownerFact?.source_type, "llm_extraction");
  assert.equal(ownerFact?.grounded, true);
  assert.equal(ownerFact?.source_url, pageUrl);

  const yearFact = deps.calls.facts!.facts.find((f) => f.field_name === "year_founded");
  assert.equal(yearFact?.value, 2004);
  assert.equal(typeof yearFact?.value, "number");
});

test("extractFacts halves confidence and marks grounded:false when the quote isn't a real substring of the source page", async () => {
  const pageUrl = "https://acme.com/about";
  const pageText = "Acme Roofing is a family business.";
  const deps = depsFor({
    texts: { "/about.txt": pageText },
    runTierText: JSON.stringify({
      facts: [{ field: "owner", value: "Someone Else", quote: "this text does not appear on the page", url: pageUrl }],
    }),
  });
  const r = await extractFacts({ companyId: "co_1", candidate, evidence: [evidenceFor(pageUrl, "/about.txt")] }, deps);
  assert.equal(r.groundedCount, 0);
  assert.equal(r.ungroundedCount, 1);
  const fact = deps.calls.facts!.facts[0];
  assert.equal(fact.grounded, false);
  assert.equal(fact.confidence, 0.8 * UNGROUNDED_CONFIDENCE_MULTIPLIER);
});

test("extractFacts marks a fact ungrounded when its url doesn't match any crawled page", async () => {
  const deps = depsFor({
    texts: { "/about.txt": "Acme Roofing. Founded in 2004." },
    runTierText: JSON.stringify({
      facts: [{ field: "owner", value: "Jane Smith", quote: "Jane Smith", url: "https://acme.com/not-crawled" }],
    }),
  });
  const r = await extractFacts({ companyId: "co_1", candidate, evidence: [evidenceFor("https://acme.com/about", "/about.txt")] }, deps);
  assert.equal(r.ungroundedCount, 1);
  assert.equal(deps.calls.facts!.facts[0].grounded, false);
});

test("extractFacts drops a fact whose field isn't one of the schema's allowed field names", async () => {
  const deps = depsFor({
    texts: { "/about.txt": "Acme Roofing." },
    runTierText: JSON.stringify({ facts: [{ field: "revenue_estimate", value: "1000000", quote: "x", url: "https://acme.com/about" }] }),
  });
  const r = await extractFacts({ companyId: "co_1", candidate, evidence: [evidenceFor("https://acme.com/about", "/about.txt")] }, deps);
  assert.equal(r.factsBuilt, 0);
  assert.equal(deps.calls.facts, undefined);
});

test("extractFacts handles a malformed JSON response without throwing", async () => {
  const deps = depsFor({ texts: { "/about.txt": "Acme Roofing." }, runTierText: "not json at all" });
  const r = await extractFacts({ companyId: "co_1", candidate, evidence: [evidenceFor("https://acme.com/about", "/about.txt")] }, deps);
  assert.equal(r.factsBuilt, 0);
  assert.ok(r.parseError);
});

test("extractFacts handles a failed tier-2 call without throwing", async () => {
  const deps = depsFor({ texts: { "/about.txt": "Acme Roofing." }, runTierOk: false, runTierError: "lmstudio down" });
  const r = await extractFacts({ companyId: "co_1", candidate, evidence: [evidenceFor("https://acme.com/about", "/about.txt")] }, deps);
  assert.equal(r.factsBuilt, 0);
  assert.equal(r.parseError, "lmstudio down");
});

test("extractFacts skips an unreadable evidence file but still extracts from the others", async () => {
  const pageUrl = "https://acme.com/about";
  const deps = depsFor({
    texts: { "/about.txt": "Acme Roofing, owned by Jane Smith." },
    runTierText: JSON.stringify({ facts: [{ field: "owner", value: "Jane Smith", quote: "owned by Jane Smith", url: pageUrl }] }),
  });
  const r = await extractFacts(
    {
      companyId: "co_1",
      candidate,
      evidence: [evidenceFor("https://acme.com/missing", "/missing.txt"), evidenceFor(pageUrl, "/about.txt")],
    },
    deps,
  );
  assert.equal(r.factsBuilt, 1);
  assert.ok(r.notes.some((n) => n.includes("https://acme.com/missing")));
});

test("extractFacts writes nothing (no facts_add call) when the model returns an empty facts array", async () => {
  const deps = depsFor({ texts: { "/about.txt": "Acme Roofing." }, runTierText: JSON.stringify({ facts: [] }) });
  const r = await extractFacts({ companyId: "co_1", candidate, evidence: [evidenceFor("https://acme.com/about", "/about.txt")] }, deps);
  assert.equal(r.factsBuilt, 0);
  assert.equal(deps.calls.facts, undefined);
});
