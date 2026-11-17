import { test } from "node:test";
import assert from "node:assert/strict";
import { HANDLERS, IMPLEMENTED_STAGES, defaultStageDeps, type StageDeps } from "./stages";
import type { ClaimedTask, DiscoveredCandidate, Job, JobSpec } from "./types";

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: "job_1",
    title: "Roofers near Tampa",
    request_text: "roofers near tampa",
    plan: { entity: "company", industry: ["roofing"] } as JobSpec,
    status: "running",
    budget_usd: 100,
    max_records: 50,
    gates: {},
    estimate: {},
    spend_usd: 0,
    funnel: {},
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

function task(overrides: Partial<ClaimedTask> = {}): ClaimedTask {
  return {
    id: "task_1",
    job_id: "job_1",
    task_type: "classify",
    stage: 30,
    attempt: 1,
    input: {},
    idempotency_key: "k1",
    ...overrides,
  };
}

const candidate: DiscoveredCandidate = { name: "Acme Roofing", source: "places", website_url: "https://acme.com" };

test("IMPLEMENTED_STAGES includes crawl, extract and tech_detect now that they're real", () => {
  assert.ok(IMPLEMENTED_STAGES.has("crawl"));
  assert.ok(IMPLEMENTED_STAGES.has("classify"));
  assert.ok(IMPLEMENTED_STAGES.has("extract"));
  assert.ok(IMPLEMENTED_STAGES.has("tech_detect"));
});

test("classify (stage 30) calls classifyIndustry with crawledText undefined, fans out to crawl when in-industry", async () => {
  let calledWithCrawledText: string | undefined = "not called";
  const deps: StageDeps = {
    ...defaultStageDeps,
    classifyIndustry: async (_c, _industry, crawledText) => {
      calledWithCrawledText = crawledText;
      return { inIndustry: true, probability: 0.9, residentialCommercial: "residential", engine: "lmstudio" };
    },
  };
  const r = await HANDLERS.classify(task({ input: { candidate }, company_id: "co_1" }), job(), deps);
  assert.equal(calledWithCrawledText, undefined);
  assert.equal(r.status, "completed");
  assert.deepEqual(r.bump, ["in_industry"]);
  assert.equal(r.fan_out?.length, 1);
  assert.equal(r.fan_out?.[0].task_type, "crawl");
  assert.equal(r.fan_out?.[0].company_id, "co_1");
});

test("classify does not fan out to crawl when not in industry", async () => {
  const deps: StageDeps = {
    ...defaultStageDeps,
    classifyIndustry: async () => ({ inIndustry: false, probability: 0.1, residentialCommercial: "unknown", engine: "lmstudio" }),
  };
  const r = await HANDLERS.classify(task({ input: { candidate } }), job(), deps);
  assert.equal(r.fan_out?.length ?? 0, 0);
  assert.deepEqual(r.bump, []);
});

test("classify fails (retries) instead of dropping the company when no model answered", async () => {
  const deps: StageDeps = {
    ...defaultStageDeps,
    classifyIndustry: async () => ({ inIndustry: false, probability: 0.5, residentialCommercial: "unknown", engine: "lmstudio", parseError: "No LM Studio chat model resolved", callFailed: true }),
  };
  const r = await HANDLERS.classify(task({ input: { candidate }, company_id: "co_1" }), job(), deps);
  assert.equal(r.status, "failed");
  assert.match(r.error ?? "", /no model answered/);
  assert.equal(r.fan_out?.length ?? 0, 0);
});

test("crawl (stage 40) skips cleanly when the candidate has no website_url", async () => {
  const r = await HANDLERS.crawl(task({ task_type: "crawl", stage: 40, input: { candidate: { ...candidate, website_url: undefined } } }), job(), defaultStageDeps);
  assert.equal(r.status, "skipped");
  assert.equal(r.output?.reason, "no website_url to crawl");
});

