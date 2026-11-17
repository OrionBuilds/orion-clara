// tech/signatures.ts — the HTML/script signature table tech/detect.ts scans a company's crawled
// homepage against. Pure data + pure matcher functions, no I/O (matches entity/normalize.ts's own
// "pure string munging" convention) — detect.ts owns reading evidence off disk and writing results.
//
// Category mapping notes (company_technologies_upsert's `category` enum has no "reviews"/
// "reputation"/"field_tools" bucket, so a few of the brief's groupings fold into the closest fit):
//   - reviews/reputation tools (Podium, Birdeye)              -> "other"
//   - field/production tools (Roofr, Hover, CompanyCam)       -> "other"
//   - call tracking (CallRail)                                -> "phone" (the enum's closest fit;
//     detect.ts still writes the FACT under field_name "call_tracking", the OS's actual
//     signal-emitting field name for this — see detect.ts's FIELD_NAME_BY_CATEGORY doc comment)
//   - Local Services Ads badge embeds                         -> "ads" (best-effort: LSA badges are
//     not a single universal script domain the way Meta Pixel/GTM are, so this signature is a loose
//     pattern match on the badge's known embed host, not a guarantee)
//   - AccuLynx                                                -> "crm" (best-effort: AccuLynx has no
//     single universal public embed/script domain the way GoHighLevel/HubSpot do; this signature
//     just looks for the literal word "acculynx" in scripts or markup, which is weaker evidence than
//     the others in this table and more prone to a false negative, never a meaningful false positive)
//
// financing signatures intentionally carry BOTH a script-domain pattern and a plain-text brand-name
// pattern per signature (checked against the same `html` string) — these often show up as a widget
// embed on some sites and a plain financing-page paragraph on others, per the brief.

export type TechCategory =
  | "crm" | "website_builder" | "ads" | "chat" | "booking" | "phone" | "ai_receptionist"
  | "financing" | "analytics" | "payments" | "email_platform" | "other";

export type TechDetectedVia = "script" | "dns" | "html" | "cookie" | "header" | "job_post" | "provider" | "manual";

export interface TechSignature {
  category: TechCategory;
  name: string;
  vendor?: string;
  detectedVia: TechDetectedVia;
  /** Substrings checked (case-insensitive) against each entry of the scripts list (script `src`
   *  attribute values pulled off the page's raw HTML — see detect.ts's extractScriptSrcs). */
  scriptPatterns?: readonly string[];
  /** Substrings checked (case-insensitive) against the full raw page HTML — covers both markup
   *  hooks (e.g. "wp-content") and plain-text brand mentions (e.g. a financing partner's name). */
  htmlPatterns?: readonly string[];
  /** True when this signature is a loose/best-effort pattern match rather than a known, stable,
   *  vendor-documented embed signature — surfaced so a caller can lower confidence accordingly. */
  bestEffort?: boolean;
  match: (html: string, scripts: string[]) => boolean;
}

function containsAny(haystack: string, needles: readonly string[]): boolean {
  if (!needles.length) return false;
  const h = haystack.toLowerCase();
  return needles.some((n) => h.includes(n.toLowerCase()));
}

function makeMatch(scriptPatterns: readonly string[] = [], htmlPatterns: readonly string[] = []): TechSignature["match"] {
  return (html, scripts) => {
    if (scriptPatterns.length && scripts.some((s) => containsAny(s, scriptPatterns))) return true;
    if (htmlPatterns.length && containsAny(html, htmlPatterns)) return true;
    return false;
  };
}

function sig(
  partial: Omit<TechSignature, "match">,
): TechSignature {
  return { ...partial, match: makeMatch(partial.scriptPatterns, partial.htmlPatterns) };
}

const GOOGLE_ADS_CONVERSION_ID_RE = /\baw-\d{6,}\b/i;

