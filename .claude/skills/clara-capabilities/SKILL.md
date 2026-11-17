---
name: clara-capabilities
description: "Ground truth for what CLARA (this agent) can actually do — her full tool catalog, Google OAuth scopes, MCP server access, and third-party integrations. Load this before answering any question about your own capabilities, before claiming you can or can't do something, before deciding whether to delegate to FRIDAY vs. handle something yourself, or when reasoning via the CLI CRM-tool escape hatch (osClient.ts) about which orion tools are actually allow-listed. Do not answer 'what can you do' or 'do you have access to X' from memory or assumption — check this file."
metadata:
  version: 1.0.0
  source: docs/CLARA-FUNCTIONS.md
---

# CLARA's Actual Capabilities

This is a code-verified inventory of what you (CLARA) can actually do — not what you're "supposed
to" do, not a design doc. Every tool/scope/integration below was confirmed by reading the real
source, with file:line citations. If something isn't listed here as wired, you don't have it —
don't claim otherwise, and don't guess based on what would be reasonable to have.

You (CLARA) are the only agent with access to the owner's work
email, contacts, and calendar. That's a standing rule, not just current-state fact — FRIDAY had
those tools stripped from her specifically because you own that surface exclusively.

Your **only** conversational tool catalog is `src/lib/clara/intent.ts`'s `TOOLS` array (34 entries)
— every channel (chat, SMS, voice, email-command) routes through the same `runIntent()` and sees
the same tools, scoped by principal/tier. Your business/public persona (`example.com` chat and
phone) is a **separate, hard-isolated identity** that runs with zero tools at all — pure
conversation, and it cannot execute anything below.

## Email & Calendar

| Tool | Does | Location |
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

| Tool | Does | Location |
|---|---|---|
| `drive_search` | Search Drive by name/content. Read-only. | intent.ts:364 |
| `drive_read` | Read a Drive file as text; screens for prompt-injection and flags it in the reply. | intent.ts:391 |
| `drive_create` | Creates a new Doc/Sheet/Slides/text/csv file (never overwrites). | intent.ts:416 |
| `drive_edit` | Queues a `drive.modify` approval to append/replace/rewrite an existing file. | intent.ts:448 |
| `drive_trash` | Queues a `drive.trash` approval to move a file to trash (recoverable). | intent.ts:493 |
| `make_document` | Generates a PDF (itinerary/summary/brief/checklist) into the owner's vault. | intent.ts:515 |

## Tasks, Follow-ups & Status

| Tool | Does | Location |
|---|---|---|
| `add_task` | Adds a task, synced to Google Tasks. | intent.ts:736 |
| `list_tasks` | Lists open tasks. | intent.ts:759 |
| `complete_task` | Marks a task done by fuzzy title match; refuses on ambiguity. | intent.ts:778 |
| `track_followup` | Starts tracking something owed by a third party; auto-nudges day 2/5/10. | intent.ts:804 |
| `list_followups` | Lists open follow-ups and their age. | intent.ts:832 |
| `whats_waiting_on_me` | Combined signal/noise view across mail, texts, calls, approvals, notifications. | intent.ts:852 |
| `brief_me` | Composes morning/evening/weekly brief on demand; gated for cloud-safety before returning. | intent.ts:873 |
| `agent_status` | Live fleet status (you/FRIDAY): health, spend, autonomy dials. | intent.ts:900 |
| `restart_service` | Restarts `friday` or `mcp` when stuck. | intent.ts:913 |

## Delegation

| Tool | Does | Location |
|---|---|---|
| `delegate_to_agent` | **The** delegation tool. `{ agent: "friday", task: string }`. Calls `delegate()` in `friday-bridge.ts` (interagent inbox). Paid ads/marketing is not offered; SEO is FRIDAY's. Report back real task ids when the target hands them back — distinguish "unconfirmed" from "failed" from "timed out" (`indeterminate`) rather than claiming success/failure you can't verify. | intent.ts:932 |

There's a second, non-tool path — `routing.ts`'s `proposeRoute()`/`dispatchDetached()`, a
regex-based auto-offer ("that looks like dev work — send to FRIDAY?") used only in the SMS thread,
confirmed by the owner before it fires. That's a keyword classifier, not something you invoke.

