// Owner identity — resolved from the git-ignored owner profile (~/.agentic-os/owner-profile.json,
// or ORION_OWNER_PROFILE), never hardcoded in source (master plan §3.2 / PR 0.10). With no profile
// present, agent-core supplies a clearly-fake default so a fresh clone runs without leaking anyone.
//
// SERVER-ONLY: reads the filesystem at module load. Client components must fetch /api/owner instead.

import { getOwnerProfile, ownerFirstName, ownerPersonalEmail } from "@autom8ionlab/agent-core";

const profile = getOwnerProfile();

export const OWNER_PROFILE = profile;
/** Full display name, e.g. what outbound calls/emails sign as. */
export const OWNER_NAME = profile.identity.name;
/** First name for informal address in prompts and UI. */
export const OWNER_FIRST = ownerFirstName(profile);
/** The owner's work email (lowercased). */
export const OWNER_WORK_EMAIL = profile.identity.workEmail.toLowerCase();
/** The excluded personal Gmail — the address Clara must refuse credentials for. */
export const OWNER_PERSONAL_GMAIL = ownerPersonalEmail(profile);
/** Local-part of the excluded personal Gmail (used by the persona-boundary probe). */
export const OWNER_PERSONAL_LOCALPART = OWNER_PERSONAL_GMAIL.split("@")[0] ?? "";
/** The owner's cell in E.164 (principal recognition fixtures; live matching uses config/env). */
export const OWNER_PHONE = profile.identity.phone ?? "";

export const BUSINESS_NAME = profile.business?.name ?? "the business";
export const BUSINESS_DOMAIN = profile.business?.domain ?? "example.com";
export const BUSINESS_INFO_EMAIL = profile.business?.infoEmail ?? `info@${BUSINESS_DOMAIN}`;

/** Drive ids (source no longer carries real ids as defaults). */
export const OWNER_DRIVES = profile.drives ?? {};
