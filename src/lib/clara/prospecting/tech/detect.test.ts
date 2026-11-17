import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { promises as fs } from "node:fs";
import {
  detectTech, extractScriptSrcs, matchSignatures, inferMxProvider, parseSpfIncludes, type DetectTechDeps,
} from "./detect";
import type { EvidenceRef } from "../crawler/evidence";
import type { DiscoveredCandidate } from "../types";
import type { CompanyTechnologiesUpsertInput, CompanyTechnologiesUpsertResult, FactsAddInput, FactsAddResult } from "../osBridge";

const FIXTURE_DIR = fileURLToPath(new URL("../__fixtures__/pages/", import.meta.url));

async function fixtureHtml(name: string): Promise<string> {
  return fs.readFile(`${FIXTURE_DIR}${name}`, "utf8");
}

const candidate: DiscoveredCandidate = { name: "Acme Roofing", source: "places", website_url: "https://acme.com" };

function homepageEvidence(url: string): EvidenceRef {
  return { sha: "s1", companyId: "co_1", url, sourceType: "homepage", htmlPath: `${FIXTURE_DIR}placeholder`, txtPath: "/x/s1.txt" };
}

function depsFor(overrides: Partial<DetectTechDeps> & { html?: string } = {}): DetectTechDeps & { calls: { tech?: CompanyTechnologiesUpsertInput; facts?: FactsAddInput } } {
  const calls: { tech?: CompanyTechnologiesUpsertInput; facts?: FactsAddInput } = {};
  const deps: DetectTechDeps & { calls: typeof calls } = {
    readFile: async () => overrides.html ?? "",
    resolveMx: async () => ({ ok: true, records: [] }),
    resolveTxt: async () => ({ ok: true, records: [] }),
    companyTechnologiesUpsert: async (args: CompanyTechnologiesUpsertInput): Promise<CompanyTechnologiesUpsertResult> => {
      calls.tech = args;
      return { added: args.technologies, refreshed: 0, closed: 0 };
    },
    factsAdd: async (args: FactsAddInput): Promise<FactsAddResult> => {
      calls.facts = args;
      return { inserted: args.facts.map((f) => ({ id: "fact_1", field_name: f.field_name })), signals_emitted: [] };
    },
    calls,
    ...overrides,
  };
  return deps;
}

// ── pure helpers ───────────────────────────────────────────────────────────────────────────────

test("extractScriptSrcs pulls every <script src> value off raw html", () => {
  const html = `<script src="/a.js"></script><script type="text/javascript" src="https://cdn.x.com/b.js"></script><script>inline()</script>`;
  assert.deepEqual(extractScriptSrcs(html), ["/a.js", "https://cdn.x.com/b.js"]);
});

test("matchSignatures finds GoHighLevel + CallRail in the ghl-callrail fixture", async () => {
  const html = await fixtureHtml("ghl-callrail.html");
  const names = matchSignatures(html).map((s) => s.name);
  assert.ok(names.includes("GoHighLevel"));
  assert.ok(names.includes("CallRail"));
  assert.ok(names.includes("GreenSky")); // plain-text "financing through GreenSky" mention
});

test("matchSignatures finds WordPress in the wordpress fixture", async () => {
  const html = await fixtureHtml("wordpress.html");
  const names = matchSignatures(html).map((s) => s.name);
  assert.ok(names.includes("WordPress"));
});

test("matchSignatures finds HubSpot + Calendly in the hubspot-calendly fixture", async () => {
  const html = await fixtureHtml("hubspot-calendly.html");
  const names = matchSignatures(html).map((s) => s.name);
  assert.ok(names.includes("HubSpot"));
  assert.ok(names.includes("Calendly"));
});

test("matchSignatures finds nothing in the plain fixture", async () => {
  const html = await fixtureHtml("plain.html");
  assert.deepEqual(matchSignatures(html), []);
});

test("inferMxProvider recognizes Google Workspace MX hosts", () => {
  assert.equal(inferMxProvider(["aspmx.l.google.com", "alt1.aspmx.l.google.com"]), "Google Workspace");
});

