// contacts/rungs/index.ts — the two ordered rung lists stages.ts's find_email/find_phone handlers
// hand to contacts/waterfall.ts's runWaterfall. Order IS the waterfall order (plan: email
// "[site_mailto, hunter_pattern(≥2 confirmations), leadmagic, hunter_finder, apollo_match]", mobile
// "[places_phone→office, dbpr_phone→office, site_tel, leadmagic_mobile]") — changing either array's
// order changes the waterfall's behavior, so it lives in exactly one place.

import { siteMailtoRung } from "./siteMailto";
import { hunterPatternRung } from "./hunterPattern";
import { leadmagicEmailRung } from "./leadmagic";
import { hunterFinderRung } from "./hunterFinder";
import { apolloRung } from "./apollo";
import { placesPhoneRung } from "./placesPhone";
import { dbprPhoneRung } from "./dbprPhone";
import { siteTelRung } from "./siteTel";
import { leadmagicMobileRung } from "./leadmagicMobile";
import { runWaterfall, type Rung, type RungContext, type WaterfallResult } from "../waterfall";

export const EMAIL_RUNGS: readonly Rung[] = [siteMailtoRung, hunterPatternRung, leadmagicEmailRung, hunterFinderRung, apolloRung];
export const MOBILE_RUNGS: readonly Rung[] = [placesPhoneRung, dbprPhoneRung, siteTelRung, leadmagicMobileRung];

/** stages.ts's find_email (85) handler's single collaborator — kept as one function (rather than
 *  injecting runWaterfall + EMAIL_RUNGS separately into StageDeps) so the email rung ORDER is never
 *  something a stages.ts test can accidentally override; only the rungs' own `call()` behavior is
 *  swapped out in tests (see contacts/waterfall.test.ts for order coverage with fakes). */
export function runEmailWaterfall(ctx: RungContext): Promise<WaterfallResult> {
  return runWaterfall(EMAIL_RUNGS, ctx);
}
/** Same for find_phone (90) — see runEmailWaterfall's doc comment. */
export function runMobileWaterfall(ctx: RungContext): Promise<WaterfallResult> {
  return runWaterfall(MOBILE_RUNGS, ctx);
}

export {
  siteMailtoRung, hunterPatternRung, leadmagicEmailRung, hunterFinderRung, apolloRung,
  placesPhoneRung, dbprPhoneRung, siteTelRung, leadmagicMobileRung,
};
