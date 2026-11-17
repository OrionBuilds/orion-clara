// promote.ts — PR 12: the only door from the prospect graph into the CRM, driven from Clara's side
// (plan §25). Two entry points, both converging on promoteCompany():
//   - prospectPromotionWatcherTick() — scheduler job "prospect-promotion-watcher", every 30 min:
//     scans every active (non-archived) prospect list for companies at/above
//     prospect_settings.crm_threshold that haven't been promoted yet (companies.contact_id IS
//     NULL — companies_search's own `promoted:false` filter does this check for us).
//   - promoteCompany() called directly by the Office's "Add to pipeline" button
//     (POST /api/prospects/lists/[id]/promote, reason "manual") for an explicit, threshold-
//     bypassing promotion of one or more selected companies.
//
// companies_promote (→ RPC prospect_promote) is idempotent on companies.contact_id — re-running
// this against an already-promoted company is a safe no-op that just returns the existing ids, so
// neither caller needs its own dedupe logic.
//
// After a successful promotion, Clara best-effort generates a Drive research doc ("Research —
// {company} — {date}", under her shared drive's Prospecting/<date>/), attaches it to the new
// opportunity via opportunity_notes_create, and writes the tier-3 call brief back as a company fact
// (field_name "call_brief") so it's visible in the Office even if the Drive step fails. None of
// that best-effort work ever undoes or fails the promotion itself, which already succeeded by the
// time any of it runs.

import {
  companiesPromote as companiesPromoteReal, companiesGetFull as companiesGetFullReal,
  companiesTimeline as companiesTimelineReal, companiesSearch as companiesSearchReal,
  prospectListsList as prospectListsListReal, prospectSettingsGet as prospectSettingsGetReal,
  factsAdd as factsAddReal, OsProspectingUnavailableError,
  type CompanyFullRow, type CompanyTimelineRow, type CompaniesPromoteResult,
} from "./osBridge";
import { prospectingMode } from "./types";
import { composeCallBrief as composeCallBriefReal, type CallBrief } from "./intel/callBrief";
import { composeCompanyResearchDoc } from "./report/composeCompany";
import { ensureFolder as ensureFolderReal, createFile as createFileReal, type DriveFile } from "../ms-files";
import { loadConfig as loadConfigReal } from "../config";
import { osClient } from "../osClient";
import { append as ledgerAppend } from "../ledger";

export const DEFAULT_CRM_THRESHOLD = 75;

function unwrapToolContent(content: unknown): unknown {
  if (Array.isArray(content)) {
    const first = content.find((c) => c && typeof c === "object" && "text" in (c as object));
    if (first && typeof (first as { text?: unknown }).text === "string") {
      try { return JSON.parse((first as { text: string }).text); } catch { return (first as { text: string }).text; }
    }
  }
  return content;
}

/** opportunity_notes_create lives on the main CLARA_OS_TOOLS allowlist (not the prospecting
 *  extension client) — see agent-core/src/osmcp/allowlists.ts. A note is a nice-to-have audit
 *  trail, not the record of truth (the Drive doc itself is), so this swallows its own errors. */
export async function opportunityNotesCreate(opportunityId: string, content: string): Promise<void> {
  await osClient.callTool("opportunity_notes_create", { opportunity_id: opportunityId, content }).then(unwrapToolContent).catch(() => undefined);
}

export interface PromoteDeps {
  companiesPromote: typeof companiesPromoteReal;
  companiesGetFull: typeof companiesGetFullReal;
  companiesTimeline: typeof companiesTimelineReal;
  composeCallBrief: typeof composeCallBriefReal;
  factsAdd: typeof factsAddReal;
  ensureFolder: typeof ensureFolderReal;
  createFile: typeof createFileReal;
  loadConfig: typeof loadConfigReal;
  opportunityNotesCreate: typeof opportunityNotesCreate;
}

