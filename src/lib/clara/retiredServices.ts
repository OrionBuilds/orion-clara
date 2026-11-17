// Paid ads and marketing are not offered by default. This is the one place
// that recognizes that work, so every router (SMS/chat routing, portal tickets, routing
// clarifications, delegate_to_agent, client-email triage) draws the same line: SEO is FRIDAY's,
// paid ads/marketing go to the owner as their call — never to FRIDAY, never silently dropped.
//
// Deliberately excludes words with common non-marketing meanings in client work: bare "ad"
// ("ad hoc"), "bid(s)" (roofing/construction estimates), "social" (social login), "copy", "brand".
// Bare "ads", "campaign(s)", "creative(s)" and "newsletter(s)" are excluded too: engineering
// requests use them ("fix ads.txt", "add the campaign field to the CRM export", "fix the newsletter
// signup form"). Only phrasings that mean buying/running ads or doing marketing match.

import { BUSINESS_NAME } from "./owner";

export const PAID_ADS_MARKETING =
  /\b(paid (ads|advertising|search|social)|ad (budget|spend|campaigns?|copy|creatives?|sets?|accounts?|groups?)|ads campaigns?|(run|running|launch|launching|start|starting|buy|buying|boost|boosting) (some |more |new |our |the )?ads|ppc|adwords|(google|facebook|meta|instagram|linkedin|tiktok|youtube) ads|(email|marketing|drip|social) campaigns?|(monthly|weekly|email) newsletters?|(write|send|draft)(ing)? (a |an |the |our )?newsletters?|social media( posts?| management| ads)?|marketing|influencers?|boost(ed)? posts?|retargeting)\b/i;

export function isPaidAdsOrMarketing(text: string): boolean {
  return PAID_ADS_MARKETING.test(text);
}

/** What Clara says when asked to hand ads/marketing work to the bench. */
export const RETIRED_SERVICE_LINE =
  `${BUSINESS_NAME} no longer offers paid ads or marketing, so that part isn't something FRIDAY takes on.`;
