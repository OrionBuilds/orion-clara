// Outreach branding — the business identity and links prospecting copy uses. All of it comes from the
// owner profile (business.name / business.domain) or env, never from source, so a fresh clone sends
// nothing that names a real company.

import { BUSINESS_NAME, BUSINESS_DOMAIN, OWNER_NAME } from "../owner";

export { BUSINESS_NAME, OWNER_NAME };

/** One-line description of what the business offers, used in outreach and qualification prompts. */
export const BUSINESS_PITCH = (process.env.CLARA_BUSINESS_PITCH ?? "").trim()
  || "AI lead response, workflow automation, and marketing systems for local service businesses";

/** Where prospects book a call. */
export const BOOKING_URL = (process.env.CLARA_BOOKING_URL ?? "").trim() || `https://${BUSINESS_DOMAIN}/schedule`;

/** Info page linked from the crawler's User-Agent string. */
export const BOT_INFO_URL = (process.env.CLARA_BOT_INFO_URL ?? "").trim() || `https://${BUSINESS_DOMAIN}/bot`;
