// Clara — durable in-process scheduler.
//
// Runs inside the Next.js server process itself (started once via instrumentation.ts), so it
// works the moment the server is running (ideally under a process supervisor that restarts it) —
// it doesn't depend on any external cron tool, Claude Code session, or MCP server still being
// alive.
//
// Checks every minute against each job's target time; a per-job "last fired" date guards
// against double-firing within the same minute and against Next dev-mode hot-reload
// re-registering a second interval.
//
// Fire history is PERSISTED (dataDir/scheduler-state.json, write-through with tmp+rename) so a
// restart doesn't forget what already ran, and fixed-time jobs marked `catchUpDaily` re-fire once
// if their time already passed today but their last recorded fire was on an earlier day —
// SAME-DAY ONLY, never a replay of yesterday. Fixes the silently-skipped 07:00 brief when the
// service restarts at 07:03. The first tick runs immediately on boot (after state load) rather
// than waiting up to 60s for the interval.

import { localDayKey } from "./usage";
import { promises as fs } from "node:fs";
import path from "node:path";
import { loadConfig } from "./config";
import { composeMorningBrief, composeEveningBrief, composeWeeklyReview, deliverBrief, composeWeeklyAudioDigest } from "./briefs";
import { tickAndNudge } from "./followups";
import { consolidateAll } from "./consolidate";
import { reindexAll } from "./memory";
import { rebuildLinkIndex, indexExists } from "./wikilinks";
import { transcribePending } from "./transcribe";
import { flushOutboundQueue } from "./outbound";
import { flushNotifyDigest } from "./notify";
import { syncTasks } from "./ms-tasks";
import { syncContacts } from "./ms-contacts";
import {
  scanCalendarConflicts, scanTaskDeadlines, scanWeather, scanDriveActivity,
} from "./alerts";
import { callTime, isCallDay } from "./owner-call";

interface Job {
  name: string;
  // Returns true if `now` matches this job's fire time.
  matches: (now: Date) => boolean;
  run: () => Promise<unknown>;
  // tick() awaits jobs sequentially, so one slow job delays every job after it in the array AND
  // the next tick. That's fine for everything that finishes in seconds, but NOT for audio
  // generation, which has a 15-minute ceiling — running it inline would stall outbound-flush
  // (every 5 min), deadline-scan (hourly), and all three sync jobs behind it. Detached jobs are
  // started and left to finish on their own.
  detached?: true;
  // Fixed-time jobs only: if this job's time already passed TODAY (weekly jobs: only on their
  // matching weekday) and the persisted last-fired day isn't today, fire once on the next tick.
  // Never replays a previous day. %-interval jobs don't need it — they come around on their own.
  catchUpDaily?: true;
  // With catchUpDaily: don't catch up once this local hour has been reached. A brief EMAIL at noon
  // is still useful; a brief CALL at 15:00 after a restart is not — the owner asked for 08:30.
  catchUpUntilHour?: number;
}

