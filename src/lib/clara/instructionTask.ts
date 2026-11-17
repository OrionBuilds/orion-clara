// OS `clara.instruction` — the generic, owner-described scheduled task (2026-10-28).
//
// The orion task builder turns "every Monday, pull X and tell me Y" into a schedule whose config
// carries the confirmed brief (`instructions`) plus summary / scope / success_criteria /
// output_destination / external_effects. There is no bespoke handler per task: each run hands the
// brief to Clara's normal tool loop (runIntent) as the owner, and her reply is the deliverable.
//
// Three modes, decided per run:
//   - shadow (CLARA_OS_TASKS or the schedule not active): read-only. Reads run; anything that sends
//     or changes is blocked and recorded as the would-do plan. Nothing reaches the owner.
//   - approval (approval_required or external_effects): read-only too, but the blocked calls ARE the
//     draft. The run parks in the OS approval queue; on approve, the deliver step replays exactly
//     those calls (no model in the loop), or — when the deliverable is just the reply — sends it to
//     the owner.
//   - live: the brief runs with reversible tools; irreversible ones still queue in Clara's own
//     approvals rail (no owner-ask waiver for unattended runs). The reply goes to the owner.
//
// Idempotent per run id: the outcome is stored the moment the tool loop finishes, so a run that
// re-presents (lost report, expired lease) returns the stored result instead of acting twice; the
// deliver step records each executed call so a retry resumes where it stopped.

import { promises as fs } from "node:fs";
import path from "node:path";
import type { DueRun, ResolvedRun, PollContext, HandlerResult, ApprovalRequest, IntentOutcome } from "@autom8ionlab/agent-core";
import type { IntentContext } from "./intent";

export const TASK_KEY = "clara.instruction";
const SUMMARY_MAX = 500; // agent_run_report.result_summary is capped at 500 by the OS
const REPLY_MAX = 4000;

export interface ProposedCall { name: string; args: Record<string, unknown> }

interface RunRecord { at: string; result: HandlerResult; ownerDelivered: boolean }
interface DeliverRecord { at: string; done: number[]; ownerDelivered: boolean }

export interface InstructionStore {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
}

export interface InstructionDeps {
  runIntent: (text: string, ctx: IntentContext) => Promise<IntentOutcome>;
  runApprovedToolCall: (name: string, args: Record<string, unknown>, ctx: IntentContext) => Promise<{ ok: boolean; line: string }>;
  /** Send the deliverable to the owner. Returns ok:false (never throws) when it could not. */
  deliverToOwner: (input: { title: string; text: string; destination: string | null }, ctx: PollContext) => Promise<{ ok: boolean; error?: string }>;
  proposedMark: string;
  store: InstructionStore;
}

// ── pure helpers ────────────────────────────────────────────────────────────────────────────────

function str(v: unknown): string { return typeof v === "string" ? v.trim() : ""; }

export function hasExternalEffects(v: unknown): boolean {
  return v === true || v === "true";
}

/** Is the run allowed to touch the world? Both the agent-wide gate and the schedule must be active. */
export function isLive(run: Pick<DueRun, "mode">, ctx: Pick<PollContext, "mode">): boolean {
  return ctx.mode === "active" && run.mode === "active";
}

export function needsApproval(run: Pick<DueRun, "approval_required" | "risk_tier" | "config">): boolean {
  return run.approval_required === true || run.risk_tier === "client_visible" || hasExternalEffects(run.config?.external_effects);
}

export const SHADOW_DIRECTIVE =
  "SHADOW RUN — do not send, post, book, move, delete or change anything. Only read-only tools will execute; " +
  "any other tool call is recorded as the action you WOULD take and is not executed. Call each such tool once " +
  "with its exact final arguments, then reply with what you found and what you would have done.";

export const APPROVAL_DIRECTIVE =
  "APPROVAL REQUIRED — nothing from this run leaves until the owner approves it. Only read-only tools execute now. " +
  "Call each sending/changing tool once with its exact final arguments (the full message text, recipients, times): " +
  "those calls are recorded as the draft the owner approves and are run exactly as drafted once they do. " +
  "Then reply with a short summary of the draft.";

