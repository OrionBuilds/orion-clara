import { test } from "node:test";
import assert from "node:assert/strict";
import { extractTelLinks, callSiteTel, type SiteTelDeps } from "./siteTel";
import type { RungContext } from "../waterfall";

function ctx(overrides: Partial<RungContext> = {}): RungContext {
  return { companyId: "co_1", companyName: "Acme Roofing", fitScore: 80, allowLive: true, websiteUrl: "https://acme.com", ...overrides };
}

test("extractTelLinks: normalizes and dedupes tel: links", () => {
  const html = `<a href="tel:+18135550100">Call</a> <a href="tel:(813) 555-0100">Same</a> <a href="tel:813-555-0199">Other</a>`;
  const found = extractTelLinks(html);
  assert.deepEqual(found, ["+18135550100", "+18135550199"]);
});

test("callSiteTel: no website_url is a clean miss", async () => {
  const deps: SiteTelDeps = { crawlPage: async () => ({ ok: false, url: "", costUsd: 0 }), readFile: async () => "" };
  const r = await callSiteTel(ctx({ websiteUrl: undefined }), deps);
  assert.equal(r.hit, false);
});

test("callSiteTel: a found tel: link is a hit, kind=phone (office number, not a personal cell)", async () => {
  const deps: SiteTelDeps = {
    crawlPage: async () => ({ ok: true, url: "https://acme.com", costUsd: 0, evidence: { sha: "x", companyId: "co_1", url: "https://acme.com", sourceType: "homepage", txtPath: "/fake.txt" } }),
    readFile: async () => `<a href="tel:+18135550100">Call us</a>`,
  };
  const r = await callSiteTel(ctx(), deps);
  assert.equal(r.hit, true);
  if (r.hit) { assert.equal(r.kind, "phone"); assert.equal(r.value, "+18135550100"); assert.equal(r.provider, "website"); }
});