const JOBS: Job[] = [
  // Overnight shift (JARVIS-pivot Track B): drain the deep-work queue one job at a time. Detached
  // because a single job legitimately runs up to an hour; the module's own in-process guard makes
  // overlapping ticks no-ops, and its lock keeps other processes off the shift. Gated by
  // CLARA_OVERNIGHT (default on; "off" is the kill switch).
  {
    name: "overnight-worker",
    detached: true,
    // Every 5 min (was 2): the worker is detached with its own in-process guard, and the 2-min
    // cadence was a third of the daily job budget by itself (2026-09-24).
    matches: (n) => n.getMinutes() % 5 === 0 && (process.env.CLARA_OVERNIGHT ?? "on").trim().toLowerCase() !== "off",
    run: async () => {
      const { runOvernightWorkerTick } = await import("./deepwork");
      return runOvernightWorkerTick((m) => console.log(`[clara-scheduler] overnight: ${m}`));
    },
  },
  // OS-scheduled agent tasks — pull due work from orion every minute, run CLARA's handlers,
  // report back. Gated by CLARA_OS_TASKS (off|shadow|active, default shadow). Fires each minute
  // when not off; the OS carries the real cadence + per-schedule mode. Dynamic import so a poll
  // failure never affects CLARA's other jobs.
  {
    name: "os-agent-tasks-poll",
    matches: () => (process.env.CLARA_OS_TASKS ?? "shadow").trim().toLowerCase() !== "off",
    run: async () => {
      const { runOsTasksPoll } = await import("./osTasks");
      return runOsTasksPoll((m) => console.log(`[clara-scheduler] ${m}`));
    },
  },
  // Prospect intelligence engine (Part 5 of the prospecting plan) — drains research_tasks in stage
  // order every minute. Detached (a tick can legitimately run up to its own ~50s drain budget) with
  // an in-process guard identical to overnight-worker's (prospectingOrchestratorTick() no-ops on an
  // overlapping call). Gated by CLARA_PROSPECTING=off|shadow|active (default shadow — see types.ts);
  // the tick itself is a one-line no-op when off, so this job firing costs nothing until the owner flips it.
  {
    name: "prospecting-orchestrator",
    detached: true,
    matches: () => true,
    run: async () => {
      const { prospectingOrchestratorTick } = await import("./prospecting/orchestrator");
      const r = await prospectingOrchestratorTick();
      if (r.claimed || r.notes.length) {
        console.log(`[clara-scheduler] prospecting: mode=${r.mode} claimed=${r.claimed} completed=${r.completed} failed=${r.failed} skipped=${r.skipped}${r.notes.length ? " · " + r.notes.join(" | ") : ""}`);
      }
    },
  },
  // LinkedIn daily queue — weekdays 08:00 local: 15–20 owner/decision-maker drafts (connection
  // note + follow-up DM) from promoted companies, emailed to the owner as one digest. Drafts only: Clara
  // never sends on LinkedIn. CLARA_LINKEDIN_QUEUE=off|shadow|active (default shadow — no lookups,
  // no digest). Detached: FRIDAY paces each lookup 45–120 s.
  {
    name: "linkedin-queue",
    detached: true,
    matches: (n) => n.getMinutes() % 15 === 0 && n.getHours() === 8 && n.getDay() >= 1 && n.getDay() <= 5,
    run: async () => {
      const { linkedinQueueTick } = await import("./prospecting/linkedinQueue");
      const r = await linkedinQueueTick();
      if (r) console.log(`[clara-scheduler] linkedin-queue: mode=${r.mode} items=${r.items.length} lookups=${r.lookups} delivered=${r.delivered}${r.notes.length ? " · " + r.notes.join(" | ") : ""}`);
    },
  },
  // Prospect buying-signal scan (PR 17) — standalone, hourly re-check of companies_search results
  // for website/tech changes and review velocity (NOT a research_tasks pipeline stage; see
  // prospecting/stages.ts's `signal_scan` skipStub doc comment for why). The OS-level
  // `clara.prospect_signal_scan` schedule row (migration
  // 20261001100300_prospect_suppressions_roles.sql) is seeded `mode:'off'` with the comment
  // "Clara's local scheduler runs the minute-level work" — THIS is that local work, same
  // relationship prospecting-orchestrator already has to its own (also-inert) OS schedule row.
  // Gated by CLARA_SIGNAL_SCAN (default "shadow" — matches prospectingMode()'s off|shadow|active
  // convention in prospecting/types.ts: shadow plans/diffs/writes facts but never makes a paid
  // Places Details call; "off" is the kill switch; "active" is the real thing). Detached + dynamic
  // import, same reasons as prospecting-orchestrator.
  {
    name: "prospect-signal-scan",
    detached: true,
    matches: (n) => n.getMinutes() % 60 === 0 && (process.env.CLARA_SIGNAL_SCAN ?? "shadow").trim().toLowerCase() !== "off",
    run: async () => {
      const { signalRefreshTick } = await import("./prospecting/signals/refresh");
      const r = await signalRefreshTick();
      if (r.scanned || r.notes.length) {
        console.log(`[clara-scheduler] signal-scan: scanned=${r.scanned} fired=${r.signals_fired} budget_stopped=${r.budget_stopped}${r.notes.length ? " · " + r.notes.join(" | ") : ""}`);
      }
    },
  },
  // Prospect CRM promotion watcher (PR 12, plan §25) — every 30 min, scans every active (non-
  // archived) prospect list for companies at/above prospect_settings.crm_threshold (default 75)
  // not yet promoted (companies.contact_id IS NULL) and promotes them: companies_promote (idempotent
  // contact+opportunity in Sales / Prospecting) + a best-effort Drive research doc + call brief. Runs
  // under the SAME off|shadow|active gate as the rest of the engine (prospectingMode(), not its own
  // env var) — shadow counts candidates but never actually promotes, since a CRM write is exactly
  // the kind of visible side effect a fresh/shadow deploy must never make on its own. Detached +
  // dynamic import, same reasons as prospecting-orchestrator/prospect-signal-scan above.
  {
    name: "prospect-promotion-watcher",
    detached: true,
    matches: (n) => n.getMinutes() % 30 === 0,
    run: async () => {
      const { prospectPromotionWatcherTick } = await import("./prospecting/promote");
      const r = await prospectPromotionWatcherTick();
      if (r.candidates || r.notes.length) {
        console.log(`[clara-scheduler] promotion-watcher: mode=${r.mode} lists=${r.listsScanned} candidates=${r.candidates} promoted=${r.promoted} failed=${r.failed}${r.notes.length ? " · " + r.notes.join(" | ") : ""}`);
      }
    },
  },
  // Prospect sequence runner (PR 14, plan §38/Part 6) — every 5 min, generalizes scorecardDrip.ts's
  // RPC -> gate -> render -> send -> write-back shape to the full enrollment state machine
  // (sequenceRunner.ts). Gated by its OWN env var, CLARA_PROSPECT_SEQUENCES=off|shadow|active
  // (default shadow — shadow renders/logs what would send, including a real tier-3 personalization
  // call, but never actually sends). Detached + dynamic import, same reasons as every other
  // prospecting job above.
  {
    name: "prospect-sequence-runner",
    detached: true,
    matches: (n) => n.getMinutes() % 5 === 0,
    run: async () => {
      const { sequenceRunnerTick } = await import("./prospecting/sequenceRunner");
      const r = await sequenceRunnerTick();
      if (r.due || r.notes.length) {
        console.log(`[clara-scheduler] sequence-runner: mode=${r.mode} due=${r.due} sent=${r.sent} skipped=${r.skipped} blocked=${r.blocked} tasks=${r.taskCreated} calls=${r.callPlaced}${r.notes.length ? " · " + r.notes.join(" | ") : ""}`);
      }
    },
  },
  // Prospect reply detection (PR 16, plan Part 6 §4) — every 10 min: Gmail search
  // `newer_than:2d -label:Clara/Prospects`, resolve to an enrollment, classify, route. The SMS side
  // of reply detection is NOT a scheduler job — it runs synchronously inside the Twilio inbound SMS
  // webhook (src/app/api/channels/twilio/sms/route.ts calls handleInboundSmsReply directly), same
  // as every other inbound-SMS lane in that route.
  {
    name: "prospect-reply-detection",
    detached: true,
    matches: (n) => n.getMinutes() % 10 === 0,
    run: async () => {
      const { repliesTick } = await import("./prospecting/replies");
      const r = await repliesTick();
      if (r.scanned || r.notes.length) {
        console.log(`[clara-scheduler] reply-detection: scanned=${r.scanned} matched=${r.matched} interested=${r.routed.interested} questions=${r.routed.question} unknown=${r.routed.unknown}${r.notes.length ? " · " + r.notes.join(" | ") : ""}`);
      }
    },
  },
  // Weekly prospecting report — Monday 07:45, a Drive doc emailed via deliverToPrincipal (plan
  // §7/Part 6). catchUpDaily so a missed Monday (box down, deploy in progress) still sends later
  // the same day rather than silently skipping a whole week.
  {
    name: "prospect-weekly-report",
    catchUpDaily: true,
    matches: (n) => n.getDay() === 1 && n.getHours() === 7 && n.getMinutes() === 45,
    run: async () => {
      const { deliverWeeklyProspectingReport } = await import("./prospecting/weeklyReport");
      const r = await deliverWeeklyProspectingReport();
      console.log(`[clara-scheduler] prospect-weekly-report: ${r.ok ? "delivered" : `failed (${r.error})`}`);
    },
  },
  // Client-email triage (owner rule 2026-08-29) — CLARA is the sole inbound client-email handler:
  // read unread client mail in the owner's inbox, auto-create FRIDAY tasks, and DRAFT a reply in
  // The owner's mailbox (never send). Every ~4 min. Gated by CLARA_CLIENT_TRIAGE (default on; "off" = kill
  // switch). Dynamic import so a failure never affects other jobs.
  {
    name: "client-email-triage",
    matches: (n) => n.getMinutes() % 4 === 0 && (process.env.CLARA_CLIENT_TRIAGE ?? "on").trim().toLowerCase() !== "off",
    run: async () => {
      const { runClientEmailTriage } = await import("./clientEmailTriage");
      return runClientEmailTriage();
    },
  },
  // Portal ticket triage (2026-09-14) — CLARA's intake for client-portal tickets that NO bench owns
  // (FRIDAY triages its own projects' tickets from OS schedules). Every 2 min on odd minutes so
  // it never shares a tick with the email triage or the watcher. Gated by CLARA_PORTAL_TRIAGE
  // (off|shadow|active, default shadow — shadow decides and logs, never writes).
  {
    name: "portal-ticket-triage",
    matches: (n) => n.getMinutes() % 2 === 1 && (process.env.CLARA_PORTAL_TRIAGE ?? "shadow").trim().toLowerCase() !== "off",
    run: async () => {
      const { runPortalTicketTriage } = await import("./portal/triage");
      return runPortalTicketTriage((m) => console.log(`[clara-scheduler] portal: ${m}`));
    },
  },
  // Routing-clarify watch (2026-09-18) — every 5 min, poll both the portal-reply thread and the
  // mirrored clarify email thread for the client's "website/app or ads?" answer, and dispatch
  // whichever answers first (bounded to 2 rounds, then defaults to the owner). See
  // portal/routingClarifyWatch.ts. Gated by the same CLARA_PORTAL_TRIAGE dial as the triage job
  // itself — no separate ask ever happens if portal triage is off.
  {
    name: "routing-clarify-watch",
    matches: (n) => n.getMinutes() % 5 === 2 && (process.env.CLARA_PORTAL_TRIAGE ?? "shadow").trim().toLowerCase() !== "off",
    run: async () => {
      const { pollRoutingClarifyReplies } = await import("./portal/routingClarifyWatch");
      return pollRoutingClarifyReplies();
    },
  },
  // Routing-clarify silence sweep — once/hour: page the owner if a routing-clarify question has gone
  // unanswered for 24h (no SMS nudge available — see routingClarify.ts's file header).
  {
    name: "routing-clarify-silence-sweep",
    matches: (n) => n.getMinutes() === 45,
    run: async () => {
      const { routingClarifySilenceSweep } = await import("./portal/routingClarifyWatch");
      return routingClarifySilenceSweep();
    },
  },
  // Delegation watcher (2026-09-14) — polls every open hand-off in delegations.json and closes the
  // loop: finished work becomes a client update (email / ticket comment) and a note to the owner; parked,
  // failed or receipt-less ones go to the owner only. Even minutes. Gated by CLARA_DELEGATION_WATCH.
  {
    name: "delegation-watch",
    // Every 5 min, offset from overnight-worker (2026-09-24 job-budget trim).
    matches: (n) => n.getMinutes() % 5 === 1 && (process.env.CLARA_DELEGATION_WATCH ?? "on").trim().toLowerCase() !== "off",
    run: async () => {
      const { runDelegationWatch } = await import("./delegationWatch");
      return runDelegationWatch((m) => console.log(`[clara-scheduler] delegations: ${m}`));
    },
  },
  // OS approvals bridge (Wave 3) — pull hub decisions for Clara's local approvals queue and apply
  // them through approvals.ts's own approve()/reject() spine (CAS-safe against local decisions);
  // the first tick after boot also back-mirrors any still-pending local rows into the hub.
  // Gated by CLARA_OS_BRIDGE (default on; "off" is the kill switch) and silently inactive until
  // the one-time clara@ agent sign-in. Dynamic import so a bridge failure never affects other jobs.
  {
    name: "os-approvals-poll",
    matches: () => (process.env.CLARA_OS_BRIDGE ?? "on").trim().toLowerCase() !== "off",
    run: async () => {
      const { runOsApprovalsPoll } = await import("./osApprovalsBridge");
      return runOsApprovalsPoll((m, e) => (e ? console.error(`[clara-scheduler] ${m}`, e) : console.log(`[clara-scheduler] ${m}`)));
    },
  },
  // Briefs COMPOSE then DELIVER. Delivery lives here rather than inside the composers because the
  // /brief page re-composes on every view — emailing on compose would send a copy each time.
  // Morning brief moved 07:00 → 08:00 (Wave 4): the locked chief-of-staff decision is ONE daily
  // 8am executive brief slot.
  { name: "morning-brief", catchUpDaily: true, matches: (n) => n.getHours() === 8 && n.getMinutes() === 0, run: async () => {
    if ((await import("./weeklyPlanning")).claraDailyOwner() === "os") return console.log("[clara-scheduler] morning-brief skipped — CLARA_DAILY_OWNER=os (OS clara.daily_owner_briefing owns delivery)");
    // Prep docs are a prerequisite of the brief (it links them). runMeetingPrep is idempotent, so
    // this is a no-op when 07:30 already ran and the fix for a late start (both catch up at once).
    try { const m = await import("./meetingPrep"); if (m.meetingPrepEnabled()) await m.runMeetingPrep(); } catch (e) { console.warn("[clara-scheduler] meeting-prep before brief failed:", e); }
    return composeMorningBrief().then(deliverBrief);
  } },
  { name: "evening-brief", catchUpDaily: true, matches: (n) => n.getHours() === 20 && n.getMinutes() === 30, run: () => composeEveningBrief().then(deliverBrief) },
  // The 08:30 morning call (owner-comms overhaul, 2026-09-24): Clara rings the owner with the spoken
  // brief and stays on the line. Detached — a call lasts minutes. CLARA_MORNING_CALL=HH:MM|off,
  // weekdays only unless CLARA_MORNING_CALL_WEEKENDS=on, never on a CLARA_HOLIDAYS date. Catch-up is
  // bounded to before 10:00: a missed 08:30 becomes a 09:1x call, never an afternoon one.
  {
    name: "morning-call", detached: true, catchUpDaily: true, catchUpUntilHour: 10,
    matches: (n) => { const t = callTime(); return !!t && isCallDay(n) && n.getHours() === t.hour && n.getMinutes() === t.minute; },
    run: async () => { const r = await (await import("./owner-call")).morningCallTick(); console.log(`[clara-scheduler] morning-call: ${r}`); },
  },
  // The one retry after a no-answer: owner-call.ts stamps retryAt = +15 min; this tick places it.
  // Only before 10:00 and only when a retry is actually due (cheap no-op otherwise). Cap-exempt.
  {
    name: "owner-call-retry", detached: true,
    matches: (n) => n.getMinutes() % 5 === 0 && n.getHours() >= 8 && n.getHours() < 10 && (process.env.CLARA_MORNING_CALL ?? "08:30").trim().toLowerCase() !== "off",
    run: async () => { const r = await (await import("./owner-call")).morningCallTick(); if (!r.startsWith("nothing")) console.log(`[clara-scheduler] owner-call-retry: ${r}`); },
  },
  // Meeting prep (2026-09-24): a Google Doc per external meeting today, filed under Drive Clara/Prep/<date>,
  // before the 08:00 brief so the brief and the 08:30 call can point at it. Detached — model calls.
  { name: "meeting-prep", detached: true, catchUpDaily: true, matches: (n) => n.getHours() === 7 && n.getMinutes() === 30, run: async () => { const m = await import("./meetingPrep"); if (!m.meetingPrepEnabled()) return console.log("[clara-scheduler] meeting-prep skipped — CLARA_MEETING_PREP=off"); const r = await m.runMeetingPrep(); console.log(`[clara-scheduler] meeting-prep prepared=${r.prepared.length} skipped=${r.skipped} failed=${r.failed.length}${r.failed.length ? ` (${r.failed.join("; ")})` : ""}`); } },
  // Single-owner guard (Wave 5): when CLARA_WEEKLY_OWNER=os, the OS clara.weekly_planning handler
  // owns Sunday delivery and this local job stands down (composeWeeklyPlanning is a superset of
  // this review). Default "local" — this job's behavior is unchanged until the env is flipped.
  { name: "weekly-review", catchUpDaily: true, matches: (n) => n.getDay() === 5 && n.getHours() === 16 && n.getMinutes() === 0, run: async () => (await import("./weeklyPlanning")).claraWeeklyOwner() === "os" ? console.log("[clara-scheduler] weekly-review skipped — CLARA_WEEKLY_OWNER=os (OS clara.weekly_planning owns Friday delivery)") : composeWeeklyReview().then(deliverBrief) },
  { name: "followup-tick", catchUpDaily: true, matches: (n) => n.getHours() === 9 && n.getMinutes() === 0, run: () => tickAndNudge() },
  { name: "memory-reindex", catchUpDaily: true, matches: (n) => n.getDay() === 0 && n.getHours() === 3 && n.getMinutes() === 0, run: () => reindexAll() },
  { name: "consolidate",    catchUpDaily: true, matches: (n) => n.getDay() === 0 && n.getHours() === 3 && n.getMinutes() === 15, run: () => consolidateAll() },
  // Wikilink backlinks index. Incremental updates happen on every /vault save (route.ts calls
  // updateFileInIndex directly); this full rebuild catches anything the incremental path missed
  // (files edited in Obsidian, not through the app) — right after memory-reindex/consolidate.
  { name: "link-index-rebuild", catchUpDaily: true, matches: (n) => n.getDay() === 0 && n.getHours() === 3 && n.getMinutes() === 5, run: () => rebuildLinkIndex() },
  // Outbound governor: flush anything queued for quiet hours or held by the breaker, every 5 min.
  { name: "outbound-flush", matches: (n) => n.getMinutes() % 5 === 0, run: () => flushOutboundQueue() },
  // Work-phone texts arrive through BlueBubbles on a Mac (bluebubbles.ts). Ping it every five
  // minutes; after 15 minutes down the owner gets ONE email (never a text), and one when it's back.
  // Work-phone texts waiting on the owner's answer (workTextAsk.ts): send asks held over quiet hours at
  // 07:00, one reminder after 4 business hours, and after 24 hours move it to the callback list.
  { name: "workline-asks", matches: (n) => n.getMinutes() % 5 === 4, run: async () => { const r = await (await import("./workTextAsk")).workAskTick(); if (r !== "nothing due") console.log(`[clara-scheduler] workline-asks: ${r}`); } },
  // ElevenLabs voice health (ttsHealth.ts): a failing provider switches calls to Twilio's voice
  // before a caller hears an error, and the check brings Clara's own voice back when it recovers.
  { name: "voice-health", matches: (n) => n.getMinutes() % 15 === 11, run: async () => { const r = await (await import("./channels")).voiceHealthTick(); if (r !== "ok" && r !== "not configured") console.log(`[clara-scheduler] voice-health: ${r}`); } },
  { name: "imessage-relay-health", matches: (n) => n.getMinutes() % 5 === 2, run: async () => (await import("./bluebubbles")).relayHealthTick() },
  // Readiness-scorecard SMS follow-up (Clara's 4 texts). Every 15 min; the tick itself enforces the
  // 09:00–17:59 America/New_York window and the CLARA_SCORECARD_DRIP off|shadow|active gate, so a
  // restart never fires outside hours. Eligibility + bookkeeping live in the OS (scorecard_drip_* RPCs).
  { name: "scorecard-drip-tick", matches: (n) => n.getMinutes() % 15 === 7, run: async () => { const { scorecardDripTick } = await import("./scorecardDrip"); await scorecardDripTick(); } },
  // Company knowledge sources on Drive: weekly snapshot + "these changed" nudge. Never rewrites
  // knowledge/company.md by itself — see knowledge.ts.
  { name: "knowledge-refresh", catchUpDaily: true, matches: (n) => n.getDay() === 0 && n.getHours() === 3 && n.getMinutes() === 30, run: async () => { const { refreshKnowledgeSources } = await import("./knowledge"); const r = await refreshKnowledgeSources(); console.log(`[clara-scheduler] knowledge-refresh checked=${r.checked} changed=${r.changed.length} failed=${r.failed.length}`); } },
  // Notify digest: send anything batched during quiet hours, once a day right after they end.
  { name: "notify-digest",  catchUpDaily: true, matches: (n) => n.getHours() === 8 && n.getMinutes() === 0, run: () => flushNotifyDigest() },
  // Email as a command channel. Every 3 minutes — email is not an urgent channel and a tighter
  // loop would just burn Gmail quota. NOT catchUpDaily: a command that was missed overnight is not
  // a command any more, and acting on a stale one is worse than ignoring it (runEmailCommands only
  // looks at `newer_than:1d` for the same reason). Fails closed on DMARC — see emailCommands.ts.
  {
    name: "email-commands",
    matches: (n) => n.getMinutes() % 3 === 0,
    run: async () => {
      const { runEmailCommands, summarizeEmailCommands } = await import("./emailCommands");
      const r = await runEmailCommands({ max: 10 });
      // Only speak up when something happened — a quiet channel must stay quiet in the log.
      if (r.handled || r.refused.length || r.failed) console.log(`[clara-scheduler] ${summarizeEmailCommands(r)}`);
    },
  },

  // ── Google sync ────────────────────────────────────────────────────────
  // Tasks change often and are cheap; contacts change rarely and People has tighter quotas.
  // %-interval matching (rather than a fixed minute) means a restart costs at most one window,
  // so the tasks jobs need no catchUpDaily; twice-daily sync-contacts does.
  { name: "sync-tasks-work", matches: (n) => n.getMinutes() % 15 === 0, run: () => syncTasks("work") },
  { name: "sync-contacts",   catchUpDaily: true, matches: (n) => (n.getHours() === 6 || n.getHours() === 18) && n.getMinutes() === 5, run: () => syncContacts("work") },

  // ── Proactive alerts ───────────────────────────────────────────────────
  // Each scan has its own durable dedupe (alerts.ts), so re-running is cheap and won't re-notify.
  { name: "conflict-scan", matches: (n) => n.getMinutes() % 30 === 0 && n.getHours() >= 6 && n.getHours() < 22, run: () => scanCalendarConflicts() },
  { name: "deadline-scan", matches: (n) => n.getMinutes() === 0, run: () => scanTaskDeadlines() },
  { name: "weather-scan",  catchUpDaily: true, matches: (n) => (n.getHours() === 6 && n.getMinutes() === 45) || (n.getHours() === 15 && n.getMinutes() === 0), run: () => scanWeather() },
  { name: "drive-activity-scan", matches: (n) => n.getMinutes() % 15 === 3, run: () => scanDriveActivity() },

  // Detached: audio generation can take 15 minutes. Friday 16:05, just behind weekly-review, which
  // it deliberately does NOT share state with — a second compose is cheap and keeps them uncoupled.
  {
    name: "weekly-audio-digest",
    detached: true,
    catchUpDaily: true,
    matches: (n) => n.getDay() === 5 && n.getHours() === 16 && n.getMinutes() === 5,
    run: () => composeWeeklyReview().then(composeWeeklyAudioDigest),
  },
  // Call transcription (B5): whisper.cpp runs sequentially and can take minutes per call on CPU —
  // detached for the same reason weekly-audio-digest is, so it can never stall outbound-flush or
  // the sync jobs behind it. No-op (fast) when there's nothing pending or whisper isn't installed.
  { name: "transcribe-pending", detached: true, matches: (n) => n.getMinutes() % 10 === 4, run: () => transcribePending() },
  // Meeting digestion (Wispr Flow, then Meet/Gemini docs): each digest is a model call of up to 3
  // minutes, so detached like transcribe-pending. Gated by CLARA_MEETING_INGEST (off|shadow|active,
  // default shadow); the module's own in-process guard makes an overlapping tick a no-op.
  {
    name: "meeting-ingest",
    detached: true,
    matches: (n) => n.getMinutes() % 10 === 6 && (process.env.CLARA_MEETING_INGEST ?? "shadow").trim().toLowerCase() !== "off",
    run: async () => {
      const { runMeetingIngest } = await import("./meetings/ingest");
      return runMeetingIngest();
    },
  },

  // decision-ask (owner-comms overhaul, 2026-09-24) — replaced the SMS aging nudge. Every 15 min:
  // ONE plain-English question by text, only for a money/scope item that can't wait for the 08:00
  // brief (client waiting, expiring within a day, or >2h old in business hours), and only when no
  // question is already open on the SMS channel. Everything else waits for the brief and the 08:30
  // call. No codes anywhere. See decisions.ts runDecisionAsk.
  { name: "decision-ask", matches: (n) => n.getMinutes() % 15 === 0, run: async () => (await import("./decisions")).runDecisionAsk() },
  // Autonomy Spec v0.1 item #8: a client sitting on an out-of-scope-work offer for 30 minutes
  // (the "client waiting" SLA number, item #5) with no reply gets defaulted to "book a call".
  { name: "scope-escalation-timeout", matches: (n) => n.getMinutes() % 5 === 0, run: () => runScopeEscalationTimeouts() },
];

