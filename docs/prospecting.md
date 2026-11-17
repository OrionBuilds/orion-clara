# Prospect intelligence engine (Clara)

Research → enrichment → outreach for local-business prospecting (built and tested on home-service
trades such as roofing).

## What it is

- `src/lib/clara/prospecting/` — the pure core (types, jobSpec, planner, estimator, priors),
  effects (budget, ledger, cache, concurrency, osBridge, llm, discovery, entity resolution,
  report), the orchestrator + stage registry, and the conversational tools
  (`prospect_plan/start/status/pause/resume/cancel/budget_add/export`).
- `scheduler.ts` job `prospecting-orchestrator` — every minute, detached, drains ≤50s per tick.
- `/api/prospects/*` write routes for the Office app (interagent-authenticated).

## Orion dependency

Jobs, companies, tasks, provider requests and prospect lists live in Orion (the business OS) and are
reached through its MCP prospecting tools. Every OS call goes through `osBridge.ts`, which throws
`OsProspectingUnavailableError` when the Orion side is missing; stages, the orchestrator, the
intent tools and the API routes catch that and degrade to an honest "not live yet" message:

- `prospect_plan` / `/api/prospects/research/estimate` still work (no OS table needed), but the
  draft job isn't saved, so `/research/run` has nothing to start.
- The orchestrator tick is a safe no-op once it tries to claim tasks.
- `prospect_status`/`export` report "no prospecting jobs yet" rather than erroring.

## Modes

- `CLARA_PROSPECTING=off|shadow|active` (default **shadow**). `off`: the scheduler job and every
  tool are no-ops. `shadow`: plans and estimates normally; discovery only uses cached results or the
  $0 Exa-via-FRIDAY path — Places/Brave (both real per-call spend) are skipped on a cache miss. No
  paid calls, no delivery. `active`: the real thing, bounded by each job's own `budget_usd` and the
  day-wide `CLARA_PROSPECT_DAY_MAX_USD` ledger.
- `CLARA_PROSPECT_TIER2_ENGINE=lmstudio|haiku` (default `lmstudio`) — switches bulk
  extraction/classification to Haiku 4.5 when LM Studio is down or the owner wants speed.

## Env vars

| Var | Default | Notes |
|---|---|---|
| `CLARA_PROSPECTING` | `shadow` | `off`\|`shadow`\|`active` |
| `CLARA_PROSPECT_TIER2_ENGINE` | `lmstudio` | `lmstudio`\|`haiku` |
| `CLARA_PROSPECT_DAY_MAX_USD` | `40` | cross-job daily spend cap; grant more via the existing SMS grant path (`grantIncrease("prospectBudget", amount, grantedBy)`) |
| `CLARA_PROSPECT_OPUS_MODEL` | `claude-opus-5` | tier-3 model id |
| `CLARA_PROSPECT_HAIKU_MODEL` | `claude-haiku-4-5` | tier-2 paid-fallback model id |
| `ORION_MCP_URL` | (shared with the rest of Clara's OS wiring) | same OS MCP endpoint; no new var needed |
| `CLARA_GOOGLE_MAPS_API_KEY`, `CLARA_BRAVE_SEARCH_API_KEY` | — | discovery uses Clara's Places/Brave keys |
| `ANTHROPIC_API_KEY` | — | tier-3 calls, same key every other direct-Anthropic module uses |
| `CLARA_ICP_DRIVE_ID` | (unset) | optional Drive id of your ideal-customer-profile doc; the planner grounds on its snapshot |
| `CLARA_LEADMAGIC_API_KEY`, `CLARA_HUNTER_API_KEY`, `CLARA_APOLLO_API_KEY` | (unset) | optional contact-finding providers; a missing key skips that rung of the waterfall |

## Smoke test (no Orion tables required)

```
curl -s http://127.0.0.1:3939/api/prospects/research/estimate \
  -H 'content-type: application/json' \
  -d '{"request":"roofing companies within 50 miles of Tampa"}' | jq
```

Expect `{"ok": true, "spec": {...}, "description": "...", "estimate": {"total": <number>, ...}}`.
`job_id` will be absent until the OS `research_jobs` table exists.
