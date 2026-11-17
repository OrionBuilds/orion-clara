// intentTools.ts — the conversational surface for prospecting (§ Part 5), spread into intent.ts's
// TOOLS array as `...PROSPECT_TOOLS`.
//
// Every tool is `reversible: true` under an "auto" tier category (prospect.research /
// prospect.spend) — the ONE money confirmation is the conversation itself (plan → cost table →
// "say go ahead"), not a second approval row (plan §31 decision #5). `buildProspectTools` takes an
// injectable bridge so tests can run every handler against a fake OS without a module-mocking
// mechanism — production code uses the exported `PROSPECT_TOOLS`, built against the real osBridge.

import type { ToolDef } from "../intent";
import { planFromText as planFromTextReal, describeSpec } from "./planner";
import { estimateJobLive as estimateJobLiveReal } from "./estimator";
import type { Estimate } from "./types";
import {
  createResearchJob as createResearchJobReal,
  listResearchJobs as listResearchJobsReal,
  getResearchJob as getResearchJobReal,
  updateResearchJob as updateResearchJobReal,
  cancelResearchJob as cancelResearchJobReal,
  addTasks as addTasksReal,
  OsProspectingUnavailableError,
} from "./osBridge";
import { hexGrid } from "./discovery/grid";
import { resolveCenter } from "./discovery/center";
import type { Job, JobSpec } from "./types";
import { prospectingMode } from "./types";

function fmtUsd(n: number): string {
  return `$${n.toFixed(2)}`;
}

function planLine(spec: JobSpec, estimate: Estimate): string {
  return [
    describeSpec(spec),
    "",
    `Estimated cost: ${fmtUsd(estimate.total)} (discovery ${fmtUsd(estimate.discovery)}, web research ${fmtUsd(estimate.web_research)}, AI ${fmtUsd(estimate.ai)}, email lookup ${fmtUsd(estimate.email_lookup)}, mobile lookup ${fmtUsd(estimate.mobile_lookup)}) — about ${estimate.eta_hours.toFixed(1)} hours.`,
    `Say "go ahead" and I'll start it.`,
  ].join("\n");
}

const UNAVAILABLE = "The research-job tables aren't live on the OS yet.";

export interface ProspectBridge {
  planFromText: typeof planFromTextReal;
  estimateJobLive: typeof estimateJobLiveReal;
  createResearchJob: typeof createResearchJobReal;
  listResearchJobs: typeof listResearchJobsReal;
  getResearchJob: typeof getResearchJobReal;
  updateResearchJob: typeof updateResearchJobReal;
  cancelResearchJob: typeof cancelResearchJobReal;
  addTasks: typeof addTasksReal;
}

export const defaultProspectBridge: ProspectBridge = {
  planFromText: planFromTextReal,
  estimateJobLive: estimateJobLiveReal,
  createResearchJob: createResearchJobReal,
  listResearchJobs: listResearchJobsReal,
  getResearchJob: getResearchJobReal,
  updateResearchJob: updateResearchJobReal,
  cancelResearchJob: cancelResearchJobReal,
  addTasks: addTasksReal,
};

async function mostRecentEstimated(bridge: ProspectBridge): Promise<Job | null> {
  const rows = await bridge.listResearchJobs({ status: "estimated", limit: 10 });
  if (!rows.length) return null;
  return [...rows].sort((a, b) => (a.created_at < b.created_at ? 1 : -1))[0];
}