// Autonomy Spec v0.1, item #8 — SLA default for the out-of-scope-work escalation. No sidecar
// stamp needed here (unlike decision-ask, which re-asks on a timer): resolveScopeEscalation
// flips the row's status away from "pending" the moment it runs, even if execute() itself fails,
// so a row can never re-cross this threshold on the next tick — the status transition IS the
// dedupe. 30 minutes flat: this flow always has a real client waiting on the other end.
const SCOPE_ESCALATION_TIMEOUT_MS = 30 * 60_000;
async function runScopeEscalationTimeouts(): Promise<string> {
  const { listPending } = await import("./approvals");
  const { resolveScopeEscalation } = await import("./scopeEscalation");
  const now = Date.now();
  const pending = (await listPending()).filter((a) => a.kind === "scope.out-of-bounds");
  let resolved = 0;
  for (const row of pending) {
    if (now - Date.parse(row.createdAt) < SCOPE_ESCALATION_TIMEOUT_MS) continue;
    await resolveScopeEscalation(row.id, "call").catch((e) =>
      console.error(`[clara-scheduler] scope-escalation-timeout failed for ${row.id}:`, e));
    resolved++;
  }
  return resolved ? `${resolved} defaulted to call` : "none due";
}

// dateKey ties "last fired" to a specific calendar day+HH:mm so a job fires once per matching
// minute, not once per process-lifetime.
function dateKey(now: Date): string {
  return `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}-${now.getMinutes()}`;
}

