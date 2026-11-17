// Inbound-call guard probe — the ceilings that make a published phone number safe.
//
// Clara's business number is published on the public site, so the default caller is a stranger and the two things
// standing between "a lead call" and "an open invoice" are the turn ceiling and caller recognition.
// Both are the kind of control that reads as present in the source and silently doesn't fire, which
// is the failure this estate keeps producing — so they get checked.
//
// Deliberately makes NO model calls and triggers NO notifications: every assertion below exercises
// a path that short-circuits before llmTurn(), so running this costs nothing and never texts the owner.
//
// Run:  npx tsx scripts/probes/inbound-call-guards.ts

// The owner's real number comes from the git-ignored owner profile; a clone without one probes
// against a fake number, which exercises exactly the same normalization paths.
import { getOwnerProfile } from "@autom8ionlab/agent-core";
const OWNER_PHONE = getOwnerProfile().identity.phone || "+15550012712";
const D10 = OWNER_PHONE.replace(/\D/g, "").slice(-10);
process.env.OWNER_PHONE = OWNER_PHONE;

let failures = 0;
function fail(msg: string): void {
  failures++;
  console.error(`  FAIL  ${msg}`);
}

async function main(): Promise<void> {
  const { nextInboundTurn, MAX_TURNS } = await import("../../src/lib/clara/inbound-call-brain");
  const { resolveByPhone } = await import("../../src/lib/clara/principals");
  const type = await import("../../src/lib/clara/call-sessions");
  void type;

  // ── Caller recognition survives formatting ───────────────────────────────────────────────────
  console.log("\nCaller recognition normalizes formatting");
  {
    const before = failures;
    // resolveByPhone used to be an exact string .includes(). Every one of these is the same human,
    // and a miss now costs more than awkwardness: an unrecognized owner gets the BUSINESS persona.
    const ownerForms = [
      `+1${D10}`, `1${D10}`, D10,
      `(${D10.slice(0, 3)}) ${D10.slice(3, 6)}-${D10.slice(6)}`,
      `${D10.slice(0, 3)}-${D10.slice(3, 6)}-${D10.slice(6)}`,
      `+1 ${D10.slice(0, 3)} ${D10.slice(3, 6)} ${D10.slice(6)}`,
    ];
    for (const form of ownerForms) {
      const p = await resolveByPhone(form);
      if (p?.id !== "owner") fail(`resolveByPhone("${form}") gave ${p?.id ?? "null"}, expected owner`);
    }
    // And it must not over-match: a different number that merely shares a suffix length is not the owner.
    const offByOne = `+1${D10.slice(0, 9)}${(Number(D10[9]) + 1) % 10}`;
    for (const stranger of ["+14045551212", offByOne, "", "not-a-phone", D10.slice(-4)]) {
      const p = await resolveByPhone(stranger);
      if (p !== null) fail(`resolveByPhone("${stranger}") matched ${p.id} — should be a stranger`);
    }
    if (failures === before) console.log(`  ok    ${ownerForms.length} formats recognized, 5 non-matches rejected`);
  }

  // ── Turn ceiling ─────────────────────────────────────────────────────────────────────────────
  console.log("\nTurn ceiling ends the call");
  {
    const before = failures;
    const mkState = (callerTurns: number) => ({
      callSid: "CAprobe",
      fromE164: "+14045551212",
      turns: Array.from({ length: callerTurns }, (_, i) => ({
        role: "caller" as const, text: `turn ${i}`, at: new Date().toISOString(),
      })),
      learned: {},
      status: "in-progress" as const,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // One under the cap must NOT hang up on the count alone. This would reach the model, so it is
    // asserted structurally instead: MAX_TURNS is the boundary the route relies on.
    if (MAX_TURNS < 4) fail(`MAX_TURNS is ${MAX_TURNS} — too low to qualify anyone`);
    if (MAX_TURNS > 30) fail(`MAX_TURNS is ${MAX_TURNS} — high enough to be a cost problem`);

    // Over the cap short-circuits before any model call.
    const over = await nextInboundTurn(mkState(MAX_TURNS), "and another thing");
    if (!over.hangup) fail(`turn ${MAX_TURNS + 1} did not hang up — the ceiling does not fire`);
    if (!over.wantsHuman) fail("a capped call must hand off to a human, not just end");
    if (!over.sayText?.trim()) fail("capped call hung up without saying anything");

    const wayOver = await nextInboundTurn(mkState(MAX_TURNS + 50), "still talking");
    if (!wayOver.hangup) fail("a call far past the ceiling still did not hang up");

    if (failures === before) console.log(`  ok    ceiling ${MAX_TURNS} fires, hands off to a human, and speaks a closing line`);
  }

  console.log(
    failures === 0
      ? "\nPASS — inbound guards hold.\n"
      : `\nFAIL — ${failures} problem(s). The published line is not safe.\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("probe crashed:", e);
  process.exit(1);
});

// Marks this file as a module. Without it TypeScript treats these probes as global
// scripts sharing one scope, and two of them declaring `failures` breaks the whole build.
export {};