/** Pure. The text handed to runIntent. */
export function buildInstructionPrompt(run: Pick<DueRun, "title" | "scheduled_for" | "config">, opts: { shadow: boolean; approval: boolean }): string {
  const c = run.config ?? {};
  const dest = str(c.output_destination) || "the owner's OS inbox";
  const lines = [
    `Scheduled task${run.title ? ` "${run.title}"` : ""} (run ${run.scheduled_for}): ${str(c.instructions)}`,
    `Scope: ${str(c.scope) || "as described in the task"}.`,
    `Success criteria: ${str(c.success_criteria) || "the task above is done and reported accurately"}.`,
    `Deliver to: ${dest}.`,
    "",
    "This is an unattended scheduled run: nobody is watching to answer a question. Stay inside the scope and make " +
      "conservative choices; if something essential is missing, say exactly what and stop rather than guess. Your final " +
      `reply is the deliverable and is sent to the owner automatically (${dest}) — do not send it to them yourself.`,
  ];
  if (opts.shadow) lines.push("", SHADOW_DIRECTIVE);
  if (opts.approval) lines.push("", APPROVAL_DIRECTIVE);
  return lines.join("\n");
}

/** Pure. The calls a read-only run proposed (blocked with the marker), in order. */
export function proposedCalls(outcome: Pick<IntentOutcome, "calls">, mark: string): ProposedCall[] {
  return outcome.calls.filter((c) => !c.ok && c.resultLine.includes(mark)).map((c) => ({ name: c.name, args: c.args }));
}

