// signals/checks/leadershipChange.ts — PR 18: has the company's /team or /about page's named
// leadership roster changed since last scan?
//
// Crawls `/team` first, falling back to `/about` only if `/team` didn't yield usable text — a team
// page is far more likely to actually name individuals+titles than a generic about page, which is
// why it's tried first rather than crawling both every scan (one crawl is enough once it succeeds;
// both are $0 under today's rates.json anyway, so trying `/team` then `/about` costs nothing extra
// on the common case where `/team` works). Deliberately NOT pagePicker.ts's full alternate-spelling
// fan-out (/our-team, /meet-the-team, …) for the same reason hiring.ts skips it for /careers — this
// is a cheap recurring scan, not a first-crawl discovery pass.
//
// Extraction: tier-1 (same tier, same reasoning as hiring.ts — a simple "who's named on this page"
// read, not worth a bigger model), asking for strict JSON `{"people": [{"name", "title"}]}`.
//
// SCORE: +7. Documented judgment call (the plan leaves the exact number open) — scaled to sit
// between new_location's +10 (a hard, unambiguous fact: a brand-new place_id either exists or
// doesn't) and hiring's generic +3/sales-ops +8, roughly matching how orion/mcp-server/src/tools/
// prospects.ts's OWN factChangeSignal already treats an owner/ceo/general_manager fact change —
// `strength: 'high'`, the same tier new_location and sales/ops-hiring get there — while staying
// slightly below this PR's own hiring/new_location numbers since a /team page's wording can shift
// for reasons short of an actual personnel change (a rewritten bio, a reordered page) in a way a
// hard place_id or role-title diff mostly can't.
//
// FIELD-NAMING, to avoid the OS's own auto-signal collision (see writers.ts's doc comment): the OS
// already auto-emits a score-less `leadership_change` signal off its OWN `owner`/`ceo`/
// `general_manager` fact fields (factChangeSignal). This check never writes to any of those three;
// its own last-checked/diff-baseline state goes under "leadership_names_hash" (a hash of the sorted
// name+title list), so writeLastCheckedFact's facts_add call can never accidentally trigger that
// score-less OS-side path. The real, SCORED `leadership_change` signal here only ever comes from
// this file's own fireSignal call.

import { hashContent, diffChanged } from "../diff";
import { websiteOrigin } from "../pageUrls";
import type { CompanySignalInput, SignalRunDeps, SignalRunResult } from "../types";

export const LEADERSHIP_NAMES_FIELD = "leadership_names_hash";
export const LEADERSHIP_CHANGE_SCORE_DELTA = 7;

export interface LeadershipPerson {
  name: string;
  title?: string;
}

/** Pure: parses a tier-1 `{"people": [{"name","title"}]}` response into a clean list. Malformed
 *  JSON (or a shape that isn't `{people: [...]}`) degrades to an empty list rather than throwing —
 *  exported for direct unit testing (leadershipChange.test.ts's "malformed extraction handled
 *  gracefully"). */
