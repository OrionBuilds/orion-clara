import { test } from "node:test";
import assert from "node:assert/strict";
import { crawlPage, crawlSite, type WaterfallDeps } from "./waterfall";
import type { EvidenceRef } from "./evidence";

function fakeEvidence(url: string, companyId = "c1"): EvidenceRef {
  return { sha: "deadbeef", companyId, url, sourceType: "homepage", txtPath: "/tmp/deadbeef.txt" };
}

function baseDeps(order: string[], overrides: Partial<WaterfallDeps> = {}): WaterfallDeps {
  return {
    httpFetch: async () => {
      order.push("http");
      return { ok: false, error: "no" };
    },
    jinaFetch: async () => {
      order.push("jina");
      return { ok: false, error: "no" };
    },
    playwrightFetch: async () => {
      order.push("playwright");
      return { ok: false, error: "no" };
    },
    isAllowedByRobots: async () => true,
    htmlToText: (html: string) => ({ text: `TEXT:${html}`, links: [] }),
    writeEvidence: async (input) => fakeEvidence(input.url, input.companyId),
    countPlaywrightShare: async () => ({ playwright: 0, total: 0 }),
    ...overrides,
  };
}

test("tries rungs in order http -> jina -> playwright when earlier rungs fail", async () => {
  const order: string[] = [];
  const deps = baseDeps(order, {
    playwrightFetch: async () => {
      order.push("playwright");
      return { ok: true, html: "<h1>Hi</h1>", costUsd: 0 };
    },
  });
  const r = await crawlPage("https://acme.com/", { jobId: "job1", companyId: "c1" }, deps);
  assert.deepEqual(order, ["http", "jina", "playwright"]);
  assert.equal(r.ok, true);
  assert.equal(r.method, "playwright");
  assert.ok(r.evidence);
});

test("stops at the first successful rung and records its method/cost/evidenceRef", async () => {
  const order: string[] = [];
  const deps = baseDeps(order, {
    httpFetch: async () => {
      order.push("http");
      return { ok: true, html: "<p>hi</p>", costUsd: 0, cached: false };
    },
  });
  const r = await crawlPage("https://acme.com/", { jobId: "job1", companyId: "c1" }, deps);
  assert.deepEqual(order, ["http"]);
  assert.equal(r.ok, true);
  assert.equal(r.method, "http");
  assert.equal(r.costUsd, 0);
  assert.equal(r.evidence?.sha, "deadbeef");
});

test("jina's text is used directly, not re-run through htmlToText", async () => {
  const order: string[] = [];
  let htmlToTextCalls = 0;
  const deps = baseDeps(order, {
    jinaFetch: async () => {
      order.push("jina");
      return { ok: true, text: "already extracted text", costUsd: 0 };
    },
    htmlToText: (html: string) => {
      htmlToTextCalls++;
      return { text: `TEXT:${html}`, links: [] };
    },
  });
  const r = await crawlPage("https://acme.com/", { jobId: "job1", companyId: "c1" }, deps);
  assert.equal(r.method, "jina");
  assert.equal(htmlToTextCalls, 0);
});

test("a robots-disallowed URL is skipped on every rung and reported distinctly", async () => {
  const order: string[] = [];
  const deps = baseDeps(order, { isAllowedByRobots: async () => false });
  const r = await crawlPage("https://acme.com/private", { jobId: "job1" }, deps);
  assert.deepEqual(order, []);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "robots-blocked");
});

test("an aggregator-domain candidate is skipped entirely, with no fetch or robots check attempted", async () => {
  const order: string[] = [];
  const deps = baseDeps(order, { isAllowedByRobots: async () => { order.push("robots"); return true; } });
  const r = await crawlPage("https://www.yelp.com/biz/acme-roofing", { jobId: "job1" }, deps);
  assert.deepEqual(order, []);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "aggregator-domain");
});

test("playwright cap: refuses rung 3 once it would push the job over 15% playwright share", async () => {
  const order: string[] = [];
  const deps = baseDeps(order, {
    playwrightFetch: async () => {
      order.push("playwright");
      return { ok: true, html: "<p>x</p>" };
    },
    countPlaywrightShare: async () => ({ playwright: 2, total: 10 }), // (2+1)/(10+1) = 0.27 > 0.15
  });
  const r = await crawlPage("https://acme.com/", { jobId: "job1" }, deps);
  assert.deepEqual(order, ["http", "jina"]);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "playwright-cap");
});

test("playwright cap: allows rung 3 when the share stays within 15%", async () => {
  const order: string[] = [];
  const deps = baseDeps(order, {
    playwrightFetch: async () => {
      order.push("playwright");
      return { ok: true, html: "<p>x</p>" };
    },
    countPlaywrightShare: async () => ({ playwright: 0, total: 20 }), // (0+1)/(20+1) ≈ 0.048 <= 0.15
  });
  const r = await crawlPage("https://acme.com/", { jobId: "job1" }, deps);
  assert.deepEqual(order, ["http", "jina", "playwright"]);
  assert.equal(r.ok, true);
});

test("all rungs failing reports a distinct reason and no evidence", async () => {
  const order: string[] = [];
  const deps = baseDeps(order);
  const r = await crawlPage("https://acme.com/", { jobId: "job1" }, deps);
  assert.deepEqual(order, ["http", "jina", "playwright"]);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "all-rungs-failed");
  assert.equal(r.evidence, undefined);
});

test("crawlSite loops over every picked page and sums cost", async () => {
  const order: string[] = [];
  const deps = baseDeps(order, {
    httpFetch: async (url: string) => {
      order.push(`http:${url}`);
      return { ok: true, html: `<p>${url}</p>`, costUsd: 0 };
    },
  });
  const r = await crawlSite(["https://acme.com/", "https://acme.com/about"], { jobId: "job1", companyId: "c1" }, deps);
  assert.equal(r.pages.length, 2);
  assert.ok(r.pages.every((p) => p.ok));
  assert.equal(r.costUsd, 0);
});

test("crawlPage without a companyId still succeeds but skips evidence writing", async () => {
  const order: string[] = [];
  let writeEvidenceCalls = 0;
  const deps = baseDeps(order, {
    httpFetch: async () => {
      order.push("http");
      return { ok: true, html: "<p>hi</p>" };
    },
    writeEvidence: async (input) => {
      writeEvidenceCalls++;
      return fakeEvidence(input.url);
    },
  });
  const r = await crawlPage("https://acme.com/", { jobId: "job1" }, deps);
  assert.equal(r.ok, true);
  assert.equal(r.evidence, undefined);
  assert.equal(writeEvidenceCalls, 0);
});