export function buildProspectTools(bridge: ProspectBridge = defaultProspectBridge): ToolDef[] {
  return [
    {
      name: "prospect_plan",
      description:
        'Turn a plain-English prospecting request (e.g. "roofing companies within 50 miles of Tampa, 4+ rating, owner emails") into a research plan with a cost estimate and ETA, BEFORE anything runs or spends money. Always call this first for a new prospecting ask — never prospect_start.',
      input_schema: { type: "object", properties: { request: { type: "string", description: "The ask, in the owner's words." } }, required: ["request"] },
      reversible: true,
      speed: "slow",
      category: "prospect.research",
      describe: (a) => `plan a prospecting job: ${String(a.request ?? "")}`,
      run: async (args) => {
        const request = String(args.request ?? "").trim();
        if (!request) return { ok: false, line: "What should I look for, and where?" };
        const plan = await bridge.planFromText(request);
        if (!plan.ok || !plan.spec) {
          return { ok: false, line: `I couldn't turn that into a plan: ${plan.errors.join("; ")}` };
        }
        const estimate = await bridge.estimateJobLive(plan.spec);
        let job: Job | null = null;
        try {
          const r = await bridge.createResearchJob({
            title: plan.spec.title,
            request_text: request,
            plan: plan.spec,
            budget_usd: Math.ceil(estimate.total * 1.25),
            max_records: plan.spec.max_records,
            requested_via: "clara",
            dry_run: true,
          });
          job = r.job;
        } catch (e) {
          if (!(e instanceof OsProspectingUnavailableError)) throw e;
        }
        const line = planLine(plan.spec, estimate) + (job ? "" : `\n\n(Draft only — ${UNAVAILABLE.toLowerCase()} This plan isn't saved; ask again once they are.)`);
        return { ok: true, line };
      },
    },
    {
      name: "prospect_start",
      description:
        'Start the most recently planned prospecting job (the one prospect_plan just estimated) after the owner says "go ahead" / "run it" / "do it". Never call this without a prior prospect_plan in this conversation.',
      input_schema: { type: "object", properties: { job_id: { type: "string", description: "Specific job id, if known." } } },
      reversible: true,
      speed: "slow",
      category: "prospect.spend",
      describe: () => "start the planned prospecting job",
      run: async (args) => {
        if (prospectingMode() === "off") return { ok: false, line: "Prospecting is turned off right now (CLARA_PROSPECTING=off)." };
        let job: Job | null;
        try {
          job = args.job_id ? await bridge.getResearchJob(String(args.job_id)) : await mostRecentEstimated(bridge);
        } catch (e) {
          if (e instanceof OsProspectingUnavailableError) return { ok: false, line: `I can't start it yet — ${UNAVAILABLE.toLowerCase()}` };
          throw e;
        }
        if (!job) return { ok: false, line: "I don't have a plan waiting to start — ask me to plan one first." };
        const centered = await resolveCenter(job.plan as JobSpec);
        if (!centered.ok) return { ok: false, line: `I can't start it — I ${centered.error}.` };
        const spec = centered.spec;
        const cells = hexGrid(spec.location.lat!, spec.location.lng!, spec.location.radius_miles);
        await bridge.addTasks(
          job.id,
          cells.map((c) => ({
            task_type: "discover",
            stage: 10,
            idempotency_key: `${job!.id}:discover:${c.id}`,
            input: { lat: c.lat, lng: c.lng, radiusMiles: c.radiusMiles, cellId: c.id },
          })),
        );
        // "running", not "queued": claim_research_tasks only picks up tasks of running jobs, so a
        // queued job never ran (the same bug PR #40 fixed in the Office run route).
        await bridge.updateResearchJob(job.id, { status: "running", plan: spec });
        const mode = prospectingMode();
        return {
          ok: true,
          line:
            mode === "shadow"
              ? `Started "${job.title}" in shadow mode — it'll run discovery against cached/free sources only and won't spend or send anything until I'm switched to active.`
              : `Started "${job.title}" — ${cells.length} search cells queued. I'll text/email when there's something to see.`,
        };
      },
    },
    {
      name: "prospect_status",
      description: 'Report a prospecting job\'s status — funnel counts, spend vs budget. Use for "how\'s the roofing job going" or similar.',
      input_schema: { type: "object", properties: { job_id: { type: "string" } } },
      reversible: true,
      speed: "fast",
      category: "prospect.research",
      describe: () => "check a prospecting job's status",
      run: async (args) => {
        try {
          const job = args.job_id ? await bridge.getResearchJob(String(args.job_id)) : (await bridge.listResearchJobs({ limit: 1 }))[0];
          if (!job) return { ok: true, line: "No prospecting jobs yet." };
          const f = job.funnel ?? {};
          return {
            ok: true,
            line: `"${job.title}" — ${job.status}. Spend ${fmtUsd(job.spend_usd ?? 0)} of ${fmtUsd(job.budget_usd ?? 0)}. Discovered ${f.discovered ?? 0}, qualified ${f.ai_qualified ?? 0}, emails found ${f.email_found ?? 0}.`,
          };
        } catch (e) {
          if (e instanceof OsProspectingUnavailableError) return { ok: true, line: `No prospecting jobs yet — ${UNAVAILABLE.toLowerCase()}` };
          throw e;
        }
      },
    },
    {
      name: "prospect_pause",
      description: "Pause a running prospecting job.",
      input_schema: { type: "object", properties: { job_id: { type: "string" } }, required: ["job_id"] },
      reversible: true,
      speed: "fast",
      category: "prospect.research",
      describe: (a) => `pause prospecting job ${String(a.job_id ?? "")}`,
      run: async (args) => {
        try {
          const job = await bridge.updateResearchJob(String(args.job_id), { status: "paused", paused_reason: "owner" });
          return { ok: true, line: `Paused "${job.title}".` };
        } catch (e) {
          if (e instanceof OsProspectingUnavailableError) return { ok: false, line: UNAVAILABLE };
          throw e;
        }
      },
    },
    {
      name: "prospect_resume",
      description: "Resume a paused prospecting job.",
      input_schema: { type: "object", properties: { job_id: { type: "string" } }, required: ["job_id"] },
      reversible: true,
      speed: "fast",
      category: "prospect.research",
      describe: (a) => `resume prospecting job ${String(a.job_id ?? "")}`,
      run: async (args) => {
        try {
          const job = await bridge.updateResearchJob(String(args.job_id), { status: "running", paused_reason: null });
          return { ok: true, line: `Resumed "${job.title}".` };
        } catch (e) {
          if (e instanceof OsProspectingUnavailableError) return { ok: false, line: UNAVAILABLE };
          throw e;
        }
      },
    },
    {
      name: "prospect_cancel",
      description: "Cancel a prospecting job. Pending tasks are dropped; a partial report still goes out.",
      input_schema: { type: "object", properties: { job_id: { type: "string" } }, required: ["job_id"] },
      reversible: true,
      speed: "fast",
      category: "prospect.research",
      describe: (a) => `cancel prospecting job ${String(a.job_id ?? "")}`,
      run: async (args) => {
        try {
          const job = await bridge.cancelResearchJob(String(args.job_id));
          return { ok: true, line: `Cancelled "${job.title}" — a report with what was found so far will follow.` };
        } catch (e) {
          if (e instanceof OsProspectingUnavailableError) return { ok: false, line: UNAVAILABLE };
          throw e;
        }
      },
    },
    {
      name: "prospect_budget_add",
      description: 'Add budget to a prospecting job that\'s paused on cost (owner said e.g. "add 25 to the roofing job").',
      input_schema: { type: "object", properties: { job_id: { type: "string" }, amount_usd: { type: "number" } }, required: ["job_id", "amount_usd"] },
      reversible: true,
      speed: "fast",
      category: "prospect.spend",
      describe: (a) => `add $${String(a.amount_usd ?? "")} to prospecting job ${String(a.job_id ?? "")}`,
      run: async (args) => {
        const amount = Number(args.amount_usd);
        if (!Number.isFinite(amount) || amount <= 0) return { ok: false, line: "How much should I add?" };
        try {
          const job = await bridge.getResearchJob(String(args.job_id));
          const updated = await bridge.updateResearchJob(job.id, {
            budget_usd: job.budget_usd + amount,
            status: job.status === "paused" ? "running" : job.status,
          });
          return { ok: true, line: `Added ${fmtUsd(amount)} to "${updated.title}" — budget is now ${fmtUsd(updated.budget_usd)}. Resuming.` };
        } catch (e) {
          if (e instanceof OsProspectingUnavailableError) return { ok: false, line: UNAVAILABLE };
          throw e;
        }
      },
    },
    {
      name: "prospect_export",
      description: "Export a prospecting job's list (link to the Drive sheet / Office list).",
      input_schema: { type: "object", properties: { job_id: { type: "string" } }, required: ["job_id"] },
      reversible: true,
      speed: "fast",
      category: "prospect.research",
      describe: (a) => `export prospecting job ${String(a.job_id ?? "")}`,
      run: async (args) => {
        try {
          const job = await bridge.getResearchJob(String(args.job_id));
          if (!job.report_url) return { ok: true, line: `"${job.title}" doesn't have a report yet — it's still ${job.status}.` };
          return { ok: true, line: `"${job.title}": ${job.report_url}` };
        } catch (e) {
          if (e instanceof OsProspectingUnavailableError) return { ok: false, line: UNAVAILABLE };
          throw e;
        }
      },
    },
  ];
}

export const PROSPECT_TOOLS: ToolDef[] = buildProspectTools();
