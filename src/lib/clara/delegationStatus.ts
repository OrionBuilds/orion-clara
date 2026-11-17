// Read a bench's run/task records into one of four states, and turn a finished run into text a
// client may see. Pure — the HTTP polling lives in delegationWatch.ts.
//
// FRIDAY's deliverable agents end their output with a `## CLIENT SUMMARY` block (agents.ts prompts);
// everything ABOVE it is internal candor — file paths, "VERDICT: FAIL", blocker notes — that must
// never reach a client. The marker below mirrors FRIDAY's deliverables.ts and must stay in sync.

export type BenchState = "pending" | "done" | "parked" | "failed";

export interface BenchRun { status: string; result?: string; summary?: string; error?: string; endedAt?: string; startedAt?: string }

export const CLIENT_SUMMARY_MARKER = /(^|\n)\s*#{0,3}\s*\**\s*client[\s_-]*summary\s*:?\**\s*(\n|$)/i;

/** ONLY the text under the CLIENT SUMMARY marker, or null when the agent didn't emit one. */
export function clientSafeBlock(raw: string): string | null {
  const m = raw.match(CLIENT_SUMMARY_MARKER);
  if (!m || m.index == null) return null;
  const after = raw.slice(m.index + m[0].length).trim();
  return after.length >= 8 ? after : null;
}

/**
 * Belt-and-braces scrub for anything that goes to a client, applied even to a CLIENT SUMMARY block:
 * absolute/source paths, `file.ts:12` references, loopback URLs, verdict lines, fenced code, stack
 * frames. Capped so a runaway result can't become a 40 KB email.
 */
export function sanitizeForClient(text: string, max = 1500): string {
  let t = text;
  t = t.replace(/```[\s\S]*?```/g, "");
  t = t.replace(/^\s*at .+\(.+:\d+:\d+\)\s*$/gm, "");
  t = t.replace(/https?:\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0)(:\d+)?[^\s)]*/gi, "");
  t = t.replace(/(?:\/home\/|\/mnt\/|[A-Z]:\\)[^\s)"']+/g, "");
  t = t.replace(/\b(?:src|lib|app|scripts)\/[\w./-]+(?::\d+)?/g, "");
  t = t.replace(/\b[\w-]+\.(?:ts|tsx|js|mjs|py|sql)(?::\d+(?::\d+)?)?\b/g, "");
  t = t.replace(/^\s*(?:VERDICT|BLOCKER|SHOULD-FIX|NIT)\b.*$/gim, "");
  t = t.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

/** FRIDAY: `GET /api/friday/runs?taskId=` — newest first. */
export function fridayState(runs: BenchRun[]): { state: BenchState; clientText?: string; internal?: string } {
  const run = runs[0];
  if (!run) return { state: "pending" };
  switch (run.status) {
    case "done": {
      const block = clientSafeBlock(run.result ?? "");
      return { state: "done", clientText: block ? sanitizeForClient(block) : undefined, internal: run.summary };
    }
    case "awaiting_approval":
      return { state: "parked", internal: run.summary };
    case "error":
    case "cancelled":
      return { state: "failed", internal: run.error ?? run.summary };
    default:
      return { state: "pending" };
  }
}

/** The message a client receives when work is finished. Never the raw result. */
export function completionMessage(clientName: string, summary: string, clientText: string | undefined, ownerFirst: string, businessName?: string): string {
  const head = `Hi ${clientName.split(" ")[0] || "there"},\n\n`;
  const body = clientText
    ? `Quick update on "${summary}":\n\n${clientText}\n\n`
    : `Quick update: the work on "${summary}" is complete. ${ownerFirst} will follow up with the details.\n\n`;
  return `${head}${body}Reply here if anything needs adjusting.\n\n— Clara${businessName ? `, ${businessName}` : ""}`;
}
