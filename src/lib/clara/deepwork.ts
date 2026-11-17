// CLARA's deep-work wrapper — same contract as FRIDAY's (see its deepwork.ts):
// fire-and-forget around agent-core's runDeepWork, owning delivery (binary-safe upload into her
// work-account Drive under Deep Work/<date>) and notification (SMS/email via notifyOwner with links
// + NEEDS YOUR ATTENTION items, completion appended to the chat thread). Deliverables land in
// Drive ONLY, per the owner's 2026-08-13 decisions.

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { runDeepWork } from "@autom8ionlab/agent-core";
import { uploadBytes, ensureFolder } from "./ms-files";
import { notifyOwner } from "./notify";
import { appendMessage } from "./messages";
import { loadConfig } from "./config";

const MIME: Record<string, string> = {
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".txt": "text/plain",
  ".html": "text/html",
  ".png": "image/png",
  ".jpg": "image/jpeg",
};

function attentionItems(summary: string): string {
  const m = summary.match(/NEEDS YOUR ATTENTION:?\s*([\s\S]*)$/i);
  return m ? m[1].trim().slice(0, 900) : "";
}

/** Deliver a finished run: Drive upload, thread append, the owner notification. Returns the text. */
async function deliver(task: string, result: Awaited<ReturnType<typeof runDeepWork>>, startedAt: number, opts: { partialNote?: string } = {}): Promise<string> {
  const links: string[] = [];
  let folderNote = "";
  try {
    const deepFolder = await ensureFolder("Deep Work");
    const dated = deepFolder ? await ensureFolder(new Date().toISOString().slice(0, 10), deepFolder.id) : null;
    const destId = dated?.id ?? deepFolder?.id;
    for (const f of result.files) {
      const bytes = await fs.readFile(f.path).catch(() => null);
      if (!bytes) continue;
      const mime = MIME[path.extname(f.name).toLowerCase()] ?? "application/octet-stream";
      const up = await uploadBytes(f.name, bytes, mime, destId);
      if (up?.webViewLink) links.push(`${f.name}: ${up.webViewLink}`);
    }
    folderNote = dated?.webViewLink ?? deepFolder?.webViewLink ?? "";
  } catch { /* degrade to workspace-path mention below */ }

  const mins = Math.max(1, Math.round((Date.now() - startedAt) / 60000));
  const attention = attentionItems(result.summary);
  const okish = result.ok || (result.files.length > 0);
  const head = result.ok
    ? `Deep work done (${mins} min): ${task.slice(0, 120)}`
    : result.files.length
      ? `Deep work PARTIAL (${mins} min): ${task.slice(0, 120)} — ${opts.partialNote ?? result.error ?? "run ended early"}; delivering what was produced.`
      : `Deep work FAILED (${mins} min): ${task.slice(0, 120)} — ${result.error ?? "unknown"}. Nothing was produced.`;
  const text = [
    head,
    result.files.length
      ? (links.length ? `Files in Drive:\n${links.join("\n")}` : `Produced ${result.files.length} file(s) — Drive upload failed, they're in ${result.workspace}\\output`)
      : "",
    folderNote ? `Folder: ${folderNote}` : "",
    attention && !/^none\.?$/i.test(attention) ? `NEEDS YOUR ATTENTION:\n${attention}` : "",
  ].filter(Boolean).join("\n\n");

  // Non-critical successes queue through quiet hours and arrive with the morning digest — that IS
  // the overnight-shift delivery contract. True failures stay critical and page.
  await notifyOwner({ kind: "deepwork.done", text, priority: okish ? "normal" : "critical" }).catch(() => {});
  await appendMessage("clara", text).catch(() => {});
  return text;
}

/** Immediate mode — unchanged public contract: fire-and-forget with completion delivery. */
export function startDeepWork(task: string, opts: { clientName?: string } = {}): { started: true; line: string } {
  void (async () => {
    const startedAt = Date.now();
    const cfg = await loadConfig();
    const result = await runDeepWork({
      agent: "clara",
      dataDir: cfg.dataDir,
      task,
      client: opts.clientName,
      bin: process.env.CLARA_CLAUDE_BIN || "claude",
    });
    await deliver(task, result, startedAt);
  })();

  return {
    started: true,
    line: "deep_work: started — this is a real build (research, documents, review), so it'll take a while. I'll ping you with the Drive links and anything that needs your call when it's done.",
  };
}

