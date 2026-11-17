// crawler/pagePicker.ts — pick ≤6 candidate pages to crawl for a company's site.
//
// Pure, no I/O. Given a base URL/domain (and optionally links already discovered — e.g. hrefs
// pulled from an earlier fetch of the homepage), returns an ordered list of absolute URLs to
// attempt, most valuable first: home, then the best-matching about/contact/services/team/careers
// page. A 404 on a guessed path is the waterfall/caller's problem, not this function's — pagePicker
// never does I/O to check whether a path actually exists.

const MAX_PAGES = 6;

// Canonical path, then the common alternate spellings — tried, in order, only if nothing in
// `discoveredLinks` already matches one of them. This list's order IS the priority order.
const PAGE_VARIANTS: ReadonlyArray<{ canonical: string; alternates: readonly string[] }> = [
  { canonical: "/about", alternates: ["/about-us", "/our-story", "/company"] },
  { canonical: "/contact", alternates: ["/contact-us", "/get-a-quote", "/get-in-touch"] },
  { canonical: "/services", alternates: ["/our-services", "/what-we-do"] },
  { canonical: "/team", alternates: ["/our-team", "/meet-the-team"] },
  { canonical: "/careers", alternates: ["/jobs", "/careers-and-jobs", "/employment"] },
];

function baseOrigin(baseUrl: string): string | undefined {
  const withScheme = /^https?:\/\//i.test(baseUrl) ? baseUrl : `https://${baseUrl}`;
  try {
    return new URL(withScheme).origin;
  } catch {
    return undefined;
  }
}

function normalizePath(pathname: string): string {
  const noTrailingSlash = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  return noTrailingSlash || "/";
}

/** Index discovered links by their (origin-matching, normalized) path, so a real link the crawler
 *  already saw — however it's spelled — wins over blindly guessing the canonical path. */
function indexDiscoveredLinks(origin: string, links: string[] | undefined): Map<string, string> {
  const byPath = new Map<string, string>();
  for (const link of links ?? []) {
    try {
      const u = new URL(link, origin);
      if (u.origin !== origin) continue;
      const path = normalizePath(u.pathname);
      if (!byPath.has(path)) byPath.set(path, `${origin}${path}`);
    } catch {
      /* not a usable URL — skip it */
    }
  }
  return byPath;
}

/**
 * Picks up to 6 absolute URLs to crawl for a company's site: the homepage plus the best-matching
 * about/contact/services/team/careers pages (home always first). Handles a bare domain
 * ("acme.com"), a scheme-less host, and an already-slashed URL equally. Deduped by normalized path
 * — a discovered link and a canonical guess that resolve to the same path only appear once.
 */
export function pickPages(baseUrl: string, discoveredLinks?: string[]): string[] {
  const origin = baseOrigin(baseUrl);
  if (!origin) return [];

  const discoveredByPath = indexDiscoveredLinks(origin, discoveredLinks);

  const picked: string[] = [`${origin}/`];
  const pickedPaths = new Set<string>(["/"]);

  for (const variant of PAGE_VARIANTS) {
    if (picked.length >= MAX_PAGES) break;
    const candidatePaths = [variant.canonical, ...variant.alternates];
    let url: string | undefined;
    for (const p of candidatePaths) {
      const hit = discoveredByPath.get(p);
      if (hit) {
        url = hit;
        break;
      }
    }
    if (!url) url = `${origin}${variant.canonical}`;
    const path = normalizePath(new URL(url).pathname);
    if (pickedPaths.has(path)) continue;
    pickedPaths.add(path);
    picked.push(url);
  }

  return picked.slice(0, MAX_PAGES);
}
