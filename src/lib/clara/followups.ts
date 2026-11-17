// Clara — auto-chase follow-up state machine.
//
// "Waiting on X since day Y" → nudge day 2 / 5 / 10 → escalate channel → flag. Lives on top
// of the ledger + email/SMS layers. Wired to cron in W3.

import { promises as fs } from "node:fs";
import path from "node:path";
import { loadConfig } from "./config";
import { sendMail } from "./ms-mail";
import { sendSMS } from "./channels";
import { append as ledgerAppend } from "./ledger";
import { gateOutbound, recordSent, enqueue } from "./outbound";
import { OWNER_NAME } from "./owner";

export type Channel = "email" | "sms" | "call";

export interface Followup {
  id: string;
  what: string;                 // "quote from Acme for cleaning"
  contact: { name: string; email?: string; phone?: string };
  createdAt: string;
  lastNudgeAt?: string;
  nudgeCount: number;
  channel: Channel;
  status: "open" | "resolved" | "abandoned";
}

// Ledger is markdown-in-vault; simple append + rescan model, same shape as tasks.
async function file(): Promise<string> {
  const cfg = await loadConfig();
  const dir = path.join(cfg.vaultRoot, "followups");
  await fs.mkdir(dir, { recursive: true });
  return path.join(dir, "open.json");
}

async function load(): Promise<Followup[]> {
  try { return JSON.parse(await fs.readFile(await file(), "utf8")) as Followup[]; }
  catch { return []; }
}
async function save(rows: Followup[]): Promise<void> {
  await fs.writeFile(await file(), JSON.stringify(rows, null, 2), "utf8");
}

export async function open(f: Omit<Followup, "id" | "createdAt" | "nudgeCount" | "status">): Promise<Followup> {
  const rows = await load();
  const row: Followup = { ...f, id: crypto.randomUUID(), createdAt: new Date().toISOString(), nudgeCount: 0, status: "open" };
  rows.push(row);
  await save(rows);
  return row;
}

export async function resolve(id: string): Promise<void> {
  const rows = await load();
  const row = rows.find((r) => r.id === id);
  if (row) row.status = "resolved";
  await save(rows);
}

// Called by cron. Nudges on day 2 / 5 / 10 from lastNudgeAt (or createdAt), escalates channel on 3rd nudge.
export async function tickAndNudge(now: Date = new Date()): Promise<{ nudged: Followup[]; sent: number; failed: number }> {
  const rows = await load();
  const nudged: Followup[] = [];
  let sent = 0, failed = 0;

  for (const r of rows) {
    if (r.status !== "open") continue;
    const last = new Date(r.lastNudgeAt ?? r.createdAt).getTime();
    const daysSince = (now.getTime() - last) / 86_400_000;
    const targets = [2, 5, 10];
    if (r.nudgeCount >= targets.length || daysSince < targets[r.nudgeCount]) continue;

    // On the 3rd nudge, promote channel: email → sms if we have a phone.
    if (r.nudgeCount === 2 && r.channel === "email" && r.contact.phone) r.channel = "sms";

    const salutation = r.contact.name.split(" ")[0] || "there";
    const nudgeCopy = nudgeText(r.nudgeCount, salutation, r.what);

    const to = r.channel === "email" ? r.contact.email : r.contact.phone;
    if (!to) continue;
    const subject = `Following up — ${r.what}`;
    const meta = { channel: r.channel === "call" ? ("sms" as const) : r.channel, to, kind: "followup.nudge" };
    const gate = await gateOutbound(meta, { deferrable: true });
    if (gate.action === "block") { failed++; continue; }
    if (gate.action === "queue") { await enqueue(meta, gate.sendAfterMs, nudgeCopy, subject); continue; }

    let ok = false, ref: string | undefined;
    if (r.channel === "email" && r.contact.email) {
      const res = await sendMail({ to: r.contact.email, subject, body: nudgeCopy });
      ok = res.ok; ref = res.id;
    } else if (r.channel === "sms" && r.contact.phone) {
      const res = await sendSMS(r.contact.phone, nudgeCopy);
      ok = res.ok; ref = res.sid;
    }
    if (ok) await recordSent(meta);

    if (ok) {
      sent++;
      r.lastNudgeAt = now.toISOString();
      r.nudgeCount += 1;
      nudged.push(r);
      await ledgerAppend({
        kind: r.channel === "email" ? "email.sent" : "sms.sent",
        actor: "clara",
        what: `followup nudge #${r.nudgeCount} to ${r.contact.name} re: ${r.what}`,
        ref,
        meta: { followupId: r.id, channel: r.channel },
      });
    } else {
      failed++;
    }
  }
  if (nudged.length) await save(rows);
  return { nudged, sent, failed };
}

export async function listOpen(): Promise<Followup[]> {
  return (await load()).filter((r) => r.status === "open");
}

function nudgeText(nudgeIndex: number, salutation: string, what: string): string {
  // Nudge tone escalates gently — friendly → nudging → last check.
  if (nudgeIndex === 0) {
    return `Hi ${salutation} — just circling back on ${what}. Any updates on your end? Happy to help move it forward. — Clara (${OWNER_NAME}'s assistant)`;
  }
  if (nudgeIndex === 1) {
    return `Hi ${salutation} — following up again on ${what}. If it's slipped, no worries — just let me know if timing has shifted. — Clara`;
  }
  return `Hi ${salutation} — one last check on ${what}. If I don't hear back, I'll assume you're all set and close it out. — Clara`;
}