test("inferMxProvider recognizes Microsoft 365 MX hosts", () => {
  assert.equal(inferMxProvider(["acme-com.mail.protection.outlook.com"]), "Microsoft 365");
});

test("inferMxProvider recognizes GoDaddy MX hosts", () => {
  assert.equal(inferMxProvider(["mailstore1.secureserver.net"]), "GoDaddy");
});

test("inferMxProvider returns undefined for an unrecognized/no-MX result", () => {
  assert.equal(inferMxProvider([]), undefined);
  assert.equal(inferMxProvider(["mx.someobscureprovider.example"]), undefined);
});

test("parseSpfIncludes finds Mailchimp + HubSpot includes in one SPF record", () => {
  const txt = [["v=spf1 include:servers.mcsv.net include:_spf.hubspot.com ~all"]];
  assert.deepEqual(parseSpfIncludes(txt), ["hubspot", "mailchimp"]);
});

test("parseSpfIncludes finds SendGrid and Constant Contact independently", () => {
  assert.deepEqual(parseSpfIncludes([["v=spf1 include:sendgrid.net ~all"]]), ["sendgrid"]);
  assert.deepEqual(parseSpfIncludes([["v=spf1 include:spf.constantcontact.com ~all"]]), ["constantcontact"]);
});

test("parseSpfIncludes returns empty for no TXT records or no SPF record at all", () => {
  assert.deepEqual(parseSpfIncludes([]), []);
  assert.deepEqual(parseSpfIncludes([["google-site-verification=abc123"]]), []);
});

// ── detectTech (end to end over fakes) ───────────────────────────────────────────────────────

test("detectTech on the ghl-callrail fixture: upserts tech + writes facts with the right field_name split", async () => {
  const html = await fixtureHtml("ghl-callrail.html");
  const deps = depsFor({ html });
  const r = await detectTech(
    { companyId: "co_1", candidate, evidence: [homepageEvidence("https://acme.com/")], allowLive: true },
    deps,
  );

  const names = r.detected.map((d) => d.name).sort();
  assert.ok(names.includes("GoHighLevel"));
  assert.ok(names.includes("CallRail"));
  assert.ok(names.includes("GreenSky"));

  assert.ok(deps.calls.tech);
  assert.equal(deps.calls.tech?.company_id, "co_1");
  assert.equal(deps.calls.tech?.replace, true);

  assert.ok(deps.calls.facts);
  const byField = new Map((deps.calls.facts?.facts ?? []).map((f) => [f.field_name, f]));
  // GoHighLevel (crm) -> the known signal-emitting field "crm", so the OS's auto tech_added/
  // tech_removed signal fires server-side the moment this value changes (facts_add's own job, not
  // re-tested here — see osBridge.ts's FactsAddResult doc comment / PR 8's brief).
  assert.equal(byField.get("crm")?.value, "GoHighLevel");
  assert.equal(byField.get("crm")?.source_type, "website_script");
  // CallRail (category "phone") maps to the OS's "call_tracking" signal field specifically, not
  // "phone_system" — see detect.ts's FIELD_NAME_BY_TECH_NAME doc comment.
  assert.equal(byField.get("call_tracking")?.value, "CallRail");
  // GreenSky (financing) -> "financing", also a known signal-emitting field (financing_added).
  assert.equal(byField.get("financing")?.value, "GreenSky");
});

test("detectTech on the plain fixture detects nothing and skips the tech-upsert call", async () => {
  const html = await fixtureHtml("plain.html");
  const deps = depsFor({ html, resolveMx: async () => ({ ok: true, records: [] }), resolveTxt: async () => ({ ok: true, records: [] }) });
  const r = await detectTech(
    { companyId: "co_2", candidate: { ...candidate, website_url: "https://plainhandyman.example" }, evidence: [homepageEvidence("https://plainhandyman.example/")], allowLive: true },
    deps,
  );
  assert.equal(r.detected.length, 0);
  assert.equal(deps.calls.tech, undefined);
  assert.equal(deps.calls.facts, undefined);
});

