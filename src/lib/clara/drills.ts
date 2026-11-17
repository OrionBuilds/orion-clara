// Clara — end-to-end drill runner.
//
// Simulates the emergency paths so the owner can verify (without a real crisis) that the
// right thing would happen. Every drill dry-runs the decision layer and reports the
// verdict; the actual side-effect (Twilio dial, SMS to the owner) is opt-in via `execute: true`.

import { noteInbound, contextFor, decide } from "./screening";
import { loadConfig } from "./config";
import { ownerFocusMode } from "./focus";
import { notifyOwner } from "./notify";
import { OWNER_FIRST } from "./owner";

export type DrillName = "unknown-focus" | "unknown-open";

export interface DrillResult {
  name: DrillName;
  simulated: {
    fromE164: string;
    ownerFocusMode: boolean;
    isWhitelisted: boolean;
  };
  verdict: { route: "owner" | "clara"; urgency: string; reason: string };
  interruptLanded: boolean;
  executed: boolean;
  notes: string[];
}

export async function runDrill(name: DrillName, execute = false): Promise<DrillResult> {
  const cfg = await loadConfig();
  const ownerNumber = cfg.principals.owner.phones[0] ?? "+15552223333";
  const notes: string[] = [];

  let fromE164 = "";
  switch (name) {
    case "unknown-focus":
    case "unknown-open":
      fromE164 = "+15558675309";
      await noteInbound(fromE164);
      notes.push(`inbound from a stranger number`);
      break;
  }

  // Real focus mode check (falls back to false without Google connected). For the two
  // synthetic "unknown-*" drills we FORCE the focus flag so the owner can see both branches
  // without waiting for a real meeting to overlap.
  const realFocus = await ownerFocusMode();
  const forcedFocus = name === "unknown-focus" ? true : name === "unknown-open" ? false : realFocus;
  if (forcedFocus !== realFocus) notes.push(`focus flag forced to ${forcedFocus} for drill (real value: ${realFocus})`);

  const ctx = await contextFor(fromE164, ownerNumber, forcedFocus);
  const verdict = decide(ctx);

  const interruptLanded = verdict.route === "owner" &&
    (verdict.urgency === "emergency" || verdict.urgency === "urgent" || !forcedFocus);

  let executed = false;
  if (execute && verdict.route === "owner" && verdict.urgency !== "normal") {
    const msg = `Drill: ${name} → route:${verdict.route} urgency:${verdict.urgency} (${verdict.reason})`;
    // Governed path — a drill verifies the pipeline, it shouldn't get to bypass it.
    const res = await notifyOwner({ kind: "drill", text: msg, priority: "normal", dedupeKey: `drill:${name}:${new Date().toISOString().slice(0, 16)}` });
    executed = res.sms || res.queued;
    notes.push(res.sms ? `sent drill SMS to ${OWNER_FIRST}` : res.queued ? "drill notice queued (quiet hours)" : "drill notice suppressed (recent duplicate)");
  }

  return {
    name,
    simulated: {
      fromE164,
      ownerFocusMode: forcedFocus,
      isWhitelisted: ctx.isWhitelisted,
    },
    verdict,
    interruptLanded,
    executed,
    notes,
  };
}
