# OS per-agent settings (Settings → AI Agents → CLARA)

CLARA reads her effective configuration from the OS at
`POST <ORION_SUPABASE_URL>/functions/v1/agent-settings-get` with her OS JWT and body
`{ "agent": "clara", "include_subagents": true }`. Code: `src/lib/clara/agentSettings.ts`.

- Cached for 60s; a stale cache is served at once and refreshed in the background. Only the
  first read after boot waits, for at most 2.5s. The fetch times out after 15s.
- If the OS is down, she isn't signed in, or the response is malformed, CLARA keeps the last good
  settings. With none, she uses her built-in defaults. A settings failure never blocks or crashes her.
- JWT: the clara@ agent session (`osAgentClient`) when it's signed in, else her main OS session (`osClient`).
- Null or absent fields mean "built-in default". Settings can only **narrow** what the code allows.

## What each setting does

| Setting | Where it applies | Rule |
|---|---|---|
| `status` paused/disabled | intent router (polite refusal), every direct model call (returns no answer, so each site's canned fallback runs), scheduler (holds every job except `voice-health` and `imessage-relay-health`, one notice a day), `run_subagent` (a paused subagent isn't started) | Refusals get logged to the ledger when they start and when they stop |
| `model.primary` / `model.fallback` | router (`intent.ts`), direct call sites (`modelCall.ts`), `claude` engine (`engines.ts`) | Tried in order: primary → fallback → the site's built-in model (→ Claude CLI for the router). Used only when it was set for CLARA herself (`source` agent/parent), the model is available, and the provider is `anthropic` or `google`. An org-default model is ignored |
| `voice.voice_id` / `voice.settings` | ElevenLabs TTS (`channels.ts`) | An available voice set explicitly for CLARA wins over `CLARA_ELEVENLABS_VOICE_ID`. Numeric `stability`, `similarity_boost` and `style`, plus `use_speaker_boost`, override the tone defaults |
| `prompts.persona_override`, `persona_mode`, `templates` | `persona.ts` (`principalIdentityWithSoul`, `identityFor`), subagent soul text | `append` adds a block for every audience. `replace` only affects the owner (principal) path: soul constitution → override → `CLARA_SAFETY_CORE`. For the business and work-line audiences it falls back to `append` |
| `tools.allowed` / `tools.denied` | router catalog, subagent rosters, OS MCP client and CLI `--allowedTools` | code list ∩ allowed − denied. For the MCP namespace, `denied` always applies. `allowed` applies only when it names at least one MCP tool, because the OS UI lists intent-tool names |
| `limits.max_turns` | router loop (built-in 6) | lower of the two wins |
| `limits.max_tokens` | router (1200), every direct site (its own cap), Gemini engine step (4096) | lower of the two wins |
| `limits.daily_budget_usd` | `usage.ts` general ($15) and prospecting ($40) day caps; direct calls refuse once spend reaches it | lower of the two wins. Only enforced on calls when the OS sets it |
| `limits.max_calls_per_day` | `usage.ts` per-job daily call ceiling (`CLARA_JOB_MAX_CALLS`, 300) | lower of the two wins |
| `limits.rate_limit_per_minute` | router turns + direct model calls (sliding 60s window, per process) | over the limit means a polite refusal or no answer |
| `require_approval` | router gate (CLARA's or the subagent's flag) | every non-read-only tool queues for approval, including the owner's own asks |
| `subagents["clara.<id>"]` | `run_subagent` | Status, model, tools, limits, require_approval and persona come from the subagent's own entry. The OS already narrows it by the parent. A subagent with no entry uses CLARA's |

Cost-tier sites keep their pinned cheap model even when the OS picks another one: mail triage
(Haiku), prospecting tier 1/2 (Haiku). Status, budget, rate and token limits still apply to them.
Prospecting tier 3 does honour the model setting.

## Gemini

When the effective provider is `google`, CLARA calls Gemini's REST `generateContent` directly
(`src/lib/clara/gemini.ts`):

- **Direct call sites**: plain text generation.
- **Intent router**: the full tool loop. Anthropic tool definitions, `tool_use` and `tool_result`
  are translated to Gemini `functionDeclarations`, `functionCall` and `functionResponse`, and back.
  Thought signatures are preserved. If a Gemini turn fails, the next model in the chain takes over.
- **`claude` engine step**: plain completions with no OS tools and no writes go to Gemini first.
  Runs that need tools or writes stay on the Claude CLI.

Env:

| Variable | Purpose |
|---|---|
| `GEMINI_API_KEY` (or `GOOGLE_AI_API_KEY`) | Google AI Studio key. Required for any Gemini call; without it a Gemini setting is skipped (logged) and the next model is used. `agent-settings-get` never returns keys |
| `CLARA_GEMINI_THINKING_TOKENS` | Extra output budget for thinking models, added to each call's cap (default 1024; 0 disables) |
| `CLARA_AGENT_SETTINGS=off` | Ignore the OS settings entirely (built-in defaults) |
| `ORION_SUPABASE_URL` | Orion's Supabase project URL, e.g. `https://<project-ref>.supabase.co` (required for OS settings) |

Gemini spend goes into the model-call ledger as engine `google`. It's priced conservatively in
`usage.ts`, so budgets over-count rather than under-count.
