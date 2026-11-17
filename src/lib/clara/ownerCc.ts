// Owner rule (2026-09-15): the owner is CC'd on EVERY email CLARA sends — so she can send on her own,
// including what they ask for in chat/SMS, without an approval step, and they still see all of it.
// Applied once, in gmail.sendMail, which every send path goes through (client acks, follow-ups,
// vendor mail, approved drafts, send_email). Skipped only when they are already a recipient — her
// briefs, digests and notifications are addressed TO them, and CC'ing them on those is noise.

function addresses(list?: string): string[] {
  return (list ?? "")
    .split(",")
    .map((x) => (x.match(/<([^>]+)>/)?.[1] ?? x).trim().toLowerCase())
    .filter(Boolean);
}

/** The Cc header value to send with: the caller's cc plus the owner, unless they're already on it. */
export function withOwnerCc(to: string, cc: string | undefined, owner: string): string | undefined {
  const o = owner.trim().toLowerCase();
  const given = cc?.trim() || undefined;
  if (!o) return given;
  if (addresses(to).includes(o) || addresses(given).includes(o)) return given;
  return given ? `${given}, ${o}` : o;
}
