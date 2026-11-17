// Clara ↔ orion (Orion) MCP wiring.
//
// Clara authenticates to the OS as her OWN account, clara@example.com, carrying the
// ClaraAgent role — the same shape FRIDAY has. She previously signed in as the owner's
// owner account; that was a deliberate early choice (it gave her the broad CRM surface her job
// needs before a clara@ Workspace user existed), and 2026-08-01 moved her onto her own identity.
//
// What that change does and does not buy — worth stating precisely, because the obvious reading is
// wrong. RLS on the tables she touches (contacts, conversations, proposals, drive_files) checks
// ORGANIZATION MEMBERSHIP only — re-verified against pg_policies on 2026-08-01, not inherited from
// the earlier note — and the OS MCP server has no per-tool permission gate. Role permissions are
// enforced by the OS web UI, not on this path. So moving off the owner's identity does NOT meaningfully
// shrink what she can reach through MCP. What it does buy is a truthful audit trail (her writes are
// attributed to her, not to the owner), her own heartbeat so a dead CLARA is distinguishable from a dead
// The owner session, and a correct basis if RLS is ever tightened per-role.
//
// The real controls on destructive action are unchanged and remain the only ones that matter here:
// (1) the CLARA_OS_TOOLS allowlist below, kept away from destructive admin/system operations, and
// (2) Clara's own tiered approval governor (lib/clara/approvals.ts / tiers.ts) for anything she
// reasons about herself.
//
// The one-time interactive sign-in that populates the vault is done via /api/os/auth. Clara already
// keeps her Google token in ~/.agentic-os/clara; the OS session file lives alongside it.

import path from "node:path";
import os from "node:os";
import { OsAuth, OsMcpClient, allowExact, CLARA_OS_TOOLS, toCliAllowedTools } from "@autom8ionlab/agent-core";
import { filterOsToolNames, filterToolNames, peekAgentSettings } from "./agentSettings";

const REDIRECT_URI =
  process.env.ORION_REDIRECT_URI ?? "http://127.0.0.1:3939/os/auth/capture";

export const osAuth = new OsAuth({
  agentDir: path.join(os.homedir(), ".agentic-os", "clara"),
  supabaseUrl: process.env.ORION_SUPABASE_URL,
  supabaseAnonKey: process.env.ORION_SUPABASE_ANON_KEY,
  redirectUri: REDIRECT_URI,
});

// Owner-broad but not unlimited: CLARA_OS_TOOLS is agent-core's shared, exact-tool-name allowlist —
// full access to calendars/contacts/communications (incl. phone_* for the B4 number)/conversations/
// proposals/reporting/files/personal-assistant, but explicitly READ-ONLY on projects and payments
// per the approved plan, and administration.ts/auth.ts stay excluded entirely regardless of what
// The owner's own owner account could technically reach at the RLS layer. Single source of truth shared
// with the CLI's --allowedTools below.
const inAllowlist = allowExact(CLARA_OS_TOOLS);
/** CLARA_OS_TOOLS narrowed by the OS per-agent settings (denied always; allowed when it names MCP tools). */
export function osToolAllowed(name: string): boolean {
  return inAllowlist(name) && filterToolNames([name], osToolSettings()).length === 1;
}
function osToolSettings() {
  const t = peekAgentSettings().root.tools;
  // The namespace test has to see the whole MCP list, not just the one name being checked.
  const namesMcp = t.allowed?.some((n) => CLARA_OS_TOOLS.includes(n)) ?? false;
  return { allowed: namesMcp ? t.allowed : null, denied: t.denied };
}

export const osClient = new OsMcpClient({
  auth: osAuth,
  url: process.env.ORION_MCP_URL,
  allow: osToolAllowed,
  clientName: "clara-osmcp",
});

/** True once Clara has completed the one-time OS sign-in (vault has a refresh token). */
export function osEnabled(): boolean {
  return osAuth.osConfigured();
}

// ── CLI wiring (engines.ts) ────────────────────────────────────────────────
// A spawned `claude -p` reasons FREELY and can decide on its own to call any tool in
// --allowedTools — unlike osClient.callTool() above, there's no tier-table check in front of it.
// tiers.ts marks several categories draft-then-approve (drive.modify/delete, call.business) rather
// than auto specifically because irreversible/external-facing actions need a human in the loop, not
// an LLM's unilateral judgment call. So the CLI gets a strictly SAFER subset than the native client:
// read tools plus reversible create/update, with hard deletes, e-signature sends/voids,
// archive/unarchive, SMS/email sends, phone infra config, and contact merges/bulk-reassign excluded.
// If Clara decides one of those is warranted, she says so in her reply and it goes through the
// existing draft-then-approve flow like any other action — the same posture the tier table already
// enforces for her hand-written action code, just extended to the new MCP surface.
// Prospecting additions (2026-09-30): companies_promote creates a CRM contact/opportunity,
// sequence_enroll starts real outreach, and research_job_create can commit real spend once a job
// leaves draft — none of them belong to a free-reasoning `claude -p` session. They're excluded here
// even though they live on osBridge.ts's own extension client (not CLARA_OS_TOOLS) today, so the
// CLI stays safe the moment either list grows to include them.
const CLI_UNSAFE_TOOL_PATTERN = /(_delete$|_send_for_signature$|_signature_resend$|_signature_void$|_archive$|_unarchive$|^email_send$|^send_sms$|^phone_|_merge$|_bulk_assign_owner$|^clara_memory_decay$|^project_support_tickets_update$|^project_ticket_comment_create$|^companies_promote$|^sequence_enroll$|^research_job_create$)/;
export const CLARA_OS_CLI_TOOLS: readonly string[] = CLARA_OS_TOOLS.filter((t) => !CLI_UNSAFE_TOOL_PATTERN.test(t));

export const OS_MCP_CONFIG_PATH = path.join(process.cwd(), ".mcp.json");
export const OS_CLI_MCP_ALLOW = toCliAllowedTools(CLARA_OS_CLI_TOOLS);
export const OS_CLI_LOCAL_READ = ["Read", "Glob", "Grep", "LS", "WebFetch", "WebSearch", "TodoWrite"];
export const OS_CLI_LOCAL_WRITE = ["Edit", "Write", "MultiEdit", "NotebookEdit", "Bash", "Task"];

/** The `--allowedTools` value for an OS-enabled run. Includes local write tools only when `write`. */
export function osCliAllowedTools(write: boolean): string {
  // Narrowed per call by the OS per-agent settings (never widened past CLARA_OS_CLI_TOOLS).
  const mcp = toCliAllowedTools(filterOsToolNames(CLARA_OS_CLI_TOOLS, peekAgentSettings().root.tools));
  return [...OS_CLI_LOCAL_READ, ...(write ? OS_CLI_LOCAL_WRITE : []), ...mcp].join(",");
}