export const SIGNATURES: readonly TechSignature[] = [
  // ── website_builder ──────────────────────────────────────────────────────────────────────
  sig({
    category: "website_builder", name: "WordPress", detectedVia: "html",
    htmlPatterns: ["wp-content", "wp-includes", "/wp-json/"],
  }),
  sig({
    category: "website_builder", name: "Wix", detectedVia: "html",
    scriptPatterns: ["wix.com", "wixstatic.com"],
    htmlPatterns: ["wix.com", "wixstatic.com", "_wixcsspreloaded"],
  }),
  sig({
    category: "website_builder", name: "Squarespace", detectedVia: "html",
    scriptPatterns: ["squarespace.com", "static1.squarespace.com"],
    htmlPatterns: ["squarespace.com", "static1.squarespace.com"],
  }),

  // ── crm ───────────────────────────────────────────────────────────────────────────────────
  sig({
    category: "crm", name: "GoHighLevel", detectedVia: "script",
    scriptPatterns: ["leadconnectorhq.com", "msgsndr.com"],
    htmlPatterns: ["leadconnectorhq.com", "msgsndr"],
  }),
  sig({
    category: "crm", name: "HubSpot", detectedVia: "script",
    scriptPatterns: ["js.hs-scripts.com", "js.hsforms.net"],
  }),
  sig({
    category: "crm", name: "JobNimbus", detectedVia: "script",
    scriptPatterns: ["cdn.jobnimbus.com"],
  }),
  sig({
    category: "crm", name: "AccuLynx", detectedVia: "script", bestEffort: true,
    scriptPatterns: ["acculynx"], htmlPatterns: ["acculynx"],
  }),
  sig({
    category: "crm", name: "ServiceTitan", detectedVia: "script",
    scriptPatterns: ["servicetitan"], htmlPatterns: ["servicetitan"],
  }),

  // ── chat ──────────────────────────────────────────────────────────────────────────────────
  sig({ category: "chat", name: "Intercom", detectedVia: "script", scriptPatterns: ["widget.intercom.io"] }),
  sig({ category: "chat", name: "Tidio", detectedVia: "script", scriptPatterns: ["code.tidio.co"] }),
  sig({ category: "chat", name: "Drift", detectedVia: "script", scriptPatterns: ["js.driftt.com"] }),
  sig({ category: "chat", name: "Hatch", detectedVia: "script", scriptPatterns: ["hatch.co", "gethatch"], htmlPatterns: ["gethatch"] }),

  // ── booking ───────────────────────────────────────────────────────────────────────────────
  sig({
    category: "booking", name: "Calendly", detectedVia: "script",
    scriptPatterns: ["calendly.com"], htmlPatterns: ["calendly.com"],
  }),
  sig({
    category: "booking", name: "Housecall Pro", detectedVia: "script",
    scriptPatterns: ["housecallpro.com", "bookinglink"], htmlPatterns: ["housecallpro.com", "bookinglink"],
  }),

  // ── phone / call tracking ────────────────────────────────────────────────────────────────
  sig({ category: "phone", name: "CallRail", detectedVia: "script", scriptPatterns: ["cdn.callrail.com"] }),

  // ── ads / analytics ───────────────────────────────────────────────────────────────────────
  sig({ category: "ads", name: "Meta Pixel", vendor: "Meta", detectedVia: "script", scriptPatterns: ["connect.facebook.net", "fbevents.js"] }),
  // Google Ads' conversion-id pattern ("AW-123456789") needs a real regex, not a bare substring —
  // a plain "aw-" substring match would be far too noisy (many unrelated CSS/JS tokens contain it).
  {
    category: "ads", name: "Google Ads", vendor: "Google", detectedVia: "html",
    match: (html, scripts) => GOOGLE_ADS_CONVERSION_ID_RE.test(html) || scripts.some((s) => GOOGLE_ADS_CONVERSION_ID_RE.test(s)),
  },
  sig({
    category: "analytics", name: "Google Analytics / GTM", vendor: "Google", detectedVia: "script",
    scriptPatterns: ["googletagmanager.com"], htmlPatterns: ["gtag(", "ga("],
  }),
  sig({
    category: "ads", name: "Google Local Services Ads", vendor: "Google", detectedVia: "html", bestEffort: true,
    htmlPatterns: ["google.com/local-services", "localservicesads"],
  }),

  // ── reviews / reputation (folded into "other" — see module doc comment) ────────────────────
  sig({ category: "other", name: "Podium", detectedVia: "script", scriptPatterns: ["podium.com"] }),
  sig({ category: "other", name: "Birdeye", detectedVia: "script", scriptPatterns: ["birdeye.com"] }),

  // ── field/production tools (folded into "other" — see module doc comment) ──────────────────
  sig({ category: "other", name: "Roofr", detectedVia: "script", scriptPatterns: ["roofr.com"], htmlPatterns: ["roofr.com"] }),
  sig({ category: "other", name: "Hover", detectedVia: "script", scriptPatterns: ["hover.to"], htmlPatterns: ["hover.to"] }),
  sig({ category: "other", name: "CompanyCam", detectedVia: "script", scriptPatterns: ["companycam.com"], htmlPatterns: ["companycam.com"] }),

  // ── payments ──────────────────────────────────────────────────────────────────────────────
  sig({ category: "payments", name: "Stripe", detectedVia: "script", scriptPatterns: ["js.stripe.com"] }),

  // ── financing (script-domain OR plain-text brand mention, per signature) ───────────────────
  sig({ category: "financing", name: "GreenSky", detectedVia: "script", scriptPatterns: ["greensky.com", "mygreensky.com"], htmlPatterns: ["greensky"] }),
  sig({ category: "financing", name: "Service Finance", detectedVia: "script", scriptPatterns: ["servicefinance.com"], htmlPatterns: ["service finance"] }),
  sig({ category: "financing", name: "Hearth", detectedVia: "script", scriptPatterns: ["gethearth.com", "hearth.com"], htmlPatterns: ["hearth"] }),
  sig({ category: "financing", name: "Wisetack", detectedVia: "script", scriptPatterns: ["wisetack.com"], htmlPatterns: ["wisetack"] }),
  sig({ category: "financing", name: "Sunlight Financial", detectedVia: "script", scriptPatterns: ["sunlightfinancial.com"], htmlPatterns: ["sunlight financial"] }),
  sig({ category: "financing", name: "Acorn Finance", detectedVia: "script", scriptPatterns: ["acornfinance.com"], htmlPatterns: ["acorn finance"] }),
];