// Calendar-day key (local) for the SAME-DAY-ONLY catch-up rule.
function dayKey(now: Date): string {
  return `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;
}

// ── Persisted fire history ─────────────────────────────────────────────────
// dataDir/scheduler-state.json, loaded once at startScheduler() and written through (tmp+rename,
// same atomic pattern as every other dataDir store) each time a job is marked fired. A persist
// failure is logged but never blocks the job — the in-memory record still guards this process.
interface FireRecord { key: string; day: string }
let fireState: Record<string, FireRecord> = {};

async function stateFile(): Promise<string> {
  const cfg = await loadConfig();
  await fs.mkdir(cfg.dataDir, { recursive: true });
  return path.join(cfg.dataDir, "scheduler-state.json");
}

async function loadFireState(): Promise<void> {
  try {
    const raw = JSON.parse(await fs.readFile(await stateFile(), "utf8")) as Record<string, FireRecord>;
    if (raw && typeof raw === "object") fireState = raw;
  } catch {
    fireState = {}; // first boot, or unreadable — start fresh (worst case: one same-day catch-up)
  }
}

async function persistFireState(): Promise<void> {
  const p = await stateFile();
  const tmp = `${p}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(fireState, null, 2), "utf8");
  await fs.rename(tmp, p);
}

// True if any minute EARLIER today (strictly before `now`'s minute) matches the job — i.e. its
// fixed time already passed. Weekly jobs' matches() checks getDay(), so probing today's minutes
// naturally returns false on non-matching weekdays. Pure-function scan, ≤1439 cheap calls, and
// only reached at most once per job per day (when the persisted day is stale).
function matchedEarlierToday(job: Job, now: Date): boolean {
  const probe = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  while (probe.getTime() < now.getTime() && (probe.getHours() < now.getHours() || probe.getMinutes() < now.getMinutes())) {
    if (job.matches(probe)) return true;
    probe.setMinutes(probe.getMinutes() + 1);
  }
  return false;
}

