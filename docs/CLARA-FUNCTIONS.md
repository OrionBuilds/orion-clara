# CLARA — Complete Tool/Function Inventory

Compiled by direct code inspection. Line numbers drift; treat them as pointers. Source of truth for the
model-callable catalog: `src/lib/clara/intent.ts` (the `TOOLS` array, lines 81–1258). This is the
**only** tool catalog in the codebase — every channel (chat UI, SMS, voice, email-command) routes
through it via `runIntent()`; confirmed callers: `src/app/api/chat/route.ts`,
`src/app/api/intent/route.ts`, `src/app/api/channels/twilio/voice/route.ts`,
`src/app/api/channels/twilio/sms/route.ts`, `src/lib/clara/emailCommands.ts`. There is no
second/business-facing tool catalog — the business persona (below) runs a plain chat completion
with **zero tools**.

CLARA is the only one of the agents (CLARA/FRIDAY) with access to the owner's work
email, contacts, and calendar — a standing rule, not just a current-state observation.

## Email & Calendar

| Tool | Description | Location |
|---|---|---|
| `sweep_inbox` | Triage/archive bulk-mail, mark routine read, label the rest for review. Never deletes. | intent.ts:121 |
| `list_subscriptions` | Inventory bulk-mail senders and whether each can be safely unsubscribed. Read-only. | intent.ts:147 |
| `unsubscribe_from` | Unsubscribe one named sender via List-Unsubscribe header. | intent.ts:172 |
| `find_email` | Gmail search over the work mailbox (incl. archived). Read-only. | intent.ts:199 |
| `draft_email` | Composes an email and queues an `email.send` approval — never sends directly. | intent.ts:225 |
| `block_sender` | Archives+labels future mail from a sender/domain via a Gmail filter; never deletes. | intent.ts:272 |
| `list_blocked` | Lists/unblocks blocklist entries. | intent.ts:324 |
| `list_calendar` | Lists upcoming events (work calendar via `combinedUpcoming`). Read-only. | intent.ts:622 |
| `move_event` | Reschedules/renames an event; becomes an approval if attendees are present. | intent.ts:642 |
| `cancel_event` | Cancels a calendar event. Always requires approval (`reversible: false`). | intent.ts:676 |
| `book_event` | Creates a calendar event; requires approval if anyone external is invited. | intent.ts:696 |
| `coordinate_event` | End-to-end booking + invites; always an approval (invites real people). | intent.ts:582 |
| `check_availability` | Reads CRM booking-calendar availability (via orion MCP). Read-only. | intent.ts:1115 |
| `book_appointment` | Books an appointment on a CRM booking calendar (via orion MCP). Notifies client → irreversible. | intent.ts:1136 |

## Drive & Documents

| Tool | Description | Location |
|---|---|---|
| `drive_search` | Search Drive by name/content. Read-only. | intent.ts:364 |
| `drive_read` | Read a Drive file as text (12k chars per call, `offset` to page); screens for prompt-injection and flags it in the reply. | intent.ts:391 |
| `drive_create` | Creates a new Doc/Sheet/Slides/text/csv file (never overwrites). | intent.ts:416 |
| `drive_edit` | Structured per-op edit of an existing file (docs-insert `text`, docs-replace `replacements[]`, sheets-write, drive-replace-content). Owner asks apply at once; others queue a `drive.modify` approval. Refreshes the knowledge snapshot when the file is a listed source. | intent.ts:448 |
| `drive_trash` | Queues a `drive.trash` approval to move a file to trash (recoverable). | intent.ts:493 |
| `make_document` | Generates a PDF (itinerary/summary/brief/checklist) into the owner's vault. | intent.ts:515 |

## Tasks, Follow-ups & Status

