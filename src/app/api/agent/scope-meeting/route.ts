// Scope-change meeting request (owner rule 2026-08-29). When FRIDAY has a client
// change-request flagged out-of-scope and the owner REJECTS the scope approval, the agent hands off
// here: CLARA emails the client — with the owner CC'd — to request a time to go over the new scope.
//
// This is the ONE sanctioned exception to Clara's draft-only rule for client mail: she SENDS,
// deterministically (no LLM/intent loop), because the send must fire exactly on rejection. Gated
// by the interagent secret like every sibling-facing surface (loopback / CF-Access clear it too).
//
// Idempotent: FRIDAY dispatches at-most-once per CR (thread marker), but a lost response
// could make them retry — so a dedupeKey (e.g. "os-cr:<id>") is recorded in a sidecar and a repeat
// is a no-op. That makes the whole reject→email path safe under retry.

import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { verifyInteragentSecret } from "@autom8ionlab/agent-core";
import { OWNER_WORK_EMAIL, OWNER_FIRST, BUSINESS_NAME } from "@/lib/clara/owner";
import { sendMail } from "@/lib/clara/ms-mail";
import { appendMessage } from "@/lib/clara/messages";
import { append as ledgerAppend } from "@/lib/clara/ledger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SENT_FILE = path.join(os.homedir(), ".agentic-os", "clara", "scope-meeting-sent.json");

async function loadSent(): Promise<Set<string>> {
  try { return new Set(JSON.parse(await fs.readFile(SENT_FILE, "utf8")) as string[]); } catch { return new Set(); }
}
async function saveSent(s: Set<string>): Promise<void> {
  await fs.mkdir(path.dirname(SENT_FILE), { recursive: true }).catch(() => {});
  await fs.writeFile(SENT_FILE, JSON.stringify([...s].slice(-500)), "utf8").catch(() => {});
}

function firstName(name: string): string {
  return (name || "").trim().split(/\s+/)[0] || "there";
}

function compose(opts: { clientName: string; projectName: string; crTitle: string }): { subject: string; body: string } {
  const hi = firstName(opts.clientName);
  const what = opts.crTitle ? `"${opts.crTitle}"` : "your recent request";
  const on = opts.projectName ? ` on ${opts.projectName}` : "";
  const subject = opts.crTitle
    ? `Let's talk through "${opts.crTitle}"`
    : `Let's talk through your recent request`;
  const body = [
    `Hi ${hi},`,
    ``,
    `Thanks for sending over ${what}${on}. After reviewing it against your current project scope, ` +
      `this one goes a bit beyond what's covered in the signed proposal — which usually just means it's ` +
      `worth a quick conversation so we get it right (timeline, approach, and any impact on scope).`,
    ``,
    `${OWNER_FIRST} would like to hop on a short call to go over it with you. What are a couple of times ` +
      `that work for you over the next few days? Reply here and we'll lock one in.`,
    ``,
    `Best,`,
    `Clara — on behalf of ${OWNER_FIRST}, ${BUSINESS_NAME}`,
  ].join("\n");
  return { subject, body };
}

export async function POST(req: NextRequest) {
  if (!verifyInteragentSecret(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as {
    clientEmail?: string;
    clientName?: string;
    projectName?: string;
    crTitle?: string;
    dedupeKey?: string;
    from?: string;
  };
  const clientEmail = String(body.clientEmail ?? "").trim();
  const clientName = String(body.clientName ?? "").trim();
  const projectName = String(body.projectName ?? "").trim();
  const crTitle = String(body.crTitle ?? "").trim();
  const dedupeKey = String(body.dedupeKey ?? "").trim();
  const from = String(body.from ?? "agent").toLowerCase();

  if (!clientEmail || !clientEmail.includes("@")) {
    return NextResponse.json({ error: "clientEmail required" }, { status: 400 });
  }

  // Idempotency: a repeat dispatch for the same CR is a no-op (never double-email a client).
  const key = dedupeKey || `${clientEmail}|${crTitle}`;
  const sent = await loadSent();
  if (sent.has(key)) {
    return NextResponse.json({ ok: true, skipped: "already-sent", dedupeKey: key });
  }

  if (!OWNER_WORK_EMAIL) {
    return NextResponse.json({ error: "owner email unavailable for CC" }, { status: 500 });
  }

  const { subject, body: emailBody } = compose({ clientName, projectName, crTitle });
  const res = await sendMail({ to: clientEmail, cc: OWNER_WORK_EMAIL, subject, body: emailBody });
  if (!res.ok) {
    // Do NOT record as sent — let the caller retry.
    return NextResponse.json({ ok: false, error: res.error ?? "send failed" }, { status: 502 });
  }

  sent.add(key);
  await saveSent(sent);

  const note = `📅 Sent ${clientName || clientEmail} a scope-change meeting request (CC ${OWNER_WORK_EMAIL})${projectName ? ` for ${projectName}` : ""}${crTitle ? ` re "${crTitle}"` : ""} — handed off by ${from.toUpperCase()}.`;
  await appendMessage("clara", note).catch(() => {});
  await ledgerAppend({
    kind: "action",
    actor: "clara",
    what: "scope-change meeting request emailed to client (CC owner)",
    meta: { clientEmail, projectName, crTitle, from, dedupeKey: key },
  }).catch(() => {});

  return NextResponse.json({ ok: true, id: res.id, dedupeKey: key });
}
