// CLARA <-> orion "Agent Tasks" integration. The OS owns the schedules; this module registers
// CLARA's handlers and runs one poll per scheduler tick. Shadow-first: gated by CLARA_OS_TASKS
// (off|shadow|active, default shadow). CLARA is the personal/owner assistant, so every catalog
// task here is owner-facing (briefings, triage, meeting prep/follow-ups) - none are client-facing.
//
// No local last-run persistence is needed for OS tasks: next_run_at + run rows live server-side,
// so a CLARA restart costs at most one 60s window. Her hardcoded local JOBS[] (sync loops, alert
// scans) stay agent-local as system jobs. NOTE: when the OS
// clara.daily_owner_briefing schedule is flipped active, gate off the local "morning-brief" JOBS
// entry to avoid double delivery.

// Identity: the owner's owner account, by their explicit direction (2026-07-30, "clara signs in as me").
// The claim RPC and agent_task_runs RLS key on auth.uid() = agent_user_id, and Clara's schedule
// rows were re-owned to the owner's user id in migration clara_schedules_owner_identity_and_shadow_flips,
// so polling with the owner session claims them correctly. osAgentClient.ts remains available if a
// separate clara@ identity is ever wanted again.
import { osClient, osEnabled as osOwnerEnabled } from "./osClient";
import { osAgentClient, osAgentEnabled as claraAgentSignedIn } from "./osAgentClient";

// Which OS identity polls. The claim RPC only returns rows where agent_user_id = auth.uid(), and
// Clara's schedule rows are owned by the clara@ agent account — so polling as the owner
// claimed nothing from 2026-09-09 on (meeting follow-ups, inbox triage, inbox zero, meeting prep,
// weekly planning all froze). Poll as clara@ whenever that session exists; fall back to the owner
// session only when it doesn't. Handlers keep using the owner client for CRM reads.
function pollClient() {
  return claraAgentSignedIn() ? osAgentClient : osClient;
}
const osAgentEnabled = (): boolean => claraAgentSignedIn() || osOwnerEnabled();
import {
  pollOsTasks,
  type HandlerRegistry,
  type PollContext,
  type PollSummary,
} from "@autom8ionlab/agent-core";

export type OsTasksMode = "off" | "shadow" | "active";

export function osTasksMode(): OsTasksMode {
  const v = (process.env.CLARA_OS_TASKS ?? "shadow").trim().toLowerCase();
  return v === "off" || v === "active" ? v : "shadow";
}

function unwrap(content: unknown): unknown {
  if (Array.isArray(content)) {
    const first = content.find((c) => c && typeof c === "object" && "text" in (c as object));
    if (first && typeof (first as { text?: unknown }).text === "string") {
      try { return JSON.parse((first as { text: string }).text); } catch { return (first as { text: string }).text; }
    }
  }
  return content;
}

let identity: { user_id: string; organization_id: string } | null = null;
async function whoami() {
  if (identity) return identity;
  try {
    const p = unwrap(await pollClient().callTool("agent_whoami", {})) as { user_id?: string; organization_id?: string };
    if (p?.user_id && p?.organization_id) identity = { user_id: p.user_id, organization_id: p.organization_id };
  } catch { /* ignore */ }
  return identity;
}