test("crawl (stage 40) skips an aggregator-domain candidate without calling crawlSite", async () => {
  let crawlSiteCalled = false;
  const deps: StageDeps = {
    ...defaultStageDeps,
    crawlSite: async (pages, ctx) => {
      crawlSiteCalled = true;
      return { pages: [], costUsd: 0 };
    },
  };
  const aggregatorCandidate: DiscoveredCandidate = { name: "Acme Roofing", source: "places", website_url: "https://www.yelp.com/biz/acme-roofing" };
  const r = await HANDLERS.crawl(task({ task_type: "crawl", stage: 40, input: { candidate: aggregatorCandidate } }), job(), deps);
  assert.equal(crawlSiteCalled, false);
  assert.equal(r.status, "skipped");
  assert.equal(r.output?.reason, "aggregator-domain");
});

test("crawl (stage 40) fans out to extract + tech_detect on a successful crawl, carrying evidence", async () => {
  const deps: StageDeps = {
    ...defaultStageDeps,
    pickPages: () => ["https://acme.com/", "https://acme.com/about"],
    crawlSite: async (pages, ctx) => ({
      pages: pages.map((url) => ({
        ok: true,
        url,
        method: "http" as const,
        costUsd: 0,
        evidence: { sha: "s", companyId: ctx.companyId ?? "co_1", url, sourceType: "homepage" as const, txtPath: "/x/s.txt" },
      })),
      costUsd: 0,
    }),
  };
  const r = await HANDLERS.crawl(task({ task_type: "crawl", stage: 40, company_id: "co_1", input: { candidate } }), job(), deps);
  assert.equal(r.status, "completed");
  assert.deepEqual(r.bump, ["active_website"]);
  assert.equal(r.fan_out?.length, 2);
  assert.deepEqual(r.fan_out?.map((t) => t.task_type).sort(), ["extract", "tech_detect"]);
  const extractTask = r.fan_out?.find((t) => t.task_type === "extract");
  assert.equal((extractTask?.input?.evidence as unknown[]).length, 2);
});

test("crawl (stage 40) reports skipped, no fan-out, when every page fails", async () => {
  const deps: StageDeps = {
    ...defaultStageDeps,
    pickPages: () => ["https://acme.com/"],
    crawlSite: async () => ({ pages: [{ ok: false, url: "https://acme.com/", costUsd: 0, reason: "all-rungs-failed" as const }], costUsd: 0 }),
  };
  const r = await HANDLERS.crawl(task({ task_type: "crawl", stage: 40, company_id: "co_1", input: { candidate } }), job(), deps);
  assert.equal(r.status, "skipped");
  assert.equal(r.fan_out?.length ?? 0, 0);
});

const evidence = [{ sha: "s", companyId: "co_1", url: "https://acme.com/", sourceType: "homepage" as const, txtPath: "/x/s.txt" }];

test("extract (stage 50) calls extractFacts and fans out a public_data task", async () => {
  let calledWith: unknown;
  const deps: StageDeps = {
    ...defaultStageDeps,
    extractFacts: async (input) => {
      calledWith = input;
      return { companyId: input.companyId, factsBuilt: 2, factsWritten: 2, groundedCount: 2, ungroundedCount: 0, notes: [] };
    },
  };
  const r = await HANDLERS.extract(task({ task_type: "extract", stage: 50, company_id: "co_1", input: { candidate, evidence } }), job(), deps);
  assert.equal(r.status, "completed");
  assert.equal((calledWith as { companyId: string }).companyId, "co_1");
  assert.equal(r.fan_out?.length, 1);
  assert.equal(r.fan_out?.[0].task_type, "public_data");
  assert.equal(r.fan_out?.[0].stage, 55);
  assert.equal(r.fan_out?.[0].idempotency_key, "job_1:public_data:co_1");
  assert.equal(r.output?.factsWritten, 2);
});

test("extract (stage 50) skips cleanly when the task has no company_id", async () => {
  const r = await HANDLERS.extract(task({ task_type: "extract", stage: 50, input: { candidate, evidence } }), job(), defaultStageDeps);
  assert.equal(r.status, "skipped");
  assert.equal(r.output?.reason, "no company_id on extract task");
});

