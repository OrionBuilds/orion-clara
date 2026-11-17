import { test } from "node:test";
import assert from "node:assert/strict";
import { promoteCompany, prospectPromotionWatcherTick, DEFAULT_CRM_THRESHOLD, type PromoteDeps, type WatcherDeps } from "./promote";
import { OsProspectingUnavailableError, type CompanyFullRow, type CompaniesPromoteResult } from "./osBridge";
import type { DriveFile } from "../ms-files";

function fullRow(overrides: Partial<CompanyFullRow["company"]> = {}): CompanyFullRow {
  return {
    company: { id: "co_1", name: "Acme Roofing", city: "Tampa", state: "FL", fit_score: 85, ...overrides },
    people: [], contact_methods: [], technologies: [], facts: [], signals: [], enrollments: [],
  };
}

function okDriveFile(link = "https://drive.google.com/doc/123"): { ok: true; file: DriveFile } {
  return { ok: true, file: { id: "f1", name: "doc", webViewLink: link, mimeType: "application/vnd.google-apps.document" } as DriveFile };
}

function fakeDeps(overrides: Partial<PromoteDeps> = {}): PromoteDeps {
  return {
    companiesPromote: async () => ({ contact_id: "contact_1", opportunity_id: "opp_1", created: { contact: true, opportunity: true }, lead_score: 85 }),
    companiesGetFull: async () => fullRow(),
    companiesTimeline: async () => [],
    composeCallBrief: async () => ({ opener: "Hi", talkingPoints: ["a"], objections: [] }),
    factsAdd: async () => ({ inserted: [], signals_emitted: [] }),
    ensureFolder: async (name) => ({ id: `folder_${name}`, name, mimeType: "application/vnd.google-apps.folder" } as DriveFile),
    createFile: async () => okDriveFile(),
    loadConfig: async () => ({ claraDriveId: "drive_root" } as never),
    opportunityNotesCreate: async () => undefined,
    ...overrides,
  };
}

test("promoteCompany: calls companies_promote with the right args and reports ok on success", async () => {
  let promoteArgs: unknown;
  const deps = fakeDeps({ companiesPromote: async (args) => { promoteArgs = args; return { contact_id: "c1", opportunity_id: "o1", created: { contact: true, opportunity: true } }; } });
  const r = await promoteCompany("co_1", { reason: "manual" }, deps);
  assert.equal(r.ok, true);
  assert.equal(r.contactId, "c1");
  assert.equal(r.opportunityId, "o1");
  assert.deepEqual(promoteArgs, { company_id: "co_1", person_id: undefined, pipeline: undefined, stage: undefined, value_amount: undefined, reason: "manual" });
});

test("promoteCompany: generates the Drive doc named 'Research — {company} — {date}' and attaches it to the opportunity", async () => {
  let createArgs: { name: string; as: string; folderId?: string } | undefined;
  let notesOppId: string | undefined, notesContent: string | undefined;
  const deps = fakeDeps({
    createFile: async (input) => { createArgs = input; return okDriveFile("https://drive.google.com/doc/xyz"); },
    opportunityNotesCreate: async (oppId, content) => { notesOppId = oppId; notesContent = content; },
  });
  const r = await promoteCompany("co_1", {}, deps);
  const today = new Date().toISOString().slice(0, 10);
  assert.equal(createArgs?.name, `Research — Acme Roofing — ${today}`);
  assert.equal(createArgs?.as, "doc");
  assert.equal(r.docUrl, "https://drive.google.com/doc/xyz");
  assert.equal(notesOppId, "opp_1"); // from companiesPromote's default fake opportunity_id
  assert.match(notesContent ?? "", /https:\/\/drive\.google\.com\/doc\/xyz/);
});

test("promoteCompany: writes the call brief back as a company fact", async () => {
  let factsArgs: unknown;
  const deps = fakeDeps({ factsAdd: async (args) => { factsArgs = args; return { inserted: [], signals_emitted: [] }; } });
  await promoteCompany("co_1", {}, deps);
  const facts = (factsArgs as { facts: { field_name: string; subject_id: string; value: unknown }[] }).facts;
  assert.equal(facts[0].field_name, "call_brief");
  assert.equal(facts[0].subject_id, "co_1");
  assert.deepEqual(facts[0].value, { opener: "Hi", talkingPoints: ["a"], objections: [] });
});

test("promoteCompany: idempotent — a second promote of an already-promoted company still succeeds cleanly", async () => {
  // companies_promote itself is idempotent (prospect_promote RPC) — a company with contact_id
  // already set just returns the same ids with created:{contact:false, opportunity:false}. This
  // module must not special-case that: it should behave identically either way.
  const deps = fakeDeps({ companiesPromote: async () => ({ contact_id: "contact_1", opportunity_id: "opp_1", created: { contact: false, opportunity: false } }) });
  const r1 = await promoteCompany("co_1", { reason: "manual" }, deps);
  const r2 = await promoteCompany("co_1", { reason: "manual" }, deps);
  assert.deepEqual(r1.contactId, r2.contactId);
  assert.deepEqual(r1.opportunityId, r2.opportunityId);
  assert.equal(r1.created?.contact, false);
  assert.equal(r2.ok, true);
});

test("promoteCompany: OS unavailable is reported cleanly, not thrown", async () => {
  const deps = fakeDeps({ companiesPromote: async () => { throw new OsProspectingUnavailableError(new Error("unknown tool")); } });
  const r = await promoteCompany("co_1", {}, deps);
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /live yet/);
});

