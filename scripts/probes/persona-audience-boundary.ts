// Audience boundary probe — the enforcement behind the persona split (2026-08-03).
//
// CLARA_IDENTITY is the principal persona: it names the owner's personal Gmail, gives FRIDAY's
// internal address, and describes Clara's tier/approval model. Until this split it
// was prepended for EVERY caller and texter, with CLARA_CRM_CUSTOMER_LENS bolted on after — a lens
// that only adds prohibitions and removes nothing. Now the business number is published on
// the public site and the default caller is a stranger.
//
// Everything in persona.ts is a convention until something checks it. This is that something.
// It composes the REAL prompts through the REAL functions (identityFor, systemFor) rather than
// re-deriving the strings, so it fails if a call site starts concatenating the principal identity
// back in — which is the mistake that would actually happen.
//
// Run:  npx tsx scripts/probes/persona-audience-boundary.ts

import {
  CLARA_IDENTITY,
  CLARA_BUSINESS_IDENTITY,
  CLARA_WORKLINE_IDENTITY,
  identityFor,
} from "../../src/lib/clara/persona";
import { systemFor } from "../../src/lib/clara/telephony";
import { workLinePrompt } from "../../src/lib/clara/inbound-call-brain";
import { OWNER_FIRST, OWNER_PERSONAL_LOCALPART, BUSINESS_NAME } from "../../src/lib/clara/owner";

// Substrings that must never reach a non-principal. Chosen to be precise, because the business
// identity legitimately says "personal lives, families, homes" in the course of refusing to discuss
// them — a sloppy denylist that flags its own guardrail gets deleted.
const FORBIDDEN: Array<[string, string]> = [
  [OWNER_PERSONAL_LOCALPART, "the owner's personal email local-part"],
  ["gmail", "any Gmail reference"],
  ["127.0.0.1", "an internal host address"],
  ["3737", "FRIDAY's port"],
  ["tier table", "Clara's internal authority model"],
  ["back office", "internal architecture"],
  // The JARVIS register (2026-08-03). The owner asked for snark WITH THEM. A prospect who gets ribbed by
  // the company's AI on first contact doesn't become a client, and a contracting officer reading a
  // capability statement certainly doesn't. These are the words that carry that register.
  ["snark", "the teasing register"],
  ["tease", "the teasing register"],
  ["insubordinate", "the teasing register"],
  ["deadpan", "the teasing register"],
  ["tony stark", "the JARVIS framing"],
  ["jarvis", "the JARVIS framing"],
];

// Properties the business identity must KEEP. Without these the probe would still pass if someone
// replaced CLARA_BUSINESS_IDENTITY with an empty string — leak-free and useless.
const REQUIRED: Array<[string, string]> = [
  [BUSINESS_NAME, "names the company she represents"],
  ["AI assistant", "discloses she is not human"],
  ["Never ask for payment details", "refuses payment/credential collection"],
  ["never speculate", "refuses to guess about people's private lives"],
];

let failures = 0;
function fail(msg: string): void {
  failures++;
  console.error(`  FAIL  ${msg}`);
}
function check(label: string, fn: () => void): void {
  console.log(`\n${label}`);
  fn();
}

// The composed prompts a stranger actually receives, built the way production builds them.
const businessSurfaces: Array<[string, string]> = [
  ["identityFor('business')", identityFor("business")],
  // The owner's work phone (2026-09-29): the owner's clients, not strangers — but still not the principal persona.
  ["identityFor('workline')", identityFor("workline")],
  ["voice: workLinePrompt(client)", workLinePrompt({
    callSid: "CA0", fromE164: "+15550001111", turns: [], learned: {}, status: "in-progress", startedAt: "", updatedAt: "",
    line: "work", profile: { kind: "client", name: "Taylor", company: "Acme Co" },
  }, "")],
  ["voice: systemFor('inbound-to-clara', stranger)", systemFor("inbound-to-clara", "unknown caller (+15550001111)", false)],
  ["voice: systemFor('screen-for-owner', stranger)", systemFor("screen-for-owner", "unknown caller (+15550001111)", false)],
];

