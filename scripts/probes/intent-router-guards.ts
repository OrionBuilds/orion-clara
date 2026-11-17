// Intent-router guard probe.
//
// This exists because of one text message. The owner asked Clara to clean their inbox; the keyword regex
// didn't match their phrasing; the request fell through to a conversational model; and the model
// replied "Inbox swept; junk archived and labeled. All clear." having swept nothing. The ledger
// shows zero action rows between the owner's message and that reply.
//
// The router's job is to make that sentence impossible. These assertions are the parts of that
// guarantee that can be checked without spending money or touching the mailbox — no model calls,
// no Gmail calls, no notifications.
//
// Run:  npx tsx scripts/probes/intent-router-guards.ts

let failures = 0;
function fail(msg: string): void {
  failures++;
  console.error(`  FAIL  ${msg}`);
}

async function main(): Promise<void> {
  const { TOOLS, claimsCompletion } = await import("../../src/lib/clara/intent");
  const { tierTable } = await import("../../src/lib/clara/tiers");

  // ── The completion-claim guard ───────────────────────────────────────────────────────────────
  console.log("\nCompletion-claim detection");
  {
    const before = failures;

    // The actual sentence that shipped, plus the shapes nearest to it.
    const mustCatch = [
      "Inbox swept; junk archived and labeled. All clear.",
      "Done — I've archived the junk.",
      "I cleaned up your inbox.",
      "Sorted your email, all set.",
      "I moved your 3pm to Thursday.",
      "Sent that email for you.",
      "I've restarted FRIDAY.",
      "Booked it.",
    ];
    for (const t of mustCatch) {
      if (!claimsCompletion(t)) fail(`did NOT catch a false completion: "${t}"`);
    }

    // Offers and questions are not claims. Flagging these would make her unable to offer to help,
    // which is a different kind of broken.
    const mustAllow = [
      "Want me to clean up your inbox?",
      "I can archive those if you like.",
      "Shall I move it to Thursday?",
      "I'll sweep it now.",
      "Should I send that?",
      "Your 3pm has four attendees.",
      "There are 42 unread.",
    ];
    for (const t of mustAllow) {
      if (claimsCompletion(t)) fail(`false positive on an offer/question: "${t}"`);
    }

    if (failures === before) console.log(`  ok    ${mustCatch.length} claims caught, ${mustAllow.length} offers allowed`);
  }

  // ── Every tool is governed ───────────────────────────────────────────────────────────────────
  console.log("\nEvery tool is tier-governed and classified");
  {
    const before = failures;
    const categories = new Set(tierTable().map((r) => r.category));

    for (const t of TOOLS) {
      if (!t.name || !t.description) fail(`tool with no name/description: ${t.name}`);
      // A tool whose category isn't in the tier table would sail past can() with "unknown
      // category" — which fails closed today, but silently, and the next person to widen the
      // table would never know this tool was waiting.
      if (!categories.has(t.category)) fail(`${t.name}: category "${t.category}" is not in the tier table`);
      if (typeof t.reversible !== "boolean") fail(`${t.name}: no reversible flag — cannot decide act-vs-confirm`);
      if (typeof t.run !== "function") fail(`${t.name}: no run handler`);
      if (typeof t.describe !== "function") fail(`${t.name}: no describe — its approval card would be blank`);
    }
    if (failures === before) console.log(`  ok    ${TOOLS.length} tools, all with a tier category and a reversibility call`);
  }

  // ── Outbound things are not marked reversible ────────────────────────────────────────────────
  console.log("\nOutbound/irreversible tools require confirmation");
  {
    const before = failures;
    // These reach other people. Moving a meeting emails every attendee; unsubscribing POSTs to the
    // sender or emails them, which also confirms the address is live. None of it has an undo.
    const mustConfirm = [
      "move_event", "cancel_event", "book_event", "unsubscribe_from",
      // book_appointment is a commitment to a client and the OS notifies them.
      //
      // close_deal is NOT here because CLARA does not have it: the opportunities write tools live
      // in FRIDAY's allowlist, since he owns deal progression. She reads the pipeline and he moves
      // it. Trying to give her a close_deal tool just produced "not in this agent's allow-list" at
      // runtime — correctly, and she reported the failure rather than inventing a closed deal.
      "book_appointment",
    ];
    for (const name of mustConfirm) {
      const t = TOOLS.find((x) => x.name === name);
      if (!t) { fail(`expected a "${name}" tool and found none`); continue; }
      if (t.reversible) fail(`${name} is marked reversible — it would execute without asking, and it emails attendees`);
    }

    // And the read-only ones must NOT be gated, or every question becomes an approval and the
    // whole thing is unusable.
    for (const name of ["list_calendar", "agent_status", "crm_lookup", "list_subscriptions", "find_email", "list_blocked"]) {
      const t = TOOLS.find((x) => x.name === name);
      if (!t) { fail(`expected a "${name}" tool and found none`); continue; }
      if (!t.reversible) fail(`${name} is a read — gating it would make her ask permission to answer a question`);
    }
    if (failures === before) console.log("  ok    writes that reach people confirm; reads don't");
  }

  // ── draft_email can only ever draft ──────────────────────────────────────────────────────────
  //
  // This one needs its own check because it is deliberately `reversible: true`, so the blanket
  // "outbound things must confirm" assertion above cannot cover it. The reasoning is sound — what
  // the tool DOES is create a pending approval, and marking it irreversible would make the router
  // wrap it in a second approval, so the owner would confirm twice to send one email. But it means the
  // only thing standing between "draft this" and "sent this" is the body of run().
  //
  // So this asserts on the source: run() must produce an `email.send` approval, and must not reach
  // sendMail. Source inspection is crude, and it is the honest tool for the job — the alternative
  // is executing run(), which would write a real row into the live approvals queue every time the
  // probe runs. The regression it guards against is someone "simplifying" the draft into a direct
  // send, and that regression is exactly what a source check catches.
  console.log("\ndraft_email drafts; it cannot send");
  {
    const before = failures;
    const t = TOOLS.find((x) => x.name === "draft_email");
    if (!t) fail("no draft_email tool — the email.send approval executor still has no producer");
    else {
      const src = t.run.toString();
      if (!/email\.send/.test(src)) {
        fail('draft_email does not create a kind:"email.send" approval — then nothing produces one, and sendApprovedEmail stays dead code');
      }
      if (/\bsendMail\b/.test(src)) {
        fail("draft_email references sendMail — it must queue for approval, never send directly");
      }
      const d = t.description.toLowerCase();
      if (!d.includes("never sends") && !d.includes("approve")) {
        fail("draft_email's description does not tell the model it only drafts — the model may promise a send it cannot do");
      }
    }
    if (failures === before) console.log("  ok    draft_email queues an email.send approval and never calls sendMail");
  }

  // ── Blocking files mail; it never destroys it ────────────────────────────────────────────────
  //
  // block_sender is reversible ONLY because blocked mail is archived rather than trashed. If that
  // ever became a delete, the reversible flag would silently become a lie and the router would run
  // it without asking.
  console.log("\nBlocking archives, never deletes");
  {
    const before = failures;
    const t = TOOLS.find((x) => x.name === "block_sender");
    if (!t) fail("no block_sender tool — the phishing that motivated this has no answer");
    else {
      if (!t.reversible) fail("block_sender is marked irreversible — blocking should not need a confirmation round-trip");
      const src = t.run.toString();
      if (/\btrash\b|\bdelete\b/i.test(src.replace(/deleteFilter/g, ""))) {
        fail("block_sender's implementation mentions trash/delete — blocked mail must only be archived");
      }
    }
    const gmail = await import("../../src/lib/clara/gmail");
    if (typeof gmail.createFilter !== "function") fail("gmail.createFilter is missing — block_sender cannot create a server-side filter");
    if (failures === before) console.log("  ok    block_sender archives and labels; nothing is destroyed");
  }

  // ── The Drive approval path is reachable at all ──────────────────────────────────────────────
  //
  // applyApprovedDriveEdit and applyApprovedDriveTrash have existed since the approvals queue was
  // built, wired into the executor switch, and had NEVER RUN — because proposeEdit/proposeTrash are
  // their only possible producers and nothing called those. drive_edit and drive_trash are those
  // callers. If either tool stops producing an approval, that whole path silently goes dead again.
  console.log("\nDrive edits and trashes produce real approvals");
  {
    const before = failures;
    const cases: [string, string][] = [["drive_edit", "proposeEdit"], ["drive_trash", "proposeTrash"]];
    for (const [tool, producer] of cases) {
      const t = TOOLS.find((x) => x.name === tool);
      if (!t) { fail(`expected a "${tool}" tool and found none`); continue; }
      const src = t.run.toString();
      if (!new RegExp(`\\b${producer}\\b`).test(src)) {
        fail(`${tool} does not call ${producer} — the drive approval executor goes back to being dead code`);
      }
      // Both are reversible ONLY because they create an approval rather than acting. If either ever
      // starts editing directly, that flag becomes a lie and the router would run it without asking.
      if (!t.reversible) fail(`${tool} is marked irreversible — it only queues an approval, so it would confirm twice`);
      if (!/QUEUED/.test(src)) fail(`${tool}'s result line never says QUEUED — the owner could read a proposal as a completed edit`);
    }
    const drive = await import("../../src/lib/clara/google-drive");
    for (const fn of ["applyApprovedDriveEdit", "applyApprovedDriveTrash"] as const) {
      if (typeof drive[fn] !== "function") fail(`${fn} is missing — approving a drive change would do nothing`);
    }
    if (failures === before) console.log("  ok    drive_edit/drive_trash queue approvals whose executors exist");
  }

  // ── The stubs that lied are gone ─────────────────────────────────────────────────────────────
  console.log("\nNo stubs that promise what they cannot do");
  {
    const before = failures;
    const recorder = await import("../../src/lib/clara/recorder");
    if ("startRecording" in recorder) {
      fail("recorder.startRecording is back — it was an empty function whose name promised capture it never performed");
    }
    const fs = await import("node:fs/promises");
    const triage = await fs.readFile("src/lib/clara/triage.ts", "utf8");
    // Allowed in a comment explaining the removal; not allowed as a value the code can produce.
    if (/action = "auto-reply-drafted"/.test(triage)) {
      fail('triage still assigns action "auto-reply-drafted" — it names a draft that is never created');
    }
    if (failures === before) console.log("  ok    startRecording removed; triage reports what it actually did");
  }

  // ── Speed classification, which voice depends on ─────────────────────────────────────────────
  console.log("\nTool speed is classified for voice");
  {
    const before = failures;
    for (const t of TOOLS) {
      if (t.speed !== "fast" && t.speed !== "slow") {
        fail(`${t.name}: no speed class — voice would await it inline and the caller hears silence`);
      }
    }

    // These genuinely take minutes. Marking one of them fast is how a phone call goes dead: Twilio
    // times the webhook out around 15s, long before the tool returns.
    for (const name of ["sweep_inbox", "list_subscriptions"]) {
      const t = TOOLS.find((x) => x.name === name);
      if (t && t.speed !== "slow") fail(`${name} is marked fast — it runs for minutes and would hang a call`);
    }

    // And the conversational reads must be fast, or every spoken question becomes "I'll text you".
    for (const name of ["list_calendar", "agent_status", "crm_lookup"]) {
      const t = TOOLS.find((x) => x.name === name);
      if (t && t.speed !== "fast") fail(`${name} is marked slow — a spoken question would get deferred instead of answered`);
    }
    if (failures === before) console.log(`  ok    ${TOOLS.length} tools classified; slow ones deferred, reads answered inline`);
  }

  // ── The sweep tool is reachable by intent, not by keyword ────────────────────────────────────
  console.log("\nThe original failure has a tool behind it");
  {
    const before = failures;
    const sweep = TOOLS.find((t) => t.name === "sweep_inbox");
    if (!sweep) fail("no sweep_inbox tool — the request that started all this has nothing to route to");
    else {
      // The description is what the model matches against. If it only says "inbox zero", the
      // model will miss "my email is a disaster" for the same reason the regex did.
      const d = sweep.description.toLowerCase();
      for (const word of ["clean", "sort", "organis", "analys", "tidy", "email"]) {
        if (!d.includes(word)) fail(`sweep_inbox description never mentions "${word}" — the model has to infer the match from it`);
      }
    }
    if (failures === before) console.log("  ok    sweep_inbox exists and describes itself in the words people actually use");
  }

  console.log(
    failures === 0
      ? "\nPASS — the router cannot claim work it did not do.\n"
      : `\nFAIL — ${failures} problem(s).\n`,
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