// ── Missed fires across a shutdown ─────────────────────────────────────────
// catchUpDaily deliberately never replays a previous day (see tick()) — re-sending yesterday's
// 08:00 brief at noon today would be worse than not sending it. But the old behaviour was to drop
// it *silently*, so an overnight outage looked identical to a normal morning: no brief, no
// explanation, and no way to tell from a phone that anything had been skipped.
//
// This still doesn't replay. It reconstructs which fixed-time jobs *would* have fired on each day
// between the last recorded fire and today, records them, and says so once at boot. Knowing the
// 08:00 brief was skipped is the actionable part; the brief itself is stale by then anyway.

const MAX_LOOKBACK_DAYS = 14; // a longer outage is its own headline — don't grind 1440 probes/day over months

function parseDayKey(s: string): Date | null {
  const [y, m, d] = s.split("-").map(Number);
  if (![y, m, d].every(Number.isFinite)) return null;
  return new Date(y, m, d); // dayKey() stores a 0-based month, so this round-trips
}

/** True if any minute of `day` matches the job — the whole-day form of matchedEarlierToday. */
function matchedOnDay(job: Job, day: Date): boolean {
  const probe = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, 0, 0, 0);
  const end = probe.getTime() + 24 * 60 * 60_000;
  while (probe.getTime() < end) {
    if (job.matches(probe)) return true;
    probe.setMinutes(probe.getMinutes() + 1);
  }
  return false;
}

