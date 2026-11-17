// Clara — deliver research/findings to the owner.
//
// Since Clara has no purchase power, the terminal step of every research flow (travel options,
// deep-research findings, business-call outcomes) is the same: email the full write-up, text a
// short heads-up pointing at it. One shared helper so that isn't duplicated per-module.

import { sendMail } from "./ms-mail";
import { sendSMS } from "./channels";
import { notifyOwner } from "./notify";
import { loadConfig } from "./config";
import { append as ledgerAppend } from "./ledger";
import type { PrincipalId } from "./types";

export async function deliverToPrincipal(
  principal: PrincipalId,
  subject: string,
  body: string,
  smsHeadsUp: string,
): Promise<{ ok: boolean; error?: string }> {
  const cfg = await loadConfig();
  const p = cfg.principals[principal];
  const email = p.emails[0];
  const phone = p.phones[0];

  let emailOk = false, emailError: string | undefined;
  if (email) {
    const r = await sendMail({ to: email, subject, body }).catch((e) => ({ ok: false, error: String(e) }));
    emailOk = r.ok;
    emailError = r.error;
  } else {
    emailError = `no email on file for ${principal}`;
  }

  if (phone) {
    // The email above IS the deliverable; the text is only a pointer at it, so it goes through
    // the governed path (quiet hours / dedupe / batching) instead of straight to their phone.
    await notifyOwner({ kind: "deliver", text: smsHeadsUp.slice(0, 1500), priority: "normal", dedupeKey: `deliver:${subject}` }).catch(() => {});
  }

  await ledgerAppend({
    kind: "action",
    actor: "clara",
    what: `delivered "${subject}" to ${principal}${emailOk ? "" : ` (email failed: ${emailError})`}`,
    meta: { principal, subject, emailOk, hadPhone: Boolean(phone) },
  }).catch(() => {});

  return { ok: emailOk, error: emailOk ? undefined : emailError };
}
