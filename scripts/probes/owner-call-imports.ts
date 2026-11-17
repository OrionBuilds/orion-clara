// Owner-call persona probe (2026-09-24).
//
// The morning call is placed BY Clara TO the owner. On that call Twilio's `From` is Clara's own
// number, so any code path that resolves the caller from `From` — the inbound voice route, the
// stranger/lead-qualification brain, the business-call brain, telephony.respond() — would hand the owner
// the wrong persona or refuse the owner. The route and library must never import them. This probe reads the
// source and fails if they ever do, the same way persona-audience-boundary.ts guards the other direction.
//
// Run:  npx tsx scripts/probes/owner-call-imports.ts

import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../../src");
const FILES = [
  "app/api/channels/twilio/owner-call/route.ts",
  "app/api/channels/twilio/owner-call/status/route.ts",
  "lib/clara/owner-call.ts",
  "lib/clara/owner-call-sessions.ts",
];
const FORBIDDEN: Array<[RegExp, string]> = [
  [/inbound-call-brain/, "the stranger/lead-qualification brain"],
  [/business-call-brain/, "the business-call brain"],
  [/from\s+["']\.\/telephony["']|from\s+["']@\/lib\/clara\/telephony["']|\brespond\(/, "telephony.respond() (resolves by From)"],
  [/resolveByPhone/, "resolveByPhone (caller identity from From)"],
  [/params\.From\b/, "any use of params.From"],
  [/<Record\b|<Start><Record/, "call recording"],
];

let failed = 0;
for (const rel of FILES) {
  // Comments may NAME the forbidden things (that is how the rule is documented); only code counts.
  const src = readFileSync(path.join(ROOT, rel), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\s\/\/(?![^"'`\n]*["'`]).*$/gm, "");
  for (const [rx, why] of FORBIDDEN) {
    if (rx.test(src)) { failed++; console.error(`FAIL ${rel}: references ${why} (${rx})`); }
  }
}
if (failed) { console.error(`${failed} violation(s)`); process.exit(1); }
console.log(`ok — ${FILES.length} owner-call files import none of the caller-identity or persona paths`);