interface MissedFire { job: string; day: string; recordedAt: string }

async function reportMissedFires(now: Date): Promise<void> {
  const missed: MissedFire[] = [];
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  for (const job of JOBS) {
    if (!job.catchUpDaily) continue;
    const last = fireState[job.name]?.day;
    if (!last) continue; // never fired — first boot, or a wiped dataDir. Not a missed fire.
    const lastDay = parseDayKey(last);
    if (!lastDay) continue;

    // Whole days strictly between the last fire and today. Today itself is catchUpDaily's job.
    const probe = new Date(lastDay.getFullYear(), lastDay.getMonth(), lastDay.getDate() + 1);
    let scanned = 0;
    while (probe.getTime() < today.getTime() && scanned < MAX_LOOKBACK_DAYS) {
      if (matchedOnDay(job, probe)) {
        missed.push({ job: job.name, day: dayKey(probe), recordedAt: now.toISOString() });
      }
      probe.setDate(probe.getDate() + 1);
      scanned++;
    }
  }

  if (!missed.length) return;

  try {
    const cfg = await loadConfig();
    const p = path.join(cfg.dataDir, "missed-fires.json");
    const prior = await fs.readFile(p, "utf8").then((r) => JSON.parse(r) as MissedFire[]).catch(() => []);
    const tmp = `${p}.tmp`;
    // Keep the tail bounded; this is a diagnostic log, not an audit trail.
    await fs.writeFile(tmp, JSON.stringify([...prior, ...missed].slice(-500), null, 2), "utf8");
    await fs.rename(tmp, p);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[clara-scheduler] could not persist missed fires:", e);
  }

  const days = [...new Set(missed.map((m) => m.day))].length;
  const byJob = [...new Set(missed.map((m) => m.job))];
  // eslint-disable-next-line no-console
  console.warn(`[clara-scheduler] ${missed.length} missed fire(s) across ${days} day(s): ${byJob.join(", ")}`);
  const { notifyOwner } = await import("./notify");
  await notifyOwner({
    kind: "scheduler.missed",
    priority: "normal",
    text: `⏰ I was down across ${days === 1 ? "a day" : `${days} days`} and skipped ${missed.length} scheduled job(s): ${byJob.join(", ")}. Not replaying them — they'd be stale. Ask me for a brief if you want the current picture.`,
    dedupeKey: `missedfires:${dayKey(now)}`,
  }).catch(() => {});
}