test("tech_detect (stage 50) calls detectTech and fans out the SAME public_data idempotency_key as extract", async () => {
  const deps: StageDeps = {
    ...defaultStageDeps,
    detectTech: async (input) => ({
      companyId: input.companyId, detected: [{ category: "crm", name: "GoHighLevel", fieldName: "crm", detectedVia: "script" }],
      techUpsertCalled: true, factsWritten: 1, spfIncludes: [], notes: [],
    }),
  };
  const r = await HANDLERS.tech_detect(task({ task_type: "tech_detect", stage: 50, company_id: "co_1", input: { candidate, evidence } }), job(), deps);
  assert.equal(r.status, "completed");
  assert.equal(r.fan_out?.[0].idempotency_key, "job_1:public_data:co_1");
  assert.deepEqual(r.output?.detected, [{ category: "crm", name: "GoHighLevel", via: "script" }]);
});

test("tech_detect (stage 50) skips cleanly when the task has no company_id", async () => {
  const r = await HANDLERS.tech_detect(task({ task_type: "tech_detect", stage: 50, input: { candidate, evidence } }), job(), defaultStageDeps);
  assert.equal(r.status, "skipped");
  assert.equal(r.output?.reason, "no company_id on tech_detect task");
});

// ── Stages 80/85/87/90 — buyer discovery + email/phone waterfalls (PR 11) ───────────────────────

test("find_people (stage 80) fans out find_email with the discovered person when buyerDiscover finds one", async () => {
  const deps: StageDeps = {
    ...defaultStageDeps,
    companiesGet: async () => ({ name: "Acme Roofing", website_url: "https://acme.com" }),
    buyerDiscover: async () => ({
      person: { fullName: "Jane Smith", title: "Owner", roleType: "owner", confidence: 0.8, source: "extracted_owner" },
      personId: "person_1",
      log: [{ source: "extracted_owner", outcome: "hit" }],
      costUsd: 0,
    }),
  };
  const r = await HANDLERS.find_people(task({ task_type: "find_people", stage: 80, company_id: "co_1", input: { companyId: "co_1", allow_mobile: true } }), job(), deps);
  assert.equal(r.status, "completed");
  assert.deepEqual(r.bump, ["dm_found"]);
  assert.equal(r.fan_out?.length, 1);
  assert.equal(r.fan_out?.[0].task_type, "find_email");
  assert.equal(r.fan_out?.[0].stage, 85);
  assert.deepEqual((r.fan_out?.[0].input as { person: { fullName: string } }).person.fullName, "Jane Smith");
});

test("find_people (stage 80) fans out nothing when no decision maker is found", async () => {
  const deps: StageDeps = {
    ...defaultStageDeps,
    companiesGet: async () => ({ name: "Acme Roofing" }),
    buyerDiscover: async () => ({ person: undefined, log: [], costUsd: 0 }),
  };
  const r = await HANDLERS.find_people(task({ task_type: "find_people", stage: 80, company_id: "co_1", input: { companyId: "co_1" } }), job(), deps);
  assert.equal(r.status, "completed");
  assert.deepEqual(r.bump, []);
  assert.equal(r.fan_out?.length ?? 0, 0);
});

test("find_email (stage 85) writes contact_methods and fans out verify_email on a waterfall hit", async () => {
  let upsertArgs: unknown;
  const deps: StageDeps = {
    ...defaultStageDeps,
    companiesGet: async () => ({ name: "Acme Roofing", website_url: "https://acme.com", fit_score: 85 }),
    runEmailWaterfall: async () => ({
      result: { hit: true, kind: "email", value: "jane@acme.com", provider: "hunter", confidence: 0.6, verificationStatus: "likely_valid", costUsd: 0.05 },
      log: [], totalCostUsd: 0.05,
    }),
    suppressionsCheck: async () => ({ blocked: false, hits: [] }),
    contactMethodsUpsert: async (args) => { upsertArgs = args; return { method: { id: "method_1", value: args.value, verification_status: args.verification_status ?? "unknown" }, action: "inserted" }; },
  };
  const r = await HANDLERS.find_email(task({ task_type: "find_email", stage: 85, company_id: "co_1", input: { companyId: "co_1", personId: "person_1", person: { fullName: "Jane Smith" } } }), job(), deps);
  assert.equal(r.status, "completed");
  assert.deepEqual(r.bump, ["email_found"]);
  assert.equal((upsertArgs as { value: string }).value, "jane@acme.com");
  assert.equal(r.fan_out?.[0].task_type, "verify_email");
  assert.equal(r.fan_out?.[0].stage, 87);
});