// ── Overnight shift (JARVIS-pivot Track B) ──────────────────────────────────────────────────────

import { WorkQueue, type Job } from "@autom8ionlab/agent-core";

let queueSingleton: WorkQueue | null = null;
async function queue(): Promise<WorkQueue> {
  if (!queueSingleton) {
    const cfg = await loadConfig();
    queueSingleton = new WorkQueue({ dataDir: cfg.dataDir });
  }
  return queueSingleton;
}

/** Queue a deep-work task for the overnight worker instead of running it now. */
export async function enqueueDeepWork(task: string, opts: { clientName?: string; notBefore?: string } = {}): Promise<{ id: string; line: string }> {
  const q = await queue();
  const job = await q.enqueue({
    agent: "clara",
    kind: "deepwork",
    payload: { task, clientName: opts.clientName },
    notBefore: opts.notBefore,
  });
  return {
    id: job.id,
    line: `deep_work: queued for the overnight shift (#${job.id.slice(-5)}) — it runs unattended and the morning digest carries the links and anything needing your call.`,
  };
}

export async function listQueue(): Promise<Job[]> {
  return (await queue()).all();
}

export async function cancelQueued(id: string): Promise<Job | null> {
  return (await queue()).cancel(id);
}

// One job at a time, guarded in-process: the scheduler tick is re-entrant for our own pid (the
// lock is ours), so a boolean is what actually prevents a second concurrent claim.
let working = false;

/**
 * One worker tick: sweep the queue (dead-worker recovery — partials get DELIVERED, not re-run),
 * then claim and execute at most one job to completion. Called by CLARA's scheduler as a detached
 * job; serial by design — one CLI session at a time is the whole point of a night shift.
 */
export async function runOvernightWorkerTick(log: (m: string) => void = () => {}): Promise<void> {
  if (working) return;
  working = true;
  try {
    const q = await queue();
    if (!(await q.acquireLock())) return; // another process owns the shift

    const swept = await q.sweep();
    for (const j of swept.partials) {
      // The dead worker's output survives in its workspace — deliver it honestly.
      const task = String((j.payload as { task?: string }).task ?? "(unknown task)");
      log(`sweep: delivering partial output of ${j.id}`);
      await deliver(task, {
        ok: false,
        summary: "",
        files: await collectWorkspaceFiles(j.workspace),
        workspace: j.workspace ?? "",
        toolUsage: {}, // dead worker — no tool-usage evidence survived
        error: "worker died mid-run",
      }, Date.now(), { partialNote: "a previous worker died mid-run" }).catch(() => {});
    }
    for (const j of swept.requeued) log(`sweep: re-queued ${j.id} (attempt ${j.attempts}/${j.maxAttempts})`);
    for (const j of swept.failed) log(`sweep: failed ${j.id} at the attempt ceiling`);

    const job = await q.claimNext();
    if (!job) return;
    const task = String((job.payload as { task?: string }).task ?? "");
    const clientName = (job.payload as { clientName?: string }).clientName;
    log(`claimed ${job.id}: ${task.slice(0, 80)}`);

    const cfg = await loadConfig();
    const startedAt = Date.now();
    const result = await runDeepWork({
      agent: "clara",
      dataDir: cfg.dataDir,
      task,
      client: clientName,
      bin: process.env.CLARA_CLAUDE_BIN || "claude",
      // Recorded BEFORE the session starts so a crash mid-run sweeps into partial recovery.
      onWorkspace: (dir) => void q.markRunning(job.id, dir).catch(() => {}),
    });
    const text = await deliver(task, result, startedAt);
    await q.complete(job.id, { ok: result.ok, partial: !result.ok && result.files.length > 0, result: text.slice(0, 400) });
    log(`finished ${job.id}: ${result.ok ? "done" : result.files.length ? "partial" : "failed"}`);
  } finally {
    working = false;
  }
}

async function collectWorkspaceFiles(workspace: string | undefined): Promise<{ path: string; name: string; bytes: number }[]> {
  if (!workspace) return [];
  const out: { path: string; name: string; bytes: number }[] = [];
  const dir = path.join(workspace, "output");
  const names = await fs.readdir(dir).catch(() => [] as string[]);
  for (const n of names) {
    const p = path.join(dir, n);
    const st = await fs.stat(p).catch(() => null);
    if (st?.isFile()) out.push({ path: p, name: n, bytes: st.size });
  }
  return out;
}