export function parseLeadershipResponse(text: string | undefined): LeadershipPerson[] {
  if (!text || !text.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const obj = parsed as { people?: unknown };
  if (!obj || !Array.isArray(obj.people)) return [];
  const out: LeadershipPerson[] = [];
  for (const p of obj.people) {
    if (!p || typeof p !== "object") continue;
    const name = (p as { name?: unknown }).name;
    const title = (p as { title?: unknown }).title;
    if (typeof name === "string" && name.trim()) {
      out.push({ name: name.trim(), title: typeof title === "string" && title.trim() ? title.trim() : undefined });
    }
  }
  return out;
}

/** Pure: the sorted "name|title" hash this check diffs scan-to-scan. Exported for direct testing. */
export function leadershipHash(people: readonly LeadershipPerson[]): string {
  const normalized = people.map((p) => `${p.name.toLowerCase().trim()}|${(p.title ?? "").toLowerCase().trim()}`).sort();
  return hashContent(JSON.stringify(normalized));
}

export async function runLeadershipChangeCheck(company: CompanySignalInput, deps: SignalRunDeps): Promise<SignalRunResult> {
  if (!company.website_url) {
    return { ran: false, changed: false, signalFired: false, costCentsSpent: 0, notes: ["no website_url"], skippedReason: "no_website_url" };
  }
  const origin = websiteOrigin(company.website_url);
  if (!origin) {
    return { ran: false, changed: false, signalFired: false, costCentsSpent: 0, notes: ["unparseable website_url"], skippedReason: "unparseable_website_url" };
  }

  const notes: string[] = [];
  let costCentsSpent = 0;
  let text: string | undefined;
  let sourceUrl: string | undefined;

  for (const path of ["/team", "/about"]) {
    const url = `${origin}${path}`;
    const r = await deps.crawlPage(url, { companyId: company.id });
    costCentsSpent += (r.costUsd ?? 0) * 100;
    if (r.ok && r.evidence?.txtPath) {
      try {
        text = await deps.readFile(r.evidence.txtPath);
        sourceUrl = url;
        break;
      } catch (e) {
        notes.push(`${path}: could not read crawled text (${e instanceof Error ? e.message : String(e)})`);
      }
    } else if (!r.ok) {
      notes.push(`${path}: ${r.reason ?? r.error ?? "crawl failed"}`);
    }
  }

  if (!text) {
    return { ran: false, changed: false, signalFired: false, costCentsSpent, notes: [...notes, "no team/about page text available"], skippedReason: "no_page_text" };
  }

  const prompt = `Extract the named individuals (owners, executives, managers) and their apparent titles mentioned on this page. Respond with STRICT JSON only, no commentary: {"people": [{"name": string, "title": string}]}. If none are named, return {"people": []}.\n\nPage text:\n${text.slice(0, 6000)}`;
  const llm = await deps.runTier(1, prompt, { purpose: "prospect:signal_leadership_extract", json: true, maxTokens: 400 });
  let people: LeadershipPerson[] = [];
  if (llm.ok) {
    people = parseLeadershipResponse(llm.text);
    if (!people.length && llm.text?.trim()) notes.push("extraction returned no usable {people:[...]} — treated as no names found");
  } else {
    notes.push(`leadership extraction unavailable: ${llm.error ?? "tier-1 call failed"}`);
  }

  const hash = leadershipHash(people);
  const existing = await deps.factsList({ subject_type: "company", subject_id: company.id, field_name: LEADERSHIP_NAMES_FIELD });
  const prevHash = typeof existing[0]?.value === "string" ? existing[0].value : undefined;
  const changed = diffChanged(prevHash, hash);
  const observedAt = deps.now().toISOString();

  await deps.writeLastCheckedFact({
    companyId: company.id,
    fieldName: LEADERSHIP_NAMES_FIELD,
    value: hash,
    sourceType: "website_page",
    sourceUrl,
    observedAt,
  });

  if (!changed) {
    return { ran: true, changed: false, signalFired: false, costCentsSpent, notes: [...notes, prevHash === undefined ? "baseline scan — no signal" : "no leadership change detected"] };
  }

  await deps.fireSignal({
    companyId: company.id,
    signalType: "leadership_change",
    headline: people.length ? `Leadership page changed (${people.map((p) => p.name).slice(0, 3).join(", ")})` : "Leadership page changed",
    detail: `Team/about page extraction now reads: ${people.map((p) => (p.title ? `${p.name} (${p.title})` : p.name)).join(", ") || "no named individuals found"}.`,
    strength: "high",
    scoreDelta: LEADERSHIP_CHANGE_SCORE_DELTA,
    sourceUrl,
    observedAt,
  });

  return { ran: true, changed: true, signalFired: true, costCentsSpent, notes: [...notes, "leadership change detected"] };
}
