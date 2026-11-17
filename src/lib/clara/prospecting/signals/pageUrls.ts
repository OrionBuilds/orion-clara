// signals/pageUrls.ts — tiny, pure URL helpers for the 3 fixed target pages (home/services/
// financing) website-change re-crawls every scan.
//
// Deliberately NOT crawler/pagePicker.ts: that module picks up to 6 pages from a broader
// variant/alternate-spelling list (about/contact/services/team/careers), built for a FIRST crawl's
// "find whatever page actually exists" discovery. This PR always wants the SAME 3 fixed canonical
// paths every scan, scan after scan, so a hash computed today is comparable to one computed last
// week — pagePicker's "prefer a discovered link's actual spelling over the canonical guess"
// behavior would defeat that (a site's about page moving from /contact to /contact-us would look
// like a changed PAGE, not a changed hash of the same page).

export function websiteOrigin(websiteUrl: string): string | undefined {
  const withScheme = /^https?:\/\//i.test(websiteUrl) ? websiteUrl : `https://${websiteUrl}`;
  try {
    return new URL(withScheme).origin;
  } catch {
    return undefined;
  }
}

export interface TargetPage {
  key: "home" | "services" | "financing";
  /** facts.field_name this page's hash is stored/compared under. */
  fieldName: string;
  url: string;
}

/** The 3 pages website-change hashes, in order (home first — also the page tech-change reuses). */
export function targetPages(websiteUrl: string): TargetPage[] | undefined {
  const origin = websiteOrigin(websiteUrl);
  if (!origin) return undefined;
  return [
    { key: "home", fieldName: "website_hash", url: `${origin}/` },
    { key: "services", fieldName: "services_hash", url: `${origin}/services` },
    { key: "financing", fieldName: "financing_hash", url: `${origin}/financing` },
  ];
}

export function homepageUrl(websiteUrl: string): string | undefined {
  const origin = websiteOrigin(websiteUrl);
  return origin ? `${origin}/` : undefined;
}
