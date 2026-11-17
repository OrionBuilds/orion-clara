import { test } from "node:test";
import assert from "node:assert/strict";
import {
  sizeBucket, personasForSize, titleToRole, pickBestNamedTitle, discoverBuyer, buyerDiscover,
  type BuyerDiscoveryDeps, type BuyerDiscoveryCompany,
} from "./buyerDiscovery";
import type { RunFloridaPublicDataResult } from "../publicdata";

test("sizeBucket: employees take priority when present", () => {
  assert.equal(sizeBucket({ employees: 5 }), "small");
  assert.equal(sizeBucket({ employees: 30 }), "mid");
  assert.equal(sizeBucket({ employees: 200 }), "large");
});
test("sizeBucket: falls back to revenue midpoint when employees are unknown", () => {
  assert.equal(sizeBucket({ revenueLow: 500_000, revenueHigh: 1_000_000 }), "small");
  assert.equal(sizeBucket({ revenueLow: 3_000_000, revenueHigh: 5_000_000 }), "mid");
  assert.equal(sizeBucket({ revenueLow: 15_000_000 }), "large");
});
test("sizeBucket: falls back to review count when neither employees nor revenue are known", () => {
  assert.equal(sizeBucket({ reviewCount: 10 }), "small");
  assert.equal(sizeBucket({ reviewCount: 100 }), "mid");
  assert.equal(sizeBucket({ reviewCount: 500 }), "large");
});
test("sizeBucket: defaults to small (owner persona) with nothing known at all", () => {
  assert.equal(sizeBucket({}), "small");
});

test("personasForSize: small is owner-only; mid adds a GM; large is a titled leadership layer", () => {
  assert.deepEqual(personasForSize("small").map((p) => p.roleType), ["owner"]);
  assert.deepEqual(personasForSize("mid").map((p) => p.roleType), ["owner", "gm"]);
  assert.deepEqual(personasForSize("large").map((p) => p.roleType), ["ceo", "gm", "sales_leader"]);
});

test("titleToRole: recognizes common title patterns, 'other' for anything unrecognized", () => {
  assert.equal(titleToRole("Owner"), "owner");
  assert.equal(titleToRole("Co-Founder"), "owner");
  assert.equal(titleToRole("Chief Executive Officer"), "ceo");
  assert.equal(titleToRole("General Manager"), "gm");
  assert.equal(titleToRole("VP of Sales"), "sales_leader");
  assert.equal(titleToRole("Director of Operations"), "ops");
  assert.equal(titleToRole("Marketing Coordinator"), "marketing");
  assert.equal(titleToRole("Roofing Technician"), "other");
  assert.equal(titleToRole(undefined), "other");
});

test("pickBestNamedTitle: picks the persona-preferred title first, over persona order", () => {
  const personas = personasForSize("mid"); // [owner, gm]
  const items = [{ title: "Operations Manager" }, { title: "Owner" }];
  assert.deepEqual(pickBestNamedTitle(items, personas), { title: "Owner" });
});
test("pickBestNamedTitle: falls back to any recognized title, then the first item", () => {
  const personas = personasForSize("small"); // [owner] — "CEO" isn't an owner-persona title, but titleToRole still recognizes it
  assert.deepEqual(pickBestNamedTitle([{ title: "Field Technician" }, { title: "CEO" }], personas), { title: "CEO" });
  assert.deepEqual(pickBestNamedTitle([{ title: "Field Technician" }], personas), { title: "Field Technician" });
  assert.equal(pickBestNamedTitle([], personas), undefined);
});

function company(overrides: Partial<BuyerDiscoveryCompany> = {}): BuyerDiscoveryCompany {
  return { id: "co_1", name: "Acme Roofing", website_url: "https://acme.com", city: "Tampa", state: "FL", ...overrides };
}

function pubData(overrides: Partial<RunFloridaPublicDataResult> = {}): RunFloridaPublicDataResult {
  return { facts: [], dbpr: [], sunbiz: [], permits: [], notes: [], ...overrides };
}

function fakeDeps(overrides: Partial<BuyerDiscoveryDeps> = {}): BuyerDiscoveryDeps {
  return {
    factsList: async () => [],
    runFloridaPublicDataForCompany: async () => pubData(),
    pickPages: () => [],
    crawlPage: async () => ({ ok: false, url: "", costUsd: 0 }),
    readFile: async () => "",
    runTier: async () => ({ ok: false, engine: "lmstudio" }),
    postProspectLookup: async () => ({ ok: false, kind: "prospect.linkedin_lookup", error: "not reached" }),
    loadConfig: async () => ({ fridayBaseUrl: "" } as never),
    apolloOrgPeopleSearch: async () => ({ people: [] }),
    companyPeopleUpsert: async () => ({ person: { id: "person_1", full_name: "x" }, action: "inserted" }),
    factsAdd: async () => ({ inserted: [], signals_emitted: [] }),
    ...overrides,
  };
}

test("discoverBuyer: ladder step 1 — an extracted owner fact wins immediately, nothing else called", async () => {
  let dbprCalled = false;
  const deps = fakeDeps({
    factsList: async () => [{ id: "f1", field_name: "owner", value: "Jane Smith", confidence: 0.8 }],
    runFloridaPublicDataForCompany: async () => { dbprCalled = true; return pubData(); },
  });
  const r = await discoverBuyer(company(), { allowLive: true }, deps);
  assert.equal(r.person?.fullName, "Jane Smith");
  assert.equal(r.person?.source, "extracted_owner");
  assert.equal(dbprCalled, false);
  assert.deepEqual(r.log, [{ source: "extracted_owner", outcome: "hit" }]);
});

