// Clara — principal (person-with-authority) resolution.
//
// Maps an inbound phone/email to the owner or neither. Clara is an executive assistant only, so
// only the owner resolves — every other caller
// falls through to the business persona.

import { loadConfig } from "./config";
import type { Principal, PrincipalId } from "./types";
import { OWNER_FIRST } from "./owner";
import { ownerPhones, samePhone } from "./ownerPhones";

// Compare complete normalized numbers (ownerPhones.samePhone). Twilio sends E.164 today, but a stray
// space or a number stored as (555) 010-0000 must still recognize the owner — while a different
// country code with the same last ten digits must not.
function matchesAny(list: string[], e164: string): boolean {
  return list.some((p) => samePhone(p, e164));
}

export async function resolveByPhone(e164: string): Promise<Principal | null> {
  // Work and personal cells both identify the owner (ownerPhones.ts), alongside the configured number.
  if (matchesAny(await ownerPhones(), e164)) return principal("owner");
  return null;
}

export async function resolveByEmail(email: string): Promise<Principal | null> {
  const cfg = await loadConfig();
  const e = email.toLowerCase();
  if (cfg.principals.owner.emails.map((s) => s.toLowerCase()).includes(e)) return principal("owner");
  return null;
}

function principal(id: PrincipalId): Principal {
  return {
    id,
    displayName: OWNER_FIRST,
    phones: [],
    emails: [],
    authority: id,
  };
}