test("detectTech writes a single mx_provider fact for a Google Workspace MX result", async () => {
  const deps = depsFor({
    html: "<html></html>",
    resolveMx: async () => ({ ok: true, records: [{ exchange: "aspmx.l.google.com", priority: 1 }] }),
  });
  const r = await detectTech({ companyId: "co_3", candidate, evidence: [], allowLive: true }, deps);
  assert.equal(r.mxProvider, "Google Workspace");
  const mxFact = deps.calls.facts?.facts.find((f) => f.field_name === "mx_provider");
  assert.ok(mxFact);
  assert.equal(mxFact?.value, "Google Workspace");
  assert.equal(mxFact?.source_type, "dns");
});

test("detectTech writes a single mx_provider fact for a Microsoft 365 MX result", async () => {
  const deps = depsFor({
    html: "<html></html>",
    resolveMx: async () => ({ ok: true, records: [{ exchange: "acme-com.mail.protection.outlook.com", priority: 0 }] }),
  });
  const r = await detectTech({ companyId: "co_4", candidate, evidence: [], allowLive: true }, deps);
  assert.equal(r.mxProvider, "Microsoft 365");
});

test("detectTech writes a single mx_provider fact for a GoDaddy MX result", async () => {
  const deps = depsFor({
    html: "<html></html>",
    resolveMx: async () => ({ ok: true, records: [{ exchange: "mailstore1.secureserver.net", priority: 0 }] }),
  });
  const r = await detectTech({ companyId: "co_5", candidate, evidence: [], allowLive: true }, deps);
  assert.equal(r.mxProvider, "GoDaddy");
});

test("detectTech writes ONE spf_includes fact whose value is the whole array, not one fact per provider", async () => {
  const deps = depsFor({
    html: "<html></html>",
    resolveTxt: async () => ({ ok: true, records: [["v=spf1 include:servers.mcsv.net include:_spf.hubspot.com ~all"]] }),
  });
  const r = await detectTech({ companyId: "co_6", candidate, evidence: [], allowLive: true }, deps);
  assert.deepEqual(r.spfIncludes, ["hubspot", "mailchimp"]);
  const spfFacts = (deps.calls.facts?.facts ?? []).filter((f) => f.field_name === "spf_includes");
  assert.equal(spfFacts.length, 1);
  assert.deepEqual(spfFacts[0].value, ["hubspot", "mailchimp"]);
  assert.equal(spfFacts[0].normalized_value, "hubspot,mailchimp");
});

test("detectTech handles no MX/TXT records gracefully — not an error, no facts written for either", async () => {
  const deps = depsFor({ html: "<html></html>" });
  const r = await detectTech(
    { companyId: "co_7", candidate, evidence: [homepageEvidence("https://acme.com/")], allowLive: true },
    deps,
  );
  assert.equal(r.mxProvider, undefined);
  assert.deepEqual(r.spfIncludes, []);
  assert.equal(r.notes.length, 0);
  assert.equal(deps.calls.facts, undefined);
});

test("detectTech surfaces a dns lookup error as a note rather than throwing", async () => {
  const deps = depsFor({ html: "<html></html>", resolveMx: async () => ({ ok: false, error: "dns timeout" }) });
  const r = await detectTech({ companyId: "co_8", candidate, evidence: [], allowLive: true }, deps);
  assert.ok(r.notes.some((n) => n.includes("dns timeout")));
});

test("detectTech skips html/script scanning gracefully when no evidence carries raw html (jina-only crawl)", async () => {
  const deps = depsFor();
  const jinaOnlyEvidence: EvidenceRef = { sha: "s2", companyId: "co_9", url: "https://acme.com/", sourceType: "homepage", txtPath: "/x/s2.txt" };
  const r = await detectTech({ companyId: "co_9", candidate, evidence: [jinaOnlyEvidence], allowLive: true }, deps);
  assert.equal(r.detected.length, 0);
  assert.ok(r.notes.some((n) => n.includes("no evidence carried raw HTML")));
});