export const defaultPromoteDeps: PromoteDeps = {
  companiesPromote: companiesPromoteReal,
  companiesGetFull: companiesGetFullReal,
  companiesTimeline: companiesTimelineReal,
  composeCallBrief: composeCallBriefReal,
  factsAdd: factsAddReal,
  ensureFolder: ensureFolderReal,
  createFile: createFileReal,
  loadConfig: loadConfigReal,
  opportunityNotesCreate,
};

export interface PromoteCompanyOpts {
  personId?: string;
  pipeline?: string;
  stage?: string;
  valueAmount?: number;
  /** Attribution carried into the opportunity's description/timeline (prospect_promote's p_reason)
   *  and this module's own ledger line — "fit_threshold" (the watcher) or "manual" (Office button). */
  reason?: "fit_threshold" | "manual";
}

export interface PromoteCompanyResult {
  ok: boolean;
  companyId: string;
  contactId?: string;
  opportunityId?: string;
  created?: CompaniesPromoteResult["created"];
  docUrl?: string;
  error?: string;
}

async function todayFolder(deps: PromoteDeps): Promise<string | undefined> {
  const cfg = await deps.loadConfig();
  const parent = cfg.claraDriveId || undefined;
  const prospecting = await deps.ensureFolder("Prospecting", parent);
  const today = new Date().toISOString().slice(0, 10);
  const dayFolder = await deps.ensureFolder(today, prospecting?.id);
  return dayFolder?.id;
}

/** Best-effort: generates the Drive research doc, attaches it to the opportunity, and writes the
 *  call_brief fact. Never throws — a failure here is logged and the caller still reports the
 *  promotion itself as successful (it already happened). */
async function deliverResearchPackage(companyId: string, opportunityId: string | undefined, deps: PromoteDeps): Promise<{ docUrl?: string }> {
  try {
    const [full, timeline] = await Promise.all([
      deps.companiesGetFull(companyId),
      deps.companiesTimeline({ company_id: companyId, limit: 20 }).catch(() => [] as CompanyTimelineRow[]),
    ]);
    const brief = await deps.composeCallBrief(full, timeline).catch(() => undefined as CallBrief | undefined);
    const date = new Date().toISOString().slice(0, 10);
    const content = composeCompanyResearchDoc(full, timeline, brief, date);
    const name = typeof full.company.name === "string" && full.company.name ? full.company.name : companyId;

    const folderId = await todayFolder(deps).catch(() => undefined);
    const doc = await deps.createFile({ name: `Research — ${name} — ${date}`, content, as: "doc", folderId });

    if (doc.ok && doc.file?.webViewLink && opportunityId) {
      await deps.opportunityNotesCreate(opportunityId, `Research doc: ${doc.file.webViewLink}`);
    }
    if (brief) {
      await deps.factsAdd({
        facts: [{
          subject_type: "company", subject_id: companyId, field_name: "call_brief",
          value: brief, source_type: "derived", confidence: 0.6,
        }],
      }).catch(() => undefined);
    }
    return { docUrl: doc.ok ? doc.file?.webViewLink : undefined };
  } catch (e) {
    await ledgerAppend({ kind: "action", actor: "clara", what: `prospecting: research doc delivery failed for company ${companyId}: ${e instanceof Error ? e.message : String(e)}`, meta: { companyId } }).catch(() => undefined);
    return {};
  }
}

export async function promoteCompany(companyId: string, opts: PromoteCompanyOpts = {}, deps: PromoteDeps = defaultPromoteDeps): Promise<PromoteCompanyResult> {
  let promoted: CompaniesPromoteResult;
  try {
    promoted = await deps.companiesPromote({
      company_id: companyId,
      person_id: opts.personId,
      pipeline: opts.pipeline,
      stage: opts.stage,
      value_amount: opts.valueAmount,
      reason: opts.reason ?? "manual",
    });
  } catch (e) {
    if (e instanceof OsProspectingUnavailableError) return { ok: false, companyId, error: "the OS prospecting tables aren't live yet" };
    return { ok: false, companyId, error: e instanceof Error ? e.message : String(e) };
  }

  const { docUrl } = await deliverResearchPackage(companyId, promoted.opportunity_id, deps);

  await ledgerAppend({
    kind: "action", actor: "clara",
    what: `prospecting: promoted company ${companyId} to CRM (${opts.reason ?? "manual"}) — contact ${promoted.contact_id}, opportunity ${promoted.opportunity_id}`,
    meta: { companyId, contactId: promoted.contact_id, opportunityId: promoted.opportunity_id, reason: opts.reason ?? "manual" },
  }).catch(() => undefined);

  return { ok: true, companyId, contactId: promoted.contact_id, opportunityId: promoted.opportunity_id, created: promoted.created, docUrl };
}

