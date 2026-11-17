# CLARA ↔ Orion: the clara@ agent sign-in (one-time manual step)

## Why CLARA has two OS identities

CLARA talks to Orion through two separate MCP clients:

| Client | Signs in as | Vault | Used for |
| --- | --- | --- | --- |
| `src/lib/clara/osClient.ts` | **clara@example.com** (agent, same account) | `~/.agentic-os/clara/os-session.json` | The CRM surface — calendars, contacts, communications, proposals, files. CLARA acts on the owner's behalf there, so their identity is correct. |
| `src/lib/clara/osAgentClient.ts` | **clara@example.com** (agent) | `~/.agentic-os/clara/agent/os-session.json` | ONLY the OS "Agent Tasks" loop (`osTasks.ts`): poll, run-report, deliver-confirm, lease-extend, whoami, plus team_channels_list/team_message_send for the briefing post. |

The split is not cosmetic. In Orion:

- CLARA's four `agent_task_schedules` rows (`clara.daily_owner_briefing`, `clara.inbox_triage_digest`, `clara.meeting_prep`, `clara.meeting_followups`) all carry `agent_user_id` = the **clara@** auth user's id.
- The claim RPC `claim_due_agent_task_runs` selects schedules `WHERE agent_user_id = auth.uid()`.
- The `agent_task_runs` INSERT/UPDATE RLS policies require `agent_user_id = auth.uid()`.

So a poller authenticated as the owner's account claims **zero** schedules and could not write run rows even if it claimed one. Until the clara@ sign-in below is completed, the poller logs once per boot — `os-tasks: agent identity (clara@) not signed in …` — and skips.

## The one-time sign-in

1. Make sure the CLARA app is running (`npm run dev`, or however you run it as a service).
2. Open a **private/incognito window** (the normal profile is signed into the owner's Google, and Supabase will silently reuse it).
3. Visit `http://127.0.0.1:3939/os/auth/agent`.
4. Complete the Google sign-in as **clara@example.com**.
5. The capture page should report `Connected as clara@example.com.`

That's it — within a minute the scheduler's `os-agent-tasks-poll` job starts polling with the agent identity (subject to `CLARA_OS_TASKS`, default `shadow`; schedules seeded with `mode='off'` in Orion fire nothing until they're switched on).

### How the flow works (for future debugging)

`/os/auth/agent` is a tiny client page that sets `sessionStorage["os-auth-target"]="agent"` and then enters the **existing** `/api/os/auth` OAuth flow. The flag has to ride sessionStorage because Supabase's `redirect_to` must exactly match the allowlisted capture URL — no query params survive the OAuth hop. The capture page (`/os/auth/capture`) reads and clears the flag and POSTs `target:"agent"` alongside the tokens; the callback then persists into the agent vault instead of the owner's. The callback **refuses** (and deletes) an agent-targeted session whose verified email isn't clara@ (`CLARA_OS_AGENT_EMAIL` overrides the expected address), so a mis-clicked account can't silently become the poll identity.

### Verifying / troubleshooting

- `GET /api/os/auth/callback` returns both identities: `{ configured, identity, agent: { configured, identity } }`. `agent.configured: true` with `agent.identity.email: "clara@example.com"` means you're done.
- Signed in but still no runs? Check `CLARA_OS_TASKS` isn't `off`, and that the schedule rows in Orion aren't `mode='off'`.
- To redo the sign-in (e.g. revoked refresh token — they rotate on every use and a crash between refresh and persist can strand one): just repeat the steps above; a new capture overwrites the vault. To disconnect entirely, delete `~/.agentic-os/clara/agent/os-session.json`.
