// Clara's SECOND orion identity — the clara@ AGENT account, used only for OS "Agent Tasks".
//
// Why two clients: osClient.ts authenticates as the OWNER's account (correct for the CRM surface —
// Clara acts on their behalf there). But the agent-task backbone keys everything to the agent's own
// user: `agent_task_schedules.agent_user_id` for Clara's rows is the clara@ user,
// the `claim_due_agent_task_runs` RPC claims `WHERE agent_user_id = auth.uid()`, and
// the `agent_task_runs` INSERT/UPDATE RLS policies require `agent_user_id = auth.uid()`. Polling
// with the owner's identity therefore finds ZERO schedules and couldn't write run rows if it did — the
// poller silently no-ops forever. This client signs in as clara@ and is handed to the poll context
// in osTasks.ts; everything else in Clara keeps using osClient.
//
// The allowlist is deliberately tiny: ONLY the agent-task loop tools (poll/report/deliver/lease/
// whoami), the two team-messaging tools the daily_owner_briefing handler posts through, and the
// four Wave-3 approval-bridge tools (mirror/pull/ack/close, see osApprovalsBridge.ts). The
// clara@ account gets no CRM reach through this client even if RLS would allow it.
//
// One-time sign-in: visit /os/auth/agent while signed OUT of the owner's Google (or in a private
// window), authenticate as clara@example.com, and the capture page routes the session into
// this client's vault dir (~/.agentic-os/clara/agent/os-session.json). See docs/os-agent-auth.md.

import path from "node:path";
import os from "node:os";
import { OsAuth, OsMcpClient, allowExact } from "@autom8ionlab/agent-core";

const REDIRECT_URI =
  process.env.ORION_REDIRECT_URI ?? "http://127.0.0.1:3939/os/auth/capture";

// Sibling of osClient's ~/.agentic-os/clara — the "agent" subdir keeps the two session files
// (owner vs agent identity) from ever overwriting each other.
const AGENT_VAULT_DIR = path.join(os.homedir(), ".agentic-os", "clara", "agent");
/** OsAuth's session store inside the agent vault — exported so the auth callback can hard-delete
 *  a session captured under the WRONG Google account (OsAuth has no public clear API). */
export const OS_AGENT_SESSION_FILE = path.join(AGENT_VAULT_DIR, "os-session.json");

export const osAgentAuth = new OsAuth({
  agentDir: AGENT_VAULT_DIR,
  supabaseUrl: process.env.ORION_SUPABASE_URL,
  supabaseAnonKey: process.env.ORION_SUPABASE_ANON_KEY,
  redirectUri: REDIRECT_URI,
});

// Exactly what the agent loops need, nothing else:
// - agent-core's pollOsTasks() calls agent_tasks_poll / agent_run_report / agent_run_deliver_confirm
//   (agent_run_extend_lease is the long-runner escape hatch on the same surface);
// - osTasks.ts itself calls agent_whoami once for {user_id, organization_id};
// - the daily_owner_briefing handler posts via team_channels_list + team_message_send when active;
// - osApprovalsBridge.ts (Wave 3) mirrors/closes/pulls/acks against the OS approvals hub.
export const CLARA_OS_AGENT_TOOLS: readonly string[] = [
  "agent_whoami",
  "agent_tasks_poll",
  "agent_run_report",
  "agent_run_deliver_confirm",
  "agent_run_extend_lease",
  "team_message_send",
  "team_channels_list",
  // Wave 3 approvals bridge (osApprovalsBridge.ts):
  "agent_approval_mirror",
  "agent_approval_pull_decisions",
  "agent_approval_ack",
  "agent_approval_close",
];

export const osAgentClient = new OsMcpClient({
  auth: osAgentAuth,
  url: process.env.ORION_MCP_URL,
  allow: allowExact(CLARA_OS_AGENT_TOOLS),
  clientName: "clara-agent-osmcp",
});

/** True once the one-time clara@ sign-in has populated the agent vault (refresh token present). */
export function osAgentEnabled(): boolean {
  return osAgentAuth.osConfigured();
}
