// crawler/robots.ts — a minimal robots.txt cache: fetched and parsed once per origin per process,
// TTL'd (~1h — robots.txt changes rarely and a crawl job runs over minutes-to-hours, not days).
//
// Honors Disallow/Allow for "*" and a CLARA-identifying user-agent group (the more specific group
// wins when both exist, matching the spec's "most specific user-agent" rule). Deliberately ignores
// Crawl-delay and Sitemap directives — out of scope for PR 7 (see the brief). A fetch failure (no
// robots.txt, timeout, non-200) is treated as "everything allowed" — the standard crawling-citizen
// default when a site simply has no robots.txt.

export const CRAWLER_USER_AGENT = "ClaraProspectBot";

interface RobotsRules {
  disallow: string[];
  allow: string[];
}

interface CacheEntry {
  rules: RobotsRules;
  fetchedAtMs: number;
}

const TTL_MS = 60 * 60 * 1000; // 1h
const EMPTY_RULES: RobotsRules = { disallow: [], allow: [] };
const cache = new Map<string, CacheEntry>();

function parseRobots(body: string, userAgent: string): RobotsRules {
  const lines = body
    .split(/\r?\n/)
    .map((l) => l.replace(/#.*$/, "").trim())
    .filter(Boolean);

  const groups: { agents: string[]; rules: RobotsRules }[] = [];
  let current: { agents: string[]; rules: RobotsRules } | null = null;
  for (const line of lines) {
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const field = m[1].toLowerCase();
    const value = m[2].trim();
    if (field === "user-agent") {
      // Consecutive User-agent lines with no rules yet between them form one group (the spec's
      // "grouping" rule); a User-agent line after rules have started starts a new group.
      if (current && current.rules.disallow.length === 0 && current.rules.allow.length === 0) {
        current.agents.push(value.toLowerCase());
      } else {
        current = { agents: [value.toLowerCase()], rules: { disallow: [], allow: [] } };
        groups.push(current);
      }
    } else if (field === "disallow" && current) {
      if (value) current.rules.disallow.push(value);
    } else if (field === "allow" && current) {
      if (value) current.rules.allow.push(value);
    }
  }

  const ua = userAgent.toLowerCase();
  const specific = groups.find((g) => g.agents.some((a) => a !== "*" && ua.includes(a)));
  if (specific) return specific.rules;
  const wildcard = groups.find((g) => g.agents.includes("*"));
  return wildcard?.rules ?? EMPTY_RULES;
}

/** Longest matching Disallow/Allow prefix wins (the spec's rule); a tie favors Allow. */
function pathAllowed(rules: RobotsRules, path: string): boolean {
  let bestAllow = -1;
  let bestDisallow = -1;
  for (const p of rules.allow) if (path.startsWith(p)) bestAllow = Math.max(bestAllow, p.length);
  for (const p of rules.disallow) if (path.startsWith(p)) bestDisallow = Math.max(bestDisallow, p.length);
  if (bestDisallow < 0) return true;
  return bestAllow >= bestDisallow;
}

async function fetchRobots(origin: string): Promise<RobotsRules> {
  try {
    const r = await fetch(`${origin}/robots.txt`, {
      headers: { "user-agent": CRAWLER_USER_AGENT },
      signal: AbortSignal.timeout(8_000),
    });
    if (!r.ok) return EMPTY_RULES;
    return parseRobots(await r.text(), CRAWLER_USER_AGENT);
  } catch {
    return EMPTY_RULES;
  }
}

/** True if `url` may be fetched by this crawler per its origin's robots.txt (cached ~1h/origin). A
 *  malformed URL is treated as allowed — the fetch itself will fail downstream and report that. */
export async function isAllowedByRobots(url: string): Promise<boolean> {
  let origin: string;
  let path: string;
  try {
    const u = new URL(url);
    origin = u.origin;
    path = u.pathname + u.search || "/";
  } catch {
    return true;
  }

  const now = Date.now();
  const hit = cache.get(origin);
  if (hit && now - hit.fetchedAtMs < TTL_MS) {
    return pathAllowed(hit.rules, path);
  }
  const rules = await fetchRobots(origin);
  cache.set(origin, { rules, fetchedAtMs: now });
  return pathAllowed(rules, path);
}

/** Test/process-cleanup hook — drops every cached origin's rules. */
export function clearRobotsCache(): void {
  cache.clear();
}