| Tool | Description | Location |
|---|---|---|
| `add_task` | Adds a task, synced to Google Tasks. | intent.ts:736 |
| `list_tasks` | Lists open tasks. | intent.ts:759 |
| `complete_task` | Marks a task done by fuzzy title match; refuses on ambiguity. | intent.ts:778 |
| `track_followup` | Starts tracking something owed by a third party; auto-nudges day 2/5/10. | intent.ts:804 |
| `list_followups` | Lists open follow-ups and their age. | intent.ts:832 |
| `whats_waiting_on_me` | Combined signal/noise view across mail, texts, calls, approvals, notifications. | intent.ts:852 |
| `brief_me` | Composes morning/evening/weekly brief on demand; gated for cloud-safety before returning. | intent.ts:873 |
| `agent_status` | Live fleet status (Clara/FRIDAY): health, spend, autonomy dials. | intent.ts:900 |
| `restart_service` | Restarts `friday`, `clara`, or `mcp` when stuck. | intent.ts:913 |

## Delegation

| Tool | Description | Location |
|---|---|---|
| `delegate_to_agent` | **The** delegation tool. `{ agent: "friday", task: string }`. Calls `dispatchTo()` in `src/lib/clara/routing.ts` — for FRIDAY it calls `delegate()` in `src/lib/clara/friday-bridge.ts` (an interagent inbox call). Reports back real task ids when the target hands them back, distinguishes "unconfirmed" from "failed" from "timed out" (`indeterminate`) rather than claiming success/failure it can't verify. | intent.ts:932 |

