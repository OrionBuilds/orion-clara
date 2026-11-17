// Clara — approved-email dispatcher.
//
// Used by the approvals queue to actually send a message the owner has green-lit.

import { sendMail } from "./ms-mail";
import type { Approval } from "./approvals";

export interface EmailIntent {
  to: string;
  subject: string;
  body: string;
  cc?: string;
  inReplyTo?: string;
  references?: string;
}

export async function sendApprovedEmail(row: Approval): Promise<{ ok: boolean; error?: string; ref?: string }> {
  const intent = row.intent as EmailIntent;
  const res = await sendMail(intent);
  return { ok: res.ok, error: res.error, ref: res.id };
}
