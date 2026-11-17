// Clara — general web search via the Brave Search API.
//
// Distinct from places.ts (structured business data — hours/phone/rating, not general web
// content) and from deepwork.ts's runDeepWork (a multi-minute claude-CLI research session that
// produces file deliverables). This is the fast, inline "search a few results and answer in one
// reply" tool — for anything that isn't about a specific local business and doesn't need a
// multi-minute research pass.
//
// A brand-new credential, not shared with the Google Maps Platform key: set
// CLARA_BRAVE_SEARCH_API_KEY in .env.local (get one at https://brave.com/search/api).

const API_URL = "https://api.search.brave.com/res/v1/web/search";

export function braveSearchConfigured(): boolean {
  return Boolean(process.env.CLARA_BRAVE_SEARCH_API_KEY?.trim());
}

export interface WebSearchResult {
  title: string;
  url: string;
  snippet?: string;
}

interface BraveSearchApiResponse {
  web?: { results?: { title?: string; url?: string; description?: string }[] };
}

export async function webSearch(query: string, opts?: { count?: number }): Promise<{ ok: boolean; results: WebSearchResult[]; error?: string }> {
  const key = process.env.CLARA_BRAVE_SEARCH_API_KEY?.trim();
  if (!key) return { ok: false, results: [], error: "Brave Search not configured (set CLARA_BRAVE_SEARCH_API_KEY)" };
  if (!query.trim()) return { ok: false, results: [], error: "no query given" };

  const count = Math.min(Math.max(opts?.count ?? 5, 1), 10);
  const url = `${API_URL}?${new URLSearchParams({ q: query, count: String(count) }).toString()}`;

  const r = await fetch(url, {
    headers: { Accept: "application/json", "X-Subscription-Token": key },
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
  if (!r) return { ok: false, results: [], error: "Brave Search request failed (network/timeout)" };
  if (!r.ok) return { ok: false, results: [], error: `Brave Search API ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}` };

  const j = await r.json().catch(() => ({})) as BraveSearchApiResponse;
  const results: WebSearchResult[] = (j.web?.results ?? [])
    .filter((x): x is { title: string; url: string; description?: string } => Boolean(x.title && x.url))
    .map((x) => ({ title: x.title, url: x.url, snippet: x.description }));

  return { ok: true, results };
}