test("find_email (stage 85) blocks on a suppression hit: no contact_methods write, no fan_out", async () => {
  let upsertCalled = false;
  const deps: StageDeps = {
    ...defaultStageDeps,
    companiesGet: async () => ({ name: "Acme Roofing" }),
    runEmailWaterfall: async () => ({
      result: { hit: true, kind: "email", value: "jane@acme.com", provider: "hunter", confidence: 0.6, verificationStatus: "likely_valid", costUsd: 0.05 },
      log: [], totalCostUsd: 0.05,
    }),
    suppressionsCheck: async () => ({ blocked: true, hits: [{ reason: "unsubscribe" }] }),
    contactMethodsUpsert: async (args) => { upsertCalled = true; return { method: { id: "x", value: args.value, verification_status: "unknown" }, action: "inserted" }; },
  };
  const r = await HANDLERS.find_email(task({ task_type: "find_email", stage: 85, company_id: "co_1", input: { companyId: "co_1", personId: "person_1", person: { fullName: "Jane Smith" } } }), job(), deps);
  assert.equal(r.status, "completed");
  assert.equal(r.output?.blocked, true);
  assert.equal(upsertCalled, false);
  assert.equal(r.fan_out?.length ?? 0, 0);
});

test("find_email (stage 85) reports no fan-out when the whole waterfall misses", async () => {
  const deps: StageDeps = {
    ...defaultStageDeps,
    companiesGet: async () => ({ name: "Acme Roofing" }),
    runEmailWaterfall: async () => ({ result: null, log: [{ id: "site_mailto", outcome: "miss" as const, costUsd: 0 }], totalCostUsd: 0 }),
  };
  const r = await HANDLERS.find_email(task({ task_type: "find_email", stage: 85, company_id: "co_1", input: { companyId: "co_1", personId: "person_1", person: { fullName: "Jane Smith" } } }), job(), deps);
  assert.equal(r.status, "completed");
  assert.equal(r.output?.found, false);
  assert.equal(r.fan_out?.length ?? 0, 0);
});

test("verify_email (stage 87) upgrades status, writes contact_methods again, and fans out find_phone when phoneGate allows", async () => {
  let secondUpsert: unknown;
  const deps: StageDeps = {
    ...defaultStageDeps,
    companiesGet: async () => ({ fit_score: 92 }),
    verifyEmail: async () => ({ status: "verified" as const, verifier: "hunter" as const, costUsd: 0.02, attempted: true }),
    contactMethodsUpsert: async (args) => { secondUpsert = args; return { method: { id: "method_1", value: args.value, verification_status: args.verification_status ?? "unknown" }, action: "transitioned" }; },
  };
  const t = task({
    task_type: "verify_email", stage: 87, company_id: "co_1",
    input: { companyId: "co_1", personId: "person_1", methodId: "method_1", email: "jane@acme.com", provider: "hunter", initialStatus: "likely_valid", person: { fullName: "Jane Smith" }, allow_mobile: true },
  });
  const r = await HANDLERS.verify_email(t, job(), deps);
  assert.equal(r.status, "completed");
  assert.equal((secondUpsert as { verification_status: string }).verification_status, "verified");
  assert.equal(r.fan_out?.length, 1);
  assert.equal(r.fan_out?.[0].task_type, "find_phone");
});