// ── Watcher (scheduler job "prospect-promotion-watcher", every 30 min) ─────────────────────────

function rowsOf(raw: unknown): Record<string, unknown>[] {
  if (Array.isArray(raw)) return raw as Record<string, unknown>[];
  if (raw && typeof raw === "object" && Array.isArray((raw as { rows?: unknown }).rows)) return (raw as { rows: Record<string, unknown>[] }).rows;
  return [];
}

export interface WatcherDeps extends PromoteDeps {
  companiesSearch: typeof companiesSearchReal;
  prospectListsList: typeof prospectListsListReal;
  prospectSettingsGet: typeof prospectSettingsGetReal;
}
export const defaultWatcherDeps: WatcherDeps = {
  ...defaultPromoteDeps,
  companiesSearch: companiesSearchReal,
  prospectListsList: prospectListsListReal,
  prospectSettingsGet: prospectSettingsGetReal,
};

export interface PromotionWatcherResult {
  mode: ReturnType<typeof prospectingMode>;
  listsScanned: number;
  candidates: number;
  promoted: number;
  failed: number;
  notes: string[];
}

/**
 * For every active (non-archived) prospect list, promotes every company at/above
 * prospect_settings.crm_threshold (default 75) that hasn't been promoted yet. Runs under the same
 * off|shadow|active gate as the rest of the engine: `shadow` scans and reports candidates but never
 * actually calls companies_promote (promotion is a real, visible CRM write — not something a fresh
 * deploy should ever do silently); `off` is a full no-op.
 */
export async function prospectPromotionWatcherTick(deps: WatcherDeps = defaultWatcherDeps): Promise<PromotionWatcherResult> {
  const mode = prospectingMode();
  const res: PromotionWatcherResult = { mode, listsScanned: 0, candidates: 0, promoted: 0, failed: 0, notes: [] };
  if (mode === "off") { res.notes.push("prospecting off"); return res; }

  const settings = await deps.prospectSettingsGet().catch(() => undefined);
  const threshold = settings?.crm_threshold ?? DEFAULT_CRM_THRESHOLD;

  let lists: { id: string; name?: string }[];
  try {
    const raw = await deps.prospectListsList({});
    lists = (Array.isArray(raw) ? raw : []) as { id: string; name?: string }[];
  } catch (e) {
    if (e instanceof OsProspectingUnavailableError) { res.notes.push("OS prospecting tables not live yet"); return res; }
    throw e;
  }
  res.listsScanned = lists.length;

  for (const list of lists) {
    let candidates: Record<string, unknown>[];
    try {
      candidates = rowsOf(await deps.companiesSearch({ list_id: list.id, fit_min: threshold, promoted: false, limit: 200 }));
    } catch (e) {
      if (e instanceof OsProspectingUnavailableError) { res.notes.push("OS prospecting tables not live yet"); return res; }
      res.notes.push(`list ${list.name ?? list.id}: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    res.candidates += candidates.length;
    if (mode === "shadow") continue; // report-only — see doc comment

    for (const c of candidates) {
      const id = typeof c.id === "string" ? c.id : undefined;
      if (!id) continue;
      const r = await promoteCompany(id, { reason: "fit_threshold" }, deps);
      if (r.ok) res.promoted++;
      else { res.failed++; res.notes.push(`${id}: ${r.error}`); }
    }
  }
  return res;
}
