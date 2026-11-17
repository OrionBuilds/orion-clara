// contacts/rungs/dbprPhone.ts — mobile-waterfall rung 2: a phone number off the company's Florida
// DBPR contractor-license record, when one exists (→office, same reasoning as placesPhone: a
// license record's address is the business's, not a specific person's cell).
//
// Honest limitation, documented rather than silently guessed around: PR 9's DbprRecord (see
// publicdata/types.ts) carries licenseNumber/licenseType/licenseeName/businessName/status/address —
// NO phone field. DBPR's real bulk extract doesn't appear to carry one either (flDbpr.ts's own doc
// comment flags its column layout as best-effort researched, not confirmed against a live file).
// So this rung, as specified, can never produce a hit against today's data — it's wired into the
// waterfall (in order, tested, with its own enabled/gate/call) so a FUTURE PR that adds a phone
// column to DbprRecord (or layers in a reverse-lookup) only has to fill in `call()` below; nothing
// about the waterfall's shape, order, or stage-90 wiring needs to change. Always a documented miss.

import type { Rung, RungCallResult, RungContext } from "../waterfall";

export function callDbprPhone(_ctx: RungContext): RungCallResult {
  return { hit: false, costUsd: 0, reason: "DBPR records carry no phone field (publicdata/types.ts DbprRecord) — not available yet" };
}

export const dbprPhoneRung: Rung = {
  id: "dbpr_phone",
  enabled: () => true,
  gate: () => true,
  costUnits: 0,
  call: (ctx) => Promise.resolve(callDbprPhone(ctx)),
};