test("verify_email (stage 87) does not fan out find_phone when phoneGate refuses (allow_mobile false)", async () => {
  const deps: StageDeps = {
    ...defaultStageDeps,
    companiesGet: async () => ({ fit_score: 92 }),
    verifyEmail: async () => ({ status: "verified" as const, costUsd: 0, attempted: true }),
  };
  const t = task({
    task_type: "verify_email", stage: 87, company_id: "co_1",
    input: { companyId: "co_1", personId: "person_1", email: "jane@acme.com", initialStatus: "likely_valid", person: { fullName: "Jane Smith" }, allow_mobile: false },
  });
  const r = await HANDLERS.verify_email(t, job(), deps);
  assert.equal(r.fan_out?.length ?? 0, 0);
  const gateOutput = r.output?.phoneGate as { allow: boolean } | undefined;
  assert.equal(gateOutput?.allow, false);
});

test("find_phone (stage 90) writes contact_methods on a mobile hit and bumps both funnel counters", async () => {
  let upsertArgs: unknown;
  const deps: StageDeps = {
    ...defaultStageDeps,
    companiesGet: async () => ({ fit_score: 92 }),
    runMobileWaterfall: async () => ({
      result: { hit: true, kind: "mobile", value: "+18135551234", provider: "leadmagic", confidence: 0.65, verificationStatus: "likely_valid", costUsd: 0.2 },
      log: [], totalCostUsd: 0.2,
    }),
    suppressionsCheck: async () => ({ blocked: false, hits: [] }),
    contactMethodsUpsert: async (args) => { upsertArgs = args; return { method: { id: "m2", value: args.value, verification_status: args.verification_status ?? "unknown" }, action: "inserted" }; },
  };
  const t = task({ task_type: "find_phone", stage: 90, company_id: "co_1", input: { companyId: "co_1", personId: "person_1", email: "jane@acme.com" } });
  const r = await HANDLERS.find_phone(t, job(), deps);
  assert.equal(r.status, "completed");
  assert.deepEqual(r.bump, ["mobile_requested", "mobile_found"]);
  assert.equal((upsertArgs as { kind: string }).kind, "mobile");
});

test("find_phone (stage 90) blocks a suppressed number: no write, only mobile_requested bumped", async () => {
  let upsertCalled = false;
  const deps: StageDeps = {
    ...defaultStageDeps,
    companiesGet: async () => ({ fit_score: 92 }),
    runMobileWaterfall: async () => ({
      result: { hit: true, kind: "mobile", value: "+18135551234", provider: "leadmagic", confidence: 0.65, verificationStatus: "likely_valid", costUsd: 0.2 },
      log: [], totalCostUsd: 0.2,
    }),
    suppressionsCheck: async () => ({ blocked: true, hits: [{ reason: "dnc" }] }),
    contactMethodsUpsert: async (args) => { upsertCalled = true; return { method: { id: "m2", value: args.value, verification_status: "unknown" }, action: "inserted" }; },
  };
  const t = task({ task_type: "find_phone", stage: 90, company_id: "co_1", input: { companyId: "co_1" } });
  const r = await HANDLERS.find_phone(t, job(), deps);
  assert.equal(r.output?.blocked, true);
  assert.equal(upsertCalled, false);
  assert.deepEqual(r.bump, ["mobile_requested"]);
});

test("find_phone (stage 90) reports mobile_requested with no mobile_found when the waterfall misses entirely", async () => {
  const deps: StageDeps = {
    ...defaultStageDeps,
    companiesGet: async () => ({ fit_score: 92 }),
    runMobileWaterfall: async () => ({ result: null, log: [], totalCostUsd: 0 }),
  };
  const t = task({ task_type: "find_phone", stage: 90, company_id: "co_1", input: { companyId: "co_1" } });
  const r = await HANDLERS.find_phone(t, job(), deps);
  assert.deepEqual(r.bump, ["mobile_requested"]);
  assert.equal(r.output?.found, false);
});

test("IMPLEMENTED_STAGES includes the PR 11 contact stages", () => {
  for (const s of ["find_people", "find_email", "verify_email", "find_phone"] as const) {
    assert.ok(IMPLEMENTED_STAGES.has(s));
  }
});
