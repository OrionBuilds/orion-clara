import { test } from "node:test";
import assert from "node:assert/strict";
import { extractMailtoEmails, callSiteMailto, type SiteMailtoDeps } from "./siteMailto";
import type { RungContext } from "../waterfall";

function ctx(overrides: Partial<RungContext> = {}): RungContext {
  return { companyId: "co_1", companyName: "Acme Roofing", fitScore: 80, allowLive: true, websiteUrl: "https://acme.com", domain: "acme.com", ...overrides };
}

test("extractMailtoEmails: finds a mailto link, flags role addresses, dedupes, filters by domain", () => {
  const html = `<a href="mailto:jane@acme.com">Jane</a> <a href="mailto:info@acme.com">Info</a> <a href="mailto:info@acme.com">Info again</a> <a href="mailto:someone@other.com">Other</a>`;
  const found = extractMailtoEmails(html, "acme.com");
  assert.deepEqual(found, [{ value: "jane@acme.com", isRole: false }, { value: "info@acme.com", isRole: true }]);
});

test("extractMailtoEmails: no domain filter accepts anything", () => {
  const found = extractMailtoEmails("mailto:x@y.com", undefined);
  assert.equal(found.length, 1);
});

test("callSiteMailto: no website_url is a clean miss, no fetch attempted", async () => {
  let called = false;
  const deps: SiteMailtoDeps = { crawlPage: async () => { called = true; return { ok: false, url: "", costUsd: 0 }; }, readFile: async () => "" };
  const r = await callSiteMailto(ctx({ websiteUrl: undefined }), deps);
  assert.equal(r.hit, false);
  assert.equal(called, false);
});

test("callSiteMailto: prefers a non-role address over a role address found on the same page", async () => {
  const deps: SiteMailtoDeps = {
    crawlPage: async () => ({ ok: true, url: "https://acme.com", costUsd: 0, evidence: { sha: "x", companyId: "co_1", url: "https://acme.com", sourceType: "homepage", txtPath: "/fake.txt" } }),
    readFile: async () => `<a href="mailto:info@acme.com">Info</a> <a href="mailto:jane@acme.com">Jane</a>`,
  };
  const r = await callSiteMailto(ctx(), deps);
  assert.equal(r.hit, true);
  if (r.hit) {
    assert.equal(r.value, "jane@acme.com");
    assert.equal(r.verificationStatus, "unknown");
    assert.equal(r.costUsd, 0);
  }
});

test("callSiteMailto: a failed fetch is a miss with the crawl's own reason", async () => {
  const deps: SiteMailtoDeps = { crawlPage: async () => ({ ok: false, url: "https://acme.com", costUsd: 0, reason: "robots-blocked" }), readFile: async () => "" };
  const r = await callSiteMailto(ctx(), deps);
  assert.equal(r.hit, false);
  if (!r.hit) assert.equal(r.reason, "robots-blocked");
});