// Owner-facing handlers. Deep implementations plug into briefs.ts / triage.ts / followups.ts next;
// for now an honest heartbeat so shadow run-history shows the schedule firing. daily_owner_briefing
// is the flagship - when implemented it composes the brief and posts it via team_message_send
// (fans out to the owner's unified inbox). meeting_followups is owner_review: drafts stay in
// CLARA's internal approvals rail, only a summary flows to the OS.
const registry: HandlerRegistry = {
  handlers: {
    // Compose the morning brief (writes a vault file, sends nothing), strip cloud-sensitive
    // sections, and - when active - post it to the owner via team_message_send (fans out to the
    // OS unified inbox). In shadow the brief text is only recorded on the run.
    "clara.daily_owner_briefing": async (run, ctx: PollContext) => {
      // Single-owner guard (mirrors clara.weekly_planning): the local 8am morning-brief job and
      // this schedule must never both deliver. CLARA_DAILY_OWNER=local (default) keeps the local
      // job authoritative; =os hands delivery to this handler.
      const { claraDailyOwner } = await import("./weeklyPlanning");
      const { composeMorningBrief, gateBriefForCloud, deliverBrief } = await import("./briefs");
      if (claraDailyOwner() === "local") {
        ctx.log?.("os-tasks: clara.daily_owner_briefing no-op — CLARA_DAILY_OWNER=local (local 8am morning-brief job owns delivery)");
        // A schedule sitting at mode='active' that no-ops on every run looks healthy from the
        // OS: status completed, no error. Say so in result.alerts[] instead, or the only way to
        // discover an inert-but-"active" schedule is to read the handler source.
        return {
          summary: "Skipped — CLARA_DAILY_OWNER=local; the local 8am morning-brief job owns delivery.",
          result: {
            skipped: true,
            alerts: [{
              kind: "schedule.inert",
              text: "clara.daily_owner_briefing is mode=active but no-ops every run: CLARA_DAILY_OWNER=local hands delivery to CLARA's local 8am job. Set CLARA_DAILY_OWNER=os to make this schedule real, or set the schedule to off.",
              priority: "warn",
              dedupeKey: "schedule.inert:clara.daily_owner_briefing",
            }],
          },
        };
      }
      const brief = await composeMorningBrief();
      const safe = gateBriefForCloud(brief.markdown).text;
      const live = ctx.mode === "active" && run.mode === "active";
      let delivered = false;
      if (live) {
        // Full delivery — the same email path the local job uses (executive brief → email, no
        // SMS headline). The channel post below is a bonus surface, never the primary delivery.
        const d = await deliverBrief(brief);
        if (!d.ok) throw new Error(`daily-briefing delivery failed: ${d.error ?? "unknown"}`);
        delivered = true;
        try {
          const channels = (unwrap(await ctx.osClient.callTool("team_channels_list", { organization_id: ctx.orgId })) as Array<{ id: string }>) ?? [];
          if (channels[0]) {
            await ctx.osClient.callTool("team_message_send", {
              channel_id: channels[0].id, organization_id: ctx.orgId, sender_id: ctx.agentUserId,
              content: `☀️ Daily briefing\n\n${safe.slice(0, 3500)}`,
            });
          }
        } catch { /* posting is best-effort */ }
      }
      return {
        summary: `Daily briefing composed (${safe.length} chars)${delivered ? "; delivered by email + posted to the OS inbox" : " (shadow — composed only, not delivered)"}.`,
        result: { brief: safe.slice(0, 4000) },
      };
    },

    // Inbox triage digest — read-only aggregator (no mail sent), report signal/noise counts.
    "clara.inbox_triage_digest": async () => {
      const { listInbox } = await import("./inbox");
      const inbox = await listInbox();
      return {
        summary: `Inbox triage: ${inbox.counts.signal} signal, ${inbox.counts.noise} noise across ${inbox.items.length} item(s).`,
        result: { counts: inbox.counts, top: inbox.items.slice(0, 15) },
      };
    },

    // Meeting prep (2026-09-24): a Google Doc per external meeting today (Drive Clara/Prep/<date>).
    // Shares the state file with the local 07:30 job, so whichever runs first produces the docs and
    // the other reports them. Shadow → dry run (composes, creates nothing).
    "clara.meeting_prep": async (run, ctx: PollContext) => {
      const { runMeetingPrep, prepForDate } = await import("./meetingPrep");
      const live = ctx.mode === "active" && run.mode === "active";
      const r = await runMeetingPrep({ dryRun: !live, log: (m) => ctx.log?.(`meeting-prep: ${m}`) });
      const today = new Date();
      const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
      const docs = live ? await prepForDate(date) : r.prepared;
      return {
        summary: `Meeting prep: ${docs.length} document(s) for today${r.failed.length ? `, ${r.failed.length} failed` : ""}${live ? "" : " (shadow — composed only)"}.`,
        result: { docs: docs.map((d) => ({ meeting: d.meeting, start: d.start, link: d.link, docName: d.docName })), failed: r.failed },
      };
    },

    // Meeting follow-ups — summarize OPEN followups (pure read; drafts/chases stay in CLARA's own
    // approvals/outbound rail, only this summary flows to the OS).
    "clara.meeting_followups": async () => {
      const { listOpen } = await import("./followups");
      const open = await listOpen();
      // A follow-up chased three or more times with no response is not "open", it's stuck, and
      // the count alone never showed that. One alert per stuck item, deduped so a persistently
      // unanswered thread stays one row rather than one per day.
      const stuck = open.filter((f) => (f.nudgeCount ?? 0) >= 3);
      return {
        summary: `Follow-ups: ${open.length} open${stuck.length ? `, ${stuck.length} chased 3+ times with no reply` : ""}.`,
        result: {
          open: open.slice(0, 20).map((f) => ({ what: f.what, contact: f.contact?.name, channel: f.channel, nudges: f.nudgeCount })),
          alerts: stuck.slice(0, 10).map((f) => ({
            kind: "followup.stuck",
            text: `"${String(f.what).slice(0, 80)}"${f.contact?.name ? ` with ${f.contact.name}` : ""} has been chased ${f.nudgeCount} times with no reply.`,
            priority: "warn",
            dedupeKey: `followup.stuck:${f.id ?? f.what}`,
          })),
        },
      };
    },

    // Wave 5: Sunday weekly planning (seeded Sun 18:30, autonomous/owner_briefing). A superset of
    // the local weekly review — same composer plus 7-day conflict pre-flags, ranked priorities,
    // and logistics flags. SINGLE-OWNER: the local Sunday 18:00 weekly-review job could
    // also email the owner, so CLARA_WEEKLY_OWNER (local|os, default local) picks one — this handler
    // no-ops under "local", the local job stands down under "os" (guard in scheduler.ts).
    "clara.weekly_planning": async (run, ctx: PollContext) => {
      const { claraWeeklyOwner, composeWeeklyPlanning } = await import("./weeklyPlanning");
      if (claraWeeklyOwner() === "local") {
        ctx.log?.("os-tasks: clara.weekly_planning no-op — CLARA_WEEKLY_OWNER=local (local Sunday weekly-review job owns delivery)");
        // Same inert-but-"active" trap as daily_owner_briefing above. This one is live today:
        // .env.local sets CLARA_DAILY_OWNER=os but leaves CLARA_WEEKLY_OWNER at its default, so
        // this schedule reports completed every Sunday having done nothing.
        return {
          summary: "Skipped — CLARA_WEEKLY_OWNER=local; the local Sunday weekly-review job owns Sunday delivery.",
          result: {
            skipped: true,
            alerts: [{
              kind: "schedule.inert",
              text: "clara.weekly_planning is mode=active but no-ops every run: CLARA_WEEKLY_OWNER=local hands delivery to CLARA's local Sunday job. Set CLARA_WEEKLY_OWNER=os to make this schedule real, or set the schedule to off.",
              priority: "warn",
              dedupeKey: "schedule.inert:clara.weekly_planning",
            }],
          },
        };
      }
      const plan = await composeWeeklyPlanning();
      const live = ctx.mode === "active" && run.mode === "active";
      let delivered = false;
      if (live) {
        // Same delivery path as the local Sunday review: briefs.ts's exported deliverBrief
        // (kind "weekly" → email to the owner via deliverToPrincipal, identical formatting).
        const { deliverBrief } = await import("./briefs");
        const d = await deliverBrief(plan.brief);
        if (!d.ok) throw new Error(`weekly-planning delivery failed: ${d.error ?? "unknown"}`);
        delivered = true;
      }
      return {
        summary: `Weekly planning composed — ${plan.sections.weekAheadEvents} event(s), ${plan.sections.conflicts.length} conflict(s) pre-flagged, ${plan.sections.priorities.length} priorities${delivered ? "; delivered by email" : " (shadow — composed only, not delivered)"}.`,
        result: {
          title: plan.title,
          vaultPath: plan.vaultPath,
          conflicts: plan.sections.conflicts,
          priorities: plan.sections.priorities,
          delivered,
          text: plan.text.slice(0, 4000),
        },
      };
    },

    // Wave 5: daily inbox-zero pass (seeded 12:30, autonomous/owner_briefing, config carries
    // allowed_mutations). The schedule row's allowed_mutations is the HARD filter (runInboxZero
    // skips + counts anything not listed); shadow runs execute as dryRun — full classification
    // and would-do counts, zero Gmail calls. Real runs ledger-append an "action" line so the
    // sweep lands in the next brief's Since-yesterday section automatically; the rich
    // result_summary/result below is the OS-side record.
    "clara.inbox_zero": async (run, ctx: PollContext) => {
      const { runInboxZero, summarizeInboxZero } = await import("./inboxZero");
      const cfgAllowed = Array.isArray(run.config?.allowed_mutations)
        ? (run.config.allowed_mutations as unknown[]).filter((v): v is string => typeof v === "string")
        : undefined;
      const cfgCap = typeof run.config?.max_mutations === "number" ? run.config.max_mutations : undefined;
      const live = ctx.mode === "active" && run.mode === "active";
      const r = await runInboxZero({ allowedMutations: cfgAllowed, maxMutations: cfgCap, dryRun: !live });
      return {
        summary: summarizeInboxZero(r),
        result: {
          dryRun: r.dryRun,
          scanned: r.scanned,
          eligible: r.eligible,
          archived: r.archived,
          markedRead: r.markedRead,
          starred: r.starred,
          labeled: r.labeled,
          untouched: r.untouched,
          classifyFailed: r.classifyFailed,
          capReached: r.capReached,
          skippedByPolicy: r.skippedByPolicy,
          unsubscribeCandidates: r.unsubscribeCandidates.slice(0, 15),
          vipCatchUp: r.vipCatchUp.slice(0, 15),
          // Also raise it through result.alerts[] so the OS run row is visibly degraded, not just
          // a green "completed" carrying a bad number in its payload. runInboxZero already texts
          // the owner; this is the same fact on the surface they'd be looking at in the app.
          ...(r.classifyFailed > 0
            ? {
                alerts: [{
                  kind: "inbox.classify_failed",
                  priority: r.eligible > 0 && r.classifyFailed / r.eligible >= 0.25 ? "critical" : "warn",
                  text: `Inbox-zero could not classify ${r.classifyFailed} of ${r.eligible} eligible message(s). They were left untouched — nothing mis-filed, but that mail was not triaged.`,
                  dedupeKey: `inboxzero:classifyfail:${new Date().toISOString().slice(0, 10)}`,
                }],
              }
            : {}),
        },
      };
    },

    // Owner-described schedules from the OS task builder (config.instructions = the confirmed
    // brief). Runs the brief through Clara's tool loop as the owner; shadow and approval runs are
    // read-only, and approval runs park the draft (see instructionTask.ts).
    "clara.instruction": async (run, ctx: PollContext) => {
      const { runInstructionTask } = await import("./instructionTask");
      return runInstructionTask(run, ctx);
    },
  },
  deliver: {
    // Approved clara.instruction draft: replay exactly the drafted calls, or send the reply.
    "clara.instruction": async (run, ctx: PollContext) => {
      const { deliverInstructionTask } = await import("./instructionTask");
      return deliverInstructionTask(run, ctx);
    },
  },
};

let ran = false;
let warnedNotSignedIn = false;
export async function runOsTasksPoll(log?: (m: string, e?: unknown) => void): Promise<PollSummary | null> {
  const mode = osTasksMode();
  if (mode === "off") return null;
  if (!osAgentEnabled()) {
    // Once per process, not once per minute: the fix is a one-time human step, not a retry.
    if (!warnedNotSignedIn) {
      log?.("os-tasks: agent identity (clara@) not signed in — visit /os/auth/agent to complete the one-time sign-in (docs/os-agent-auth.md); polling skipped until then");
      warnedNotSignedIn = true;
    }
    return null;
  }
  const id = await whoami();
  if (!id) { log?.("os-tasks: whoami failed, skipping"); return null; }
  const ctx: PollContext = { osClient: pollClient(), orgId: id.organization_id, agentUserId: id.user_id, mode, log };
  const summary = await pollOsTasks(registry, ctx, 5);
  if (!ran || summary.claimed > 0 || summary.delivered > 0) {
    log?.(`os-tasks(${mode}): claimed=${summary.claimed} completed=${summary.completed} parked=${summary.parked} failed=${summary.failed}`);
    ran = true;
  }
  return summary;
}
