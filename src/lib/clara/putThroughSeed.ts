// Clara — the owner's always-put-through list, hardcoded (2026-10-01 owner decision).
//
// Ships with every deploy so a fresh environment has the list from the first call, before any
// owner command has run. putThrough.ts merges this with CLARA_PUT_THROUGH and the runtime JSON
// file; a stored entry overrides a seeded one by name or by number (putThrough.withOverrides), so
// the owner can still edit this list in plain English without a redeploy.
//
// Two tiers:
//   "transfer"     (default) — today's text-accept warm transfer when the owner is free; when they're in
//                   a busy calendar event, Clara declines with calendar-aware reasoning and takes
//                   a message instead (workLine.ts/calendar.ts).
//   "message_only" — never rings the owner. Clara greets them by name and takes a message every time.
//
// Every entry below is fictional (555-01xx numbers) — replace them with your own VIPs, or empty the
// array and manage the list with owner commands / CLARA_PUT_THROUGH instead. Morgan Vendor calls
// from two numbers — both rows carry the same name so either one matches.

import type { PutThroughEntry } from "./putThrough";

export const PUT_THROUGH_SEED: PutThroughEntry[] = [
  { name: "Taylor Client (Acme Co)", phone: "+15550100101", tier: "transfer" },
  { name: "Riley Partner (Acme Co)", phone: "+15550100102", tier: "transfer" },
  { name: "Morgan Vendor (Globex)", phone: "+15550100103", tier: "transfer" },
  { name: "Morgan Vendor (Globex)", phone: "+15550100104", tier: "transfer" },
  { name: "Casey Contractor (Initech)", phone: "+15550100105", tier: "message_only" },
];