test("discoverBuyer: ladder step 2 — DBPR licensee of an active license wins when no owner fact", async () => {
  const deps = fakeDeps({
    runFloridaPublicDataForCompany: async () => pubData({
      dbpr: [
        { licenseNumber: "CCC1", licenseType: "CCC", licenseeName: "Old Owner", status: "Expired", statusActive: false },
        { licenseNumber: "CCC2", licenseType: "CCC", licenseeName: "Bob Builder", status: "Current", statusActive: true },
      ],
    }),
  });
  const r = await discoverBuyer(company(), { allowLive: true }, deps);
  assert.equal(r.person?.fullName, "Bob Builder");
  assert.equal(r.person?.source, "dbpr");
});

test("discoverBuyer: ladder step 3 — a Sunbiz officer matching a persona title wins over an unmatched one", async () => {
  const deps = fakeDeps({
    runFloridaPublicDataForCompany: async () => pubData({
      sunbiz: [{ entityName: "Acme Roofing LLC", documentNumber: "L123", status: "Active", statusActive: true, officers: [{ name: "Random Agent", title: "Registered Agent" }, { name: "Jane Owner", title: "Owner" }] }],
    }),
  });
  const r = await discoverBuyer(company(), { allowLive: true }, deps);
  assert.equal(r.person?.fullName, "Jane Owner");
  assert.equal(r.person?.source, "sunbiz");
  assert.equal(r.person?.roleType, "owner");
});

test("discoverBuyer: ladder step 4 — the website team page extraction wins when public data has nothing", async () => {
  const deps = fakeDeps({
    pickPages: () => ["https://acme.com/team"],
    crawlPage: async () => ({ ok: true, url: "https://acme.com/team", costUsd: 0, evidence: { sha: "x", companyId: "co_1", url: "https://acme.com/team", sourceType: "team", txtPath: "/fake.txt" } }),
    readFile: async () => "Meet our team: Jane Smith, Owner.",
    runTier: async () => ({ ok: true, engine: "lmstudio", text: JSON.stringify({ people: [{ name: "Jane Smith", title: "Owner" }] }) }),
  });
  const r = await discoverBuyer(company(), { allowLive: true }, deps);
  assert.equal(r.person?.fullName, "Jane Smith");
  assert.equal(r.person?.source, "website_team");
});

test("discoverBuyer: ladder step 5 — LinkedIn via FRIDAY wins when nothing free panned out", async () => {
  const deps = fakeDeps({
    loadConfig: async () => ({ fridayBaseUrl: "http://127.0.0.1:3737" } as never),
    postProspectLookup: async () => ({
      ok: true, kind: "prospect.linkedin_lookup",
      people: [{ full_name: "Jane Smith", title: "Owner", linkedin_url: "https://linkedin.com/in/janesmith", confidence: 0.8, source_url: "https://linkedin.com/in/janesmith", observed_at: new Date().toISOString() }],
      budget: { searches_used: 1, views_used: 1, remaining_today: { searches: 9, views: 24 } },
      raw_excerpts: [], observed_at: new Date().toISOString(),
    }),
  });
  const r = await discoverBuyer(company(), { allowLive: true }, deps);
  assert.equal(r.person?.fullName, "Jane Smith");
  assert.equal(r.person?.source, "linkedin");
  assert.equal(r.person?.linkedinUrl, "https://linkedin.com/in/janesmith");
});

test("discoverBuyer: shadow mode skips LinkedIn (no live delegation) without erroring", async () => {
  const deps = fakeDeps();
  const r = await discoverBuyer(company(), { allowLive: false }, deps);
  const li = r.log.find((l) => l.source === "linkedin");
  assert.equal(li?.outcome, "skipped");
});

test("discoverBuyer: ladder step 6 — Apollo is always not_configured in this deploy (no key anywhere)", async () => {
  delete process.env.CLARA_APOLLO_API_KEY;
  const r = await discoverBuyer(company(), { allowLive: true }, fakeDeps());
  assert.equal(r.person, undefined);
  const apollo = r.log.find((l) => l.source === "apollo");
  assert.equal(apollo?.outcome, "skipped");
  assert.equal(apollo?.reason, "not_configured");
});

test("buyerDiscover: writes company_people_upsert and a decision_maker fact citing the source", async () => {
  let peopleArgs: unknown;
  let factsArgs: unknown;
  const deps = fakeDeps({
    factsList: async () => [{ id: "f1", field_name: "owner", value: "Jane Smith", confidence: 0.8 }],
    companyPeopleUpsert: async (args) => { peopleArgs = args; return { person: { id: "person_42", full_name: args.full_name }, action: "inserted" }; },
    factsAdd: async (args) => { factsArgs = args; return { inserted: [{ id: "fact_1", field_name: "decision_maker" }], signals_emitted: [] }; },
  });
  const r = await buyerDiscover(company(), { jobId: "job_1", allowLive: true }, deps);
  assert.equal(r.personId, "person_42");
  assert.equal((peopleArgs as { full_name: string }).full_name, "Jane Smith");
  assert.equal((factsArgs as { facts: { subject_id: string }[] }).facts[0].subject_id, "person_42");
});

test("buyerDiscover: no hit means no writes at all", async () => {
  let called = false;
  const deps = fakeDeps({ companyPeopleUpsert: async (args) => { called = true; return { person: { id: "x", full_name: args.full_name }, action: "inserted" }; } });
  const r = await buyerDiscover(company(), { allowLive: true }, deps);
  assert.equal(r.person, undefined);
  assert.equal(called, false);
});