There is a **second**, non-tool-catalog routing path — `src/lib/clara/routing.ts` also implements
`proposeRoute()`/`dispatchDetached()`, a regex-based auto-offer ("that looks like dev work — send
to FRIDAY?") used specifically in the SMS thread, confirmed by the user before it fires. It's not
an LLM-invoked tool, it's a separate keyword classifier wired into the SMS route directly.

## CRM (orion over MCP) — Wired Tools

CLARA connects to the `orion` MCP server (`.mcp.json`: `http://127.0.0.1:3100/mcp`, Bearer JWT).
She is allow-listed for ~217 tool names (`CLARA_OS_TOOLS` in
`node_modules/@autom8ionlab/agent-core/src/osmcp/allowlists.ts:151-230`, covering calendars,
contacts, communications incl. `phone_*`, conversations, proposals/contracts, reporting, files,
personal-assistant/Clara-memory, and Voice AI/`vapi_*`), but **only 7 of those are actually wired
into her tool catalog** for the LLM to call:

| Tool | Description | Location |
|---|---|---|
| `pipeline_status` | Open/won/lost deal summary with total value, via `opportunities_list` + `contacts_list`. | intent.ts:998 |
| `deal_lookup` | Finds a specific deal by name (client-side filter over `opportunities_list`). | intent.ts:1057 |
| `invoice_status` | Invoice list/total via `invoices_list` (read-only). | intent.ts:1085 |
| `check_availability` | (listed above, calendar) | intent.ts:1115 |
| `book_appointment` | (listed above, calendar) | intent.ts:1136 |
| `add_contact_note` | Writes a note to a CRM contact record via `contact_notes_create`, after resolving via `contacts_list`. | intent.ts:1168 |
| `crm_lookup` | Searches CRM contacts by name/email/company via `contacts_list`. | intent.ts:1234 |

`create_deal`/`move_deal_stage` are explicitly, deliberately absent (comment at intent.ts:993 — no
`pipelines_list`/`stages_list` tool to resolve required ids from a name). The remaining ~210
allow-listed CRM tool names are reachable **only** via the CLI path (`osCliAllowedTools()` in
`osClient.ts:77`, used when CLARA reasons via a spawned `claude -p`), not via the model tool-loop
in intent.ts — a wider, differently-governed surface than the conversational router.

CLARA also holds a **second** orion identity, `clara@example.com`
(`src/lib/clara/osAgentClient.ts`), used only for the scheduled agent-task poll loop — allow-listed
to 10 tools (`agent_whoami`, `agent_tasks_poll`, `agent_run_report`, `agent_run_deliver_confirm`,
`agent_run_extend_lease`, `team_message_send`, `team_channels_list`, plus the 4 approvals-bridge
tools). This is infrastructure, not something the conversational router exposes.

## Business/Public Persona

CLARA has a hard-separated **second identity**, `CLARA_BUSINESS_IDENTITY`
(`src/lib/clara/persona.ts:79`), used for `example.com` chat and the business phone line.
Verified in `src/lib/clara/business-call-brain.ts`: this path calls the chat completion endpoint
with **no `tools` parameter at all** — it is pure conversation (take a message, offer to book,
never invent prices/policies, never reveal internal systems). It cannot execute any tool above; it
is explicitly barred from mentioning the owner's personal life, FRIDAY, the owner-facing persona, or
CLARA's own architecture. Selection is via `identityFor(audience)`, defaulting to `"business"` on
any resolution failure (fail-closed toward privacy).

Supporting (non-model-invoked) functions used only in this business/inbound-call pipeline:
- `fileInboundCallLead` / `finalizeInboundCall` (`src/lib/clara/leads.ts:90,163`) — files a lead/note from an inbound call.
- `noteInbound` / `contextFor` / `decide` / `scoreUrgencyFromContent` (`src/lib/clara/screening.ts`) — call-screening logic (route to the owner vs. handle as Clara).
- DNC handling: `isOnDnc`, `addToDnc`, `removeFromDnc`, `matchOptKeyword` (`src/lib/clara/dnc.ts`).

## Voice / Phone

Not model tool-calls — backend functions invoked directly by Twilio webhook routes
(`src/app/api/channels/twilio/*`):

| Function | Description | Location |
|---|---|---|
| `sendSMS` | Sends an SMS via Twilio. | `src/lib/clara/channels.ts:28` |
| `placeCall` | Places an outbound call via Twilio. | `src/lib/clara/channels.ts:48` |
| `elevenTTSAudio` / `elevenTTSDataUrl` | ElevenLabs TTS synthesis, tone-parameterized per audience (`toneFor()` in persona.ts:127 — different stability/similarity/style for the owner/vendor/stranger). | `src/lib/clara/channels.ts:174,208` |
| `twilioSignatureValid` / `ttsSign` / `ttsSigValid` | Inbound-webhook and TTS-request signature verification. | `src/lib/clara/channels.ts:127,151,155` |
| `respond()` (telephony.ts) | Live in-call conversational turn for inbound/screening calls; plain chat, not tool-calling. | `src/lib/clara/telephony.ts:112` |
| `finalizeRecording` | Finalizes/stores a call recording (with the mandatory `RECORDING_DISCLOSURE`). | `src/lib/clara/recorder.ts:51` |

Once a call routes into `runIntent()`, the caller gets the exact same `TOOLS` catalog as chat/SMS
(scoped by `ctx.principal`/tiers) — nothing in the voice pipeline is directly LLM-invocable beyond
that.

## Morning call (08:30)

Clara rings the owner every working day at `CLARA_MORNING_CALL` (default `08:30`, `off` disables), reads
the brief as speech, then stays on the line as a two-way conversation on the same router and memory as
SMS/chat/email. One retry after a no-answer (15 minutes later, before 09:30), never a third. No `<Record>`.

| Piece | What it does | Location |
|---|---|---|
| `morning-call` job | Places the call (detached, catch-up bounded to before 10:00). | `src/lib/clara/scheduler.ts` |
| `owner-call-retry` job | Every 5 min before 10:00, places the single retry when `retryAt` is due. | `src/lib/clara/scheduler.ts` |
| `placeMorningCall` / `morningCallTick` | Derives the destination from config (must equal `OWNER_PHONE`), builds the spoken script from the brief model, dials with machine detection. | `src/lib/clara/owner-call.ts` |
| `handleOwnerTurn` | Decision fast path → router (12 s budget, slow tools deferred and texted) → conversation; persists every turn to the owner thread. | `src/lib/clara/owner-call.ts` |
| `finalizeOwnerCall` | Recap email "Call notes — <date>" + ledger. | `src/lib/clara/owner-call.ts` |
| `POST /api/channels/twilio/owner-call` | Twilio voice webhook; identity = outbound call to the session's number, never `From`. | `src/app/api/channels/twilio/owner-call/route.ts` |
| `POST /api/channels/twilio/owner-call/status` | End-of-call callback: retry or finalize. | `src/app/api/channels/twilio/owner-call/status/route.ts` |
| `POST /api/brief/call` `{dry?: boolean}` | Authenticated manual trigger; `dry` never counts as today's call and sends no recap. | `src/app/api/brief/call/route.ts` |

Env: `CLARA_MORNING_CALL` (HH:MM or off), `CLARA_MORNING_CALL_WEEKENDS` (on/off), `CLARA_HOLIDAYS` (comma list of YYYY-MM-DD),
`CLARA_PUBLIC_WEBHOOK_BASE` (required — Twilio must reach the webhooks), `OWNER_PHONE`. Adding the two webhook paths to the host gate
requires a `next build`.

## Misc / Utility

| Tool | Description | Location |
|---|---|---|
| `get_weather` | Forecast for home or a named place, via Google Maps geocoding. | intent.ts:83 |
| `find_contact` | Searches the owner's address book (vault/contacts, synced from Google Contacts) — phone/email/birthday. Deliberately separate from `crm_lookup`. Only CLARA (of the agents) has this. | intent.ts:1206 |
| `vendor_quotes` | Shortlists vendors for a job category and queues an approval before anyone is contacted. | intent.ts:546 |

## Google OAuth Scopes

Source: `src/lib/clara/google-auth.ts:35-73`. One account slot (`work`).
The owner's personal Gmail (named in the git-ignored owner profile) is explicitly **not** a slot — excluded by policy
(`google-auth.ts:10`, and reiterated in `persona.ts` under "What you don't touch").

**`work` slot** (the owner's work Google account):
- `https://www.googleapis.com/auth/gmail.readonly`
- `https://www.googleapis.com/auth/gmail.send`
- `https://www.googleapis.com/auth/gmail.modify`
- `https://www.googleapis.com/auth/gmail.settings.basic` (server-side filters — needs re-consent to take effect on existing refresh tokens, per code comment)
- `https://www.googleapis.com/auth/calendar`
- `https://www.googleapis.com/auth/tasks`
- `https://www.googleapis.com/auth/contacts` (full, not `.readonly` — two-way sync writes back)
- `https://www.googleapis.com/auth/drive`
- `https://www.googleapis.com/auth/drive.activity.readonly`
- `https://www.googleapis.com/auth/documents`
- `https://www.googleapis.com/auth/spreadsheets`
- `https://www.googleapis.com/auth/presentations`
- `https://www.googleapis.com/auth/userinfo.email`, `userinfo.profile`, `openid`

## MCP Servers

Only one MCP server is configured (`.mcp.json`):

```json
{ "mcpServers": { "orion": {
  "type": "http", "url": "http://127.0.0.1:3100/mcp",
  "headers": { "Authorization": "Bearer ${ORION_JWT}" }
}}}
```

CLARA connects with **two separate identities**:
1. `osClient` (`src/lib/clara/osClient.ts`) — authenticates **as the owner's account**, allow-listed to `CLARA_OS_TOOLS` (~217 tool names — see "CRM" above). Backs the 7 wired tools plus the much larger CLI-path allowlist.
2. `osAgentClient` (`src/lib/clara/osAgentClient.ts`) — authenticates as the separate `clara@example.com` agent account, allow-listed to 10 tools for the scheduled agent-task poll loop only.

Both are the same underlying `OsMcpClient`/`OsAuth` wrapper from `@autom8ionlab/agent-core`; the
tool names themselves are defined server-side in the orion MCP server (not in this repo) — the
allowlists here are client-side filters over that full 217+ tool surface, not the tool definitions
themselves.

No other MCP servers are referenced anywhere in the CLARA codebase — Gmail/Calendar/Drive/Tasks/
Contacts are called directly against Google's REST APIs via the OAuth tokens above, not through MCP.

## Other Third-Party Integrations

| Integration | Used for | Evidence |
|---|---|---|
| **Twilio** | SMS send/receive, inbound/outbound voice calls, call recording, webhook signature verification. Config: `CLARA_TWILIO_ACCOUNT_SID/AUTH_TOKEN/NUMBER`, `CLARA_PUBLIC_WEBHOOK_BASE` (`config.ts:83-86`). | `channels.ts`, `telephony.ts`, `business-calls.ts`, `recorder.ts`, `dnc.ts` |
| **ElevenLabs** | TTS voice synthesis for calls/briefs, tone-parameterized per listener (`persona.ts:toneFor`). Config: `ELEVENLABS_API_KEY`, `CLARA_ELEVENLABS_VOICE_ID` (`config.ts:89-90`). | `channels.ts:162-208`, `briefs.ts`, `research.ts` |
| **Google Workspace (direct REST, not MCP)** | Gmail, Calendar, Tasks, Contacts, Drive, Docs/Sheets/Slides — per the OAuth scopes above. | `google-auth.ts`, `gmail.ts`, `calendar.ts`, `google-drive.ts` |
| **Google Maps API** | Geocoding for `get_weather`'s named-place lookups; also determines "home" via `CLARA_HOME_LAT/LNG`. | `weather.ts`, `config.ts:114-115` |
| **orion (Supabase-backed CRM)** | Sole CRM/business-data backend, reached only via the MCP server above — no direct Supabase client instantiated in CLARA's own code. | `osClient.ts`, `osAgentClient.ts` |
| **FRIDAY** (`127.0.0.1:3737`) | Delegation target for dev/infra/deploy work, plus general "back office" for deep research/drafting. Reached via `friday-bridge.ts`'s interagent inbox. | `friday-bridge.ts`, `routing.ts` |
| **LM Studio (local model)** | Fallback/local-only path for sensitive content that must not leave the machine (`preflight` gate in intent.ts routes sensitive text away from the cloud model). Config: `CLARA_LMSTUDIO_URL/MODEL/EMBED_MODEL` (`config.ts:116-118`). | `config.ts`, `sensitivity.ts` |
| **Whisper / ffmpeg (local binaries)** | Local transcription of call audio, referenced as env-var paths (`CLARA_WHISPER_BIN/MODEL`, `CLARA_FFMPEG_BIN`) — presence confirmed in config only, not independently verified beyond that. | `config.ts:120-122` |

Public exposure (a tunnel or reverse proxy in front of the Twilio/webhook routes) lives at the
deployment layer, not in this repo's application code; `hostGate.ts` decides which routes a
non-loopback host may reach.

---

## OS per-agent settings

The model, voice, persona override, tool allow/deny lists, limits, and pause/disable switch can be
set from the OS (Settings → AI Agents → CLARA, plus her subagents). A Google Gemini model needs
`GEMINI_API_KEY`. See [agent-settings.md](agent-settings.md) for what each setting changes and
which env vars to set.

## Accuracy notes

- **Confident, directly verified in code**: the `TOOLS` array in `intent.ts`, the Google
  OAuth scope list, `.mcp.json`'s single server entry, both `CLARA_OS_TOOLS`/`CLARA_OS_AGENT_TOOLS`
  allowlists, the business-persona's tool-free chat call, Twilio/ElevenLabs config keys and call sites.
- **Worth keeping straight**: "allow-listed CRM tool" (~217 names CLARA's MCP client is *permitted*
  to call) vs. "wired CRM tool" (7 names actually exposed to the router LLM with a schema). The
  other ~210 are reachable only through the separate CLI (`claude -p`) path in `osClient.ts:57-79`,
  which reasons freely with no tier-table check in front of it.
- **Not independently verified**: the actual tool names/schemas registered server-side inside the
  orion MCP server itself (source isn't in this repo — only client-side allowlists and CLARA's own
  call sites were inspected). Whisper/ffmpeg/LM Studio confirmed only as configured, not exercised.