/** Health checks only: these run even while the OS has CLARA paused/disabled (they do no work). */
const RUNS_WHILE_PAUSED = new Set(["voice-health", "imessage-relay-health"]);
const pausedNoticeSent = new Set<string>();

async function tick(): Promise<void> {
  const now = new Date();
  const key = dateKey(now);
  const day = dayKey(now);
  for (const job of JOBS) {
    let catchUp = false;
    if (!job.matches(now)) {
      // Catch-up path: fixed time already passed today, last recorded fire was an earlier day
      // (or never). Same-day only — yesterday's missed fire is gone by design.
      if (!job.catchUpDaily) continue;
      if (fireState[job.name]?.day === day) continue;
      if (job.catchUpUntilHour != null && now.getHours() >= job.catchUpUntilHour) continue;
      if (!matchedEarlierToday(job, now)) continue;
      catchUp = true;
    }
    if (fireState[job.name]?.key === key) continue; // already fired this exact minute

    // Daily job tripwire. Clara's jobs are fixed-cadence, so this count is near-constant (~837
    // non-exempt fires/day — see usage.ts for the arithmetic) and the cap is NOT a throttle. It
    // exists to catch something re-firing in a loop, and sits ~3x baseline so normal operation
    // never reaches it. A cap near normal would spend its life killing whichever job runs last,
    // which on an ordinary evening is the 20:30 brief.
    //
    // Two jobs are exempt and always run. os-agent-tasks-poll and os-approvals-poll are how she
    // stays reachable and how owner decisions get applied; gating those would turn a spending
    // guard into an outage, and a runaway there shows up in the spend ledger anyway.
    // Once-a-day owner-facing jobs are exempt too (2026-09-24): they cannot loop (fixed-time +
    // fireState guard) and must never be the victims of the tripwire — the day the cap trips is
    // exactly the day the owner still needs their brief and their call.
    const EXEMPT = new Set([
      "os-agent-tasks-poll", "os-approvals-poll",
      "morning-brief", "morning-call", "owner-call-retry", "meeting-prep", "evening-brief", "notify-digest", "weekly-review",
    ]);
    // OS per-agent status (Settings → AI Agents → CLARA): paused or disabled holds every scheduled
    // job — the exempt ones too, since a pause means no new work — except the pure health checks
    // that keep the dashboard honest. One notice per day per status says why she went quiet.
    const { getAgentSettings } = await import("./agentSettings");
    const osStatus = (await getAgentSettings()).root.status;
    if (osStatus !== "active" && !RUNS_WHILE_PAUSED.has(job.name)) {
      if (!pausedNoticeSent.has(`${osStatus}:${day}`)) {
        pausedNoticeSent.add(`${osStatus}:${day}`);
        console.log(`[clara-scheduler] holding scheduled jobs — CLARA is ${osStatus} in the OS settings`);
        const { reportStatusChange } = await import("./modelCall");
        await reportStatusChange(osStatus, "scheduler");
        const { notifyOwner } = await import("./notify");
        await notifyOwner({
          kind: "schedule.agent_status",
          priority: "normal",
          text: `CLARA is ${osStatus} in the OS settings, so I'm holding my scheduled work (briefs, sweeps, follow-ups). Re-enable me under Settings → AI Agents to resume.`,
          dedupeKey: `clara:agentstatus:${osStatus}:${day}`,
        }).catch(() => {});
      }
      continue;
    }
    if (!EXEMPT.has(job.name)) {
      const { withinJobBudget, jobsToday, effectiveDailyJobCap, recordJobRun } = await import("./usage");
      if (!(await withinJobBudget())) {
        const [ran, cap] = await Promise.all([jobsToday(), effectiveDailyJobCap()]);
        const { notifyOwner } = await import("./notify");
        await notifyOwner({
          kind: "schedule.job_cap",
          priority: "critical",
          text: `⏸ Holding scheduled jobs — ${ran} of ${cap} run today, which is far above my normal ~4,600. Something is probably re-firing. Text "raise clara jobs 50" to add 50 for today only.`,
          dedupeKey: `clara:jobcap:${localDayKey(now)}`,
        }).catch(() => {});
        continue;
      }
      void recordJobRun(job.name);
    }

    // eslint-disable-next-line no-console
    if (catchUp) console.log(`[clara-scheduler] catch-up: ${job.name} missed its time earlier today — firing now`);
    fireState[job.name] = { key, day };
    try {
      await persistFireState();
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(`[clara-scheduler] fire-state persist failed (job still runs):`, e);
    }
    if (job.detached) {
      // eslint-disable-next-line no-console
      console.log(`[clara-scheduler] started ${job.name} (detached) at ${now.toISOString()}`);
      void job.run()
        // eslint-disable-next-line no-console
        .then(() => console.log(`[clara-scheduler] ${job.name} finished`))
        // eslint-disable-next-line no-console
        .catch((e) => console.error(`[clara-scheduler] ${job.name} failed:`, e));
      continue;
    }
    try {
      await job.run();
      // eslint-disable-next-line no-console
      console.log(`[clara-scheduler] ran ${job.name} at ${now.toISOString()}`);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(`[clara-scheduler] ${job.name} failed:`, e);
    }
  }
}