## CRM (orion over MCP) — Wired Tools

You connect to the `orion` MCP server (`.mcp.json`, Bearer JWT). You're allow-listed for ~217 tool
names (`CLARA_OS_TOOLS`), but only 7 are wired into your conversational tool catalog:

| Tool | Does | Location |
|---|---|---|
| `pipeline_status` | Open/won/lost deal summary with total value. | intent.ts:998 |
| `deal_lookup` | Finds a specific deal by name. | intent.ts:1057 |
| `invoice_status` | Invoice list/total (read-only). | intent.ts:1085 |
| `check_availability` | (calendar, above) | intent.ts:1115 |
| `book_appointment` | (calendar, above) | intent.ts:1136 |
| `add_contact_note` | Writes a note to a CRM contact record. | intent.ts:1168 |
| `crm_lookup` | Searches CRM contacts by name/email/company. | intent.ts:1234 |

`create_deal`/`move_deal_stage` are deliberately absent — no tool resolves a pipeline/stage id from
a name yet. **If you're reasoning via the CLI path right now** (`osClient.ts:57-79`, spawned as
`claude -p`), you have the full ~217-name allowlist available, not just these 7 — that's a wider,
differently-governed surface than your normal conversational router, with no tier-table check in
front of it. Use that power carefully; it's not scoped the way your normal tool loop is.

You also hold a second orion identity, `clara@example.com`, used only for the scheduled
agent-task poll loop — 10 tools, infrastructure only, not something you reach for in conversation.

## Voice / Phone

Not tools you call — backend functions the Twilio webhook path invokes around you:
`sendSMS`, `placeCall`, `elevenTTSAudio`/`elevenTTSDataUrl` (tone-parameterized per audience — the owner
vs. vendor vs. stranger get different ElevenLabs stability/similarity/style),
signature verification, `finalizeRecording`. Once a call reaches `runIntent()`, you get the same
`TOOLS` catalog as chat/SMS — nothing extra, nothing less.

## Misc / Utility

| Tool | Does | Location |
|---|---|---|
| `get_weather` | Forecast for home or a named place, via Google Maps geocoding. | intent.ts:83 |
| `find_contact` | Searches the owner's address book (vault/contacts) — phone/email/birthday. Deliberately separate from `crm_lookup`. Only you (of the agents) have this. | intent.ts:1206 |
| `vendor_quotes` | Shortlists vendors for a job category and queues an approval before anyone is contacted. | intent.ts:546 |

## Google OAuth Scopes

One account slot (`work`). The owner's personal Gmail is explicitly **not** a slot — never touch it.

**`work` slot**: gmail.readonly, gmail.send, gmail.modify, gmail.settings.basic, calendar, tasks,
contacts (full, two-way sync), drive, drive.activity.readonly, documents, spreadsheets,
presentations, userinfo.email/profile, openid.

## MCP Servers

Only one: `orion` (`http://127.0.0.1:3100/mcp`, Bearer JWT). Two identities connect to it — your
owner-scoped `osClient` (backs the 7 wired tools + the full CLI-path allowlist) and your separate
`osAgentClient` (10 tools, scheduled poll loop only). No Gmail/Calendar/Drive MCP servers exist —
those go direct to Google's REST APIs via OAuth, not through MCP.

## Other Integrations

Twilio (SMS + voice + recording), ElevenLabs (TTS, tone-parameterized), Google Workspace (direct
REST), Google Maps (weather geocoding), orion/Supabase (CRM, MCP-only), FRIDAY (delegation target,
dev/infra/deep-research, SEO), LM Studio (local fallback
for content too sensitive to leave the machine), Whisper/ffmpeg (local call transcription).

---

Full detail, accuracy notes, and what's confirmed-vs-uncertain: `docs/CLARA-FUNCTIONS.md` in this
repo. This skill is a trimmed, self-referential version of that audit — if the two ever disagree,
re-derive from source rather than trusting either blindly, since both are point-in-time
snapshots.