test("promoteCompany: the promotion itself still succeeds even if the Drive doc step fails entirely", async () => {
  const deps = fakeDeps({ companiesGetFull: async () => { throw new Error("OS timeout"); } });
  const r = await promoteCompany("co_1", {}, deps);
  assert.equal(r.ok, true);
  assert.equal(r.contactId, "contact_1");
  assert.equal(r.docUrl, undefined);
});

function watcherDeps(overrides: Partial<WatcherDeps> = {}): WatcherDeps {
  return {
    ...fakeDeps(),
    companiesSearch: async () => ({ rows: [], total: 0 }),
    prospectListsList: async () => [{ id: "list_1", name: "Tampa roofers" }],
    prospectSettingsGet: async () => undefined,
    ...overrides,
  };
}

test("prospectPromotionWatcherTick: off mode is a full no-op", async () => {
  process.env.CLARA_PROSPECTING = "off";
  try {
    let called = false;
    const deps = watcherDeps({ prospectListsList: async () => { called = true; return []; } });
    const r = await prospectPromotionWatcherTick(deps);
    assert.equal(r.mode, "off");
    assert.equal(called, false);
  } finally {
    delete process.env.CLARA_PROSPECTING;
  }
});

test("prospectPromotionWatcherTick: uses the org's crm_threshold as companies_search's fit_min (threshold boundary)", async () => {
  process.env.CLARA_PROSPECTING = "active";
  try {
    let searchArgs: unknown;
    const deps = watcherDeps({
      prospectSettingsGet: async () => ({ crm_threshold: 82 } as never),
      companiesSearch: async (args) => { searchArgs = args; return { rows: [], total: 0 }; },
    });
    await prospectPromotionWatcherTick(deps);
    assert.equal((searchArgs as { fit_min: number }).fit_min, 82);
    assert.equal((searchArgs as { promoted: boolean }).promoted, false);
  } finally {
    delete process.env.CLARA_PROSPECTING;
  }
});

test("prospectPromotionWatcherTick: falls back to the default threshold (75) when prospect_settings is unavailable", async () => {
  process.env.CLARA_PROSPECTING = "active";
  try {
    let searchArgs: unknown;
    const deps = watcherDeps({ companiesSearch: async (args) => { searchArgs = args; return { rows: [], total: 0 }; } });
    await prospectPromotionWatcherTick(deps);
    assert.equal((searchArgs as { fit_min: number }).fit_min, DEFAULT_CRM_THRESHOLD);
  } finally {
    delete process.env.CLARA_PROSPECTING;
  }
});

test("prospectPromotionWatcherTick: shadow mode counts candidates but never calls companies_promote", async () => {
  process.env.CLARA_PROSPECTING = "shadow";
  try {
    let promoteCalled = false;
    const deps = watcherDeps({
      companiesSearch: async () => ({ rows: [{ id: "co_1" }, { id: "co_2" }], total: 2 }),
      companiesPromote: async () => { promoteCalled = true; return { contact_id: "x", opportunity_id: "y", created: { contact: true, opportunity: true } }; },
    });
    const r = await prospectPromotionWatcherTick(deps);
    assert.equal(r.candidates, 2);
    assert.equal(r.promoted, 0);
    assert.equal(promoteCalled, false);
  } finally {
    delete process.env.CLARA_PROSPECTING;
  }
});

test("prospectPromotionWatcherTick: active mode promotes every candidate across every active list", async () => {
  process.env.CLARA_PROSPECTING = "active";
  try {
    const promotedIds: string[] = [];
    const deps = watcherDeps({
      prospectListsList: async () => [{ id: "list_1" }, { id: "list_2" }],
      companiesSearch: async (args) => {
        const listId = (args as { list_id: string }).list_id;
        return { rows: listId === "list_1" ? [{ id: "co_1" }] : [{ id: "co_2" }, { id: "co_3" }], total: 0 };
      },
      companiesPromote: async (args) => { promotedIds.push(args.company_id); return { contact_id: `c_${args.company_id}`, opportunity_id: `o_${args.company_id}`, created: { contact: true, opportunity: true } }; },
    });
    const r = await prospectPromotionWatcherTick(deps);
    assert.equal(r.listsScanned, 2);
    assert.equal(r.candidates, 3);
    assert.equal(r.promoted, 3);
    assert.deepEqual(promotedIds.sort(), ["co_1", "co_2", "co_3"]);
  } finally {
    delete process.env.CLARA_PROSPECTING;
  }
});

test("prospectPromotionWatcherTick: one company's promotion failure doesn't stop the rest", async () => {
  process.env.CLARA_PROSPECTING = "active";
  try {
    const deps = watcherDeps({
      companiesSearch: async () => ({ rows: [{ id: "bad" }, { id: "good" }], total: 2 }),
      companiesPromote: async (args) => {
        if (args.company_id === "bad") throw new Error("db error");
        return { contact_id: "c1", opportunity_id: "o1", created: { contact: true, opportunity: true } };
      },
    });
    const r = await prospectPromotionWatcherTick(deps);
    assert.equal(r.promoted, 1);
    assert.equal(r.failed, 1);
    assert.ok(r.notes.some((n) => n.includes("bad")));
  } finally {
    delete process.env.CLARA_PROSPECTING;
  }
});
