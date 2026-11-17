// contacts/rungs/placesPhone.ts — mobile-waterfall rung 1: the company's own main line, as
// discovery (Google Places) already captured it on the company row. Not a lookup at all — just
// promotes `companies.phone` into a contact_methods "phone" row (kind=phone, NOT mobile: this is
// the business's office line, never a specific person's cell) — hence the plan's "→office"
// annotation on this rung. Free, no provider call, always tried first so the paid leadmagic_mobile
// rung is only reached when nothing free panned out.

import type { Rung, RungCallResult, RungContext } from "../waterfall";

export function callPlacesPhone(ctx: RungContext): RungCallResult {
  if (!ctx.officePhone) return { hit: false, costUsd: 0, reason: "no office phone on the company row" };
  return {
    hit: true,
    kind: "phone",
    value: ctx.officePhone,
    provider: "places",
    confidence: 0.9,
    verificationStatus: "unknown",
    costUsd: 0,
  };
}

export const placesPhoneRung: Rung = {
  id: "places_phone",
  enabled: () => true,
  gate: () => true,
  costUnits: 0,
  call: (ctx) => Promise.resolve(callPlacesPhone(ctx)),
};