check("Business surfaces leak nothing personal", () => {
  for (const [name, prompt] of businessSurfaces) {
    const hay = prompt.toLowerCase();
    for (const [needle, why] of FORBIDDEN) {
      // An owner profile without a personal address yields an empty local-part, which every string
      // "contains" — nothing to check for, not a leak.
      if (!needle) continue;
      if (hay.includes(needle.toLowerCase())) fail(`${name} contains "${needle}" — ${why}`);
    }
  }
  if (!failures) console.log(`  ok    ${businessSurfaces.length} surfaces clean against ${FORBIDDEN.length} forbidden terms`);
});

check("Business identity keeps its guardrails", () => {
  const before = failures;
  for (const [needle, why] of REQUIRED) {
    if (!CLARA_BUSINESS_IDENTITY.includes(needle)) fail(`business identity lost "${needle}" — no longer ${why}`);
  }
  if (failures === before) console.log(`  ok    ${REQUIRED.length} required guardrails present`);
});

check("The three identities are separate, not derived", () => {
  const before = failures;
  // Catches the specific regression this split exists to prevent: someone "fixing" a gap by
  // concatenating the principal persona onto the business one — or either onto the work line's.
  const ids: Array<[string, string]> = [["principal", CLARA_IDENTITY], ["business", CLARA_BUSINESS_IDENTITY], ["work line", CLARA_WORKLINE_IDENTITY]];
  for (const [a, ta] of ids) for (const [b, tb] of ids) if (a !== b && ta.includes(tb)) fail(`${a} identity embeds the ${b} identity`);
  if (identityFor("principal") !== CLARA_IDENTITY) fail("identityFor('principal') is not the principal identity");
  if (identityFor("business") !== CLARA_BUSINESS_IDENTITY) fail("identityFor('business') is not the business identity");
  if (identityFor("workline") !== CLARA_WORKLINE_IDENTITY) fail("identityFor('workline') is not the work-line identity");
  if (failures === before) console.log("  ok    identities are distinct and selected, not composed");
});

check("The work line is the owner's assistant, not the front desk", () => {
  const before = failures;
  // The wording that made the work-line prompt contradict itself until 2026-09-29.
  for (const needle of ["main line", "Thanks for calling", "a team member will follow up", "ways to reach the company"]) {
    if (CLARA_WORKLINE_IDENTITY.toLowerCase().includes(needle.toLowerCase())) fail(`work-line identity still says "${needle}"`);
  }
  for (const needle of ["work phone", "AI assistant", "never as", "Never ask for payment details"]) {
    if (!CLARA_WORKLINE_IDENTITY.includes(needle)) fail(`work-line identity lost "${needle}"`);
  }
  if (failures === before) console.log("  ok    work-line identity is the assistant's own");
});

check("Principals still get the full principal persona", () => {
  const before = failures;
  // Over-redaction is a failure too: if the owner's own assistant loses its private context, the split
  // broke the thing it was protecting.
  const ownerVoice = systemFor("inbound-to-clara", OWNER_FIRST, true);
  // "tease" included: the register the owner explicitly asked for has to actually reach them. A probe
  // that only checks for absence would happily pass a persona that had been stripped of it.
  for (const needle of [OWNER_PERSONAL_LOCALPART, "127.0.0.1", "tease"]) {
    if (!ownerVoice.toLowerCase().includes(needle.toLowerCase())) {
      fail(`the owner's own voice prompt lost "${needle}" — principal context was over-redacted`);
    }
  }
  if (failures === before) console.log("  ok    principal path unchanged");
});

console.log(
  failures === 0
    ? "\nPASS — audience boundary holds.\n"
    : `\nFAIL — ${failures} problem(s). A stranger can reach personal context.\n`,
);
process.exit(failures === 0 ? 0 : 1);