// Guard against double-init across Next dev-mode hot module reloads / multiple imports —
// a global flag on globalThis survives module re-evaluation within the same process.
const GLOBAL_FLAG = "__clara_scheduler_started__";

export function startScheduler(): void {
  // Prime the business-audience company reference so the voice brains (sync prompt builders) have it
  // from the first call; SMS/chat refresh it on each turn.
  void import("./knowledge").then((m) => m.warmCompanyKnowledge()).then((ok) => { if (!ok) console.warn("[clara-scheduler] knowledge/company.md missing — business replies run without the company reference"); }).catch(() => {});
  const g = globalThis as unknown as Record<string, boolean>;
  if (g[GLOBAL_FLAG]) return;
  g[GLOBAL_FLAG] = true;
  // Load persisted fire history FIRST, then tick immediately (don't wait up to 60s — this is
  // what lets catchUpDaily jobs recover right at boot), then settle into the interval. Ordering
  // matters: an immediate tick with unloaded state would see an empty history and re-fire jobs
  // that already ran today. The interval only starts after the first tick's state load, and the
  // per-minute dateKey guard makes an interval tick landing in the same minute as the boot tick
  // a no-op, so the two can never double-fire. The HMR global flag above prevents a second
  // interval entirely.
  void loadFireState()
    .catch((e) => console.error("[clara-scheduler] fire-state load failed, starting fresh:", e))
    .then(() => {
      // Before the first tick, while fireState still reflects the PREVIOUS run — tick() overwrites
      // each job's recorded day as it fires, which would erase the evidence of the gap. Not awaited
      // (that would delay the catch-up tick), which is safe because the whole scan happens in
      // reportMissedFires' synchronous prefix: an async function runs to its first `await`
      // eagerly, and there is none until after the loop that collects `missed`.
      void reportMissedFires(new Date()).catch((e) =>
        console.error("[clara-scheduler] missed-fire report failed:", e));
      void tick();
      setInterval(() => { void tick(); }, 60_000);
    });
  // First boot (or a wiped dataDir) has no link-index.json yet — don't wait for Sunday 03:05.
  void indexExists().then((exists) => {
    if (!exists) void rebuildLinkIndex().catch((e) => console.error("[clara-scheduler] initial link-index build failed:", e));
  });
  // eslint-disable-next-line no-console
  console.log("[clara-scheduler] started — briefs 08:00/20:30/Fri 16:00 (composed + delivered), followups 09:00, memory reindex+consolidate Sun 03:00/03:15, link-index rebuild Sun 03:05, outbound-flush 5min, notify-digest 08:00, google-sync tasks 15min + contacts 06:05/18:05, alerts: conflicts 30min, deadlines hourly, weather 06:45/15:00, drive-activity 15min, weekly audio digest Fri 16:05, transcribe-pending 10min, decision-ask 15min");
}