function clip(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

// ── defaults (lazy: tests inject fakes and never load the tool catalog) ─────────────────────────

function fileStore(): InstructionStore {
  const MAX_ENTRIES = 400;
  const file = async () => {
    const { loadConfig } = await import("./config");
    const cfg = await loadConfig();
    await fs.mkdir(cfg.dataDir, { recursive: true });
    return path.join(cfg.dataDir, "os-instruction-runs.json");
  };
  const load = async (): Promise<Record<string, { at?: string }>> => {
    try { return JSON.parse(await fs.readFile(await file(), "utf8")); } catch { return {}; }
  };
  return {
    async get<T>(key: string) { return (await load())[key] as T | undefined; },
    async set(key, value) {
      const all = await load();
      all[key] = value as { at?: string };
      // Oldest out first; a run id is only ever re-presented within its lease window.
      const keys = Object.keys(all).sort((a, b) => String(all[a]?.at ?? "").localeCompare(String(all[b]?.at ?? "")));
      for (const k of keys.slice(0, Math.max(0, keys.length - MAX_ENTRIES))) delete all[k];
      const p = await file();
      const tmp = `${p}.${process.pid}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(all, null, 2), "utf8");
      await fs.rename(tmp, p);
    },
  };
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

/** Same surfaces daily_owner_briefing uses: the OS inbox (team_message_send to the first channel),
 *  and email via deliverToPrincipal when the destination says email. */
async function defaultDeliverToOwner(input: { title: string; text: string; destination: string | null }, ctx: PollContext): Promise<{ ok: boolean; error?: string }> {
  const errors: string[] = [];
  let ok = false;
  if (/e-?mail/i.test(input.destination ?? "")) {
    const { deliverToPrincipal } = await import("./deliver");
    const r = await deliverToPrincipal("owner", input.title, input.text, `${input.title}: sent to your email.`).catch((e) => ({ ok: false, error: String(e) }));
    if (r.ok) ok = true; else errors.push(`email: ${r.error ?? "failed"}`);
  }
  try {
    const channels = (unwrap(await ctx.osClient.callTool("team_channels_list", { organization_id: ctx.orgId })) as Array<{ id: string }>) ?? [];
    if (channels[0]) {
      await ctx.osClient.callTool("team_message_send", {
        channel_id: channels[0].id, organization_id: ctx.orgId, sender_id: ctx.agentUserId,
        content: `🗓️ ${input.title}\n\n${input.text.slice(0, 3500)}`,
      });
      ok = true;
    } else {
      errors.push("os inbox: no team channel");
    }
  } catch (e) {
    errors.push(`os inbox: ${String(e).slice(0, 160)}`);
  }
  return ok ? { ok } : { ok, error: errors.join("; ") };
}

async function resolveDeps(over: Partial<InstructionDeps>): Promise<InstructionDeps> {
  const needIntent = !over.runIntent || !over.runApprovedToolCall || !over.proposedMark;
  const intent = needIntent ? await import("./intent") : null;
  return {
    runIntent: over.runIntent ?? intent!.runIntent,
    runApprovedToolCall: over.runApprovedToolCall ?? intent!.runApprovedToolCall,
    proposedMark: over.proposedMark ?? intent!.PROPOSED_MARK,
    deliverToOwner: over.deliverToOwner ?? defaultDeliverToOwner,
    store: over.store ?? fileStore(),
  };
}

function intentCtx(runId: string, readOnly: boolean): IntentContext {
  // Owner-initiated (they described and confirmed the brief), shaped like the desk chat path.
  return { principal: "owner", source: "chat", requestRef: `os-run:${runId}`, scheduled: { readOnly } };
}

// ── handler ─────────────────────────────────────────────────────────────────────────────────────

export async function runInstructionTask(run: DueRun, ctx: PollContext, over: Partial<InstructionDeps> = {}): Promise<HandlerResult> {
  const instructions = str(run.config?.instructions);
  if (!instructions) {
    throw new Error(`${TASK_KEY}: schedule config has no "instructions" — re-save the task in the OS task builder`);
  }
  const deps = await resolveDeps(over);
  const key = `run:${run.run_id}`;
  const live = isLive(run, ctx);
  const approval = needsApproval(run);
  const title = run.title || "Scheduled task";
  const destination = str(run.config?.output_destination) || null;

  let rec = await deps.store.get<RunRecord>(key);
  if (rec) ctx.log?.(`os-tasks: ${TASK_KEY} run ${run.run_id} already ran — returning the stored outcome`);
  if (!rec) {
    const readOnly = !live || approval;
    const outcome = await deps.runIntent(buildInstructionPrompt(run, { shadow: !live, approval }), intentCtx(run.run_id, readOnly));
    if (outcome.failed) throw new Error(`${TASK_KEY}: ${clip(outcome.reply || "intent router failed", 300)}`);

    const reply = outcome.reply.trim();
    const proposed = readOnly ? proposedCalls(outcome, deps.proposedMark) : [];
    const executed = outcome.calls.filter((c) => !c.resultLine.includes(deps.proposedMark));
    const failed = executed.filter((c) => !c.ok).length;
    const alerts: Array<Record<string, unknown>> = [];
    if (outcome.clarifying) {
      alerts.push({
        kind: "instruction.needs_input",
        text: `"${clip(title, 80)}" stopped to ask a question nobody is there to answer: ${clip(reply, 200)}`,
        priority: "warn",
        dedupeKey: `instruction.needs_input:${run.schedule_id}`,
      });
    }

    const result: Record<string, unknown> = {
      mode: !live ? "shadow" : approval ? "awaiting_approval" : "live",
      calls: outcome.calls.map((c) => ({ name: c.name, ok: c.ok, ...(c.resultLine.includes(deps.proposedMark) ? { proposed: true } : {}) })),
      failed,
      clarifying: outcome.clarifying,
      reply: clip(reply, REPLY_MAX),
      ...(approval ? { draft: { reply: clip(reply, REPLY_MAX), proposed, title, destination } } : {}),
      ...(alerts.length ? { alerts } : {}),
    };

    let requestApproval: ApprovalRequest | undefined;
    if (approval) {
      requestApproval = {
        title: clip(`Approve: ${title}`, 200),
        description: clip(str(run.config?.summary) || instructions, 1000),
        action_type: TASK_KEY,
        draft_content: {
          instructions: clip(instructions, 2000),
          reply: clip(reply, REPLY_MAX),
          proposed_actions: proposed,
          output_destination: destination,
          external_effects: hasExternalEffects(run.config?.external_effects),
        },
      };
    }

    const prefix = !live ? "[shadow] " : approval ? "[awaiting approval] " : "";
    rec = {
      at: new Date().toISOString(),
      result: { summary: clip(`${prefix}${reply || "(no reply)"}`, SUMMARY_MAX), result, ...(requestApproval ? { requestApproval } : {}) },
      ownerDelivered: false,
    };
    // Stored BEFORE any delivery: from here on a re-presented run never re-runs the tools.
    await deps.store.set(key, rec);
  }

  // Live, no approval: the reply is the deliverable. Retried on re-presentation until it lands.
  if (live && !approval && !rec.ownerDelivered) {
    const text = String((rec.result.result as { reply?: unknown } | undefined)?.reply ?? "").trim();
    if (text) {
      const d = await deps.deliverToOwner({ title, text, destination }, ctx);
      if (d.ok) {
        rec = { ...rec, ownerDelivered: true };
        await deps.store.set(key, rec);
      } else {
        const prior = ((rec.result.result as { alerts?: unknown[] })?.alerts ?? []) as unknown[];
        return {
          ...rec.result,
          result: {
            ...(rec.result.result ?? {}),
            alerts: [...prior, {
              kind: "instruction.delivery_failed",
              text: `"${clip(title, 80)}" ran but its result could not be sent to the owner (${clip(d.error ?? "unknown", 160)}). The result is on this run.`,
              priority: "warn",
              dedupeKey: `instruction.delivery_failed:${run.schedule_id}`,
            }],
          },
        };
      }
    }
  }
  return rec.result;
}

// ── deliver (approved) ──────────────────────────────────────────────────────────────────────────

export async function deliverInstructionTask(r: ResolvedRun, ctx: PollContext, over: Partial<InstructionDeps> = {}): Promise<{ delivery?: Record<string, unknown> }> {
  // An approval that resolves after the operator turned CLARA_OS_TASKS down must not send. Throwing
  // leaves the run unconfirmed, so it delivers on the first active poll instead of being dropped.
  if (ctx.mode !== "active") throw new Error(`${TASK_KEY}: CLARA_OS_TASKS=${ctx.mode} — holding approved run ${r.run_id} until active`);
  const draft = (r.result?.draft ?? null) as { reply?: unknown; proposed?: unknown; title?: unknown; destination?: unknown } | null;
  if (!draft) throw new Error(`${TASK_KEY}: approved run ${r.run_id} carries no draft — nothing to deliver`);

  const deps = await resolveDeps(over);
  const key = `deliver:${r.run_id}`;
  let rec: DeliverRecord = (await deps.store.get<DeliverRecord>(key)) ?? { at: new Date().toISOString(), done: [], ownerDelivered: false };
  const title = str(draft.title) || "Scheduled task";
  const destination = str(draft.destination) || null;
  const reply = str(draft.reply);
  const proposed = (Array.isArray(draft.proposed) ? draft.proposed : []) as ProposedCall[];
  const ictx = intentCtx(r.run_id, false);

  const executed: Array<{ name: string; ok: boolean; line: string }> = [];
  for (let i = 0; i < proposed.length; i++) {
    if (rec.done.includes(i)) continue;
    const call = proposed[i];
    const out = await deps.runApprovedToolCall(String(call?.name ?? ""), (call?.args ?? {}) as Record<string, unknown>, ictx);
    executed.push({ name: String(call?.name ?? ""), ok: out.ok, line: clip(out.line, 300) });
    if (!out.ok) {
      // Unconfirmed → re-presents next poll; calls already done are skipped then.
      throw new Error(`${TASK_KEY}: approved ${call?.name} failed — ${clip(out.line, 200)}`);
    }
    rec = { ...rec, done: [...rec.done, i] };
    await deps.store.set(key, rec);
  }

  // Nothing to replay means the reply itself was the thing awaiting approval: send it now. With
  // replayed calls, a short confirmation instead. Either way, the owner hears once.
  if (!rec.ownerDelivered) {
    const text = proposed.length
      ? `Approved and done: ${proposed.map((p) => p.name).join(", ")}.${reply ? `\n\n${reply}` : ""}`
      : reply;
    if (text) {
      const d = await deps.deliverToOwner({ title, text, destination }, ctx);
      if (!d.ok && !proposed.length) throw new Error(`${TASK_KEY}: approved result could not be sent — ${d.error ?? "unknown"}`);
      if (d.ok) {
        rec = { ...rec, ownerDelivered: true };
        await deps.store.set(key, rec);
      }
    }
  }
  return { delivery: { executed: rec.done.length, calls: executed, ownerDelivered: rec.ownerDelivered } };
}
