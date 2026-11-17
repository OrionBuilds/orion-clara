// Clara — act on a meeting digest: file tasks, hand work to FRIDAY, write the vault note,
// tell the owner after the fact.
//
// No owner approval sits in this path on purpose: the meeting itself was the approval — the owner was
// in the room when the work was assigned. Money-flagged items still dispatch, but the preamble
// carries an explicit flag so the receiving agent applies its OWN spend gate (FRIDAY holds money
// approvals; CLARA does not pre-empt them). FRIDAY items get ONE message per
// agent per meeting, and a tracking task on Clara's book (assignee friday, status doing,
// dispatchedRef = the receipt) that never syncs to the owner's Google Tasks.
//
// Modes: "active" does all of the above; "shadow" writes the note (every line reading "would …")
// and sends the owner a "SHADOW:"-prefixed digest, but files and dispatches NOTHING.

import { promises as fs } from "node:fs";
import path from "node:path";
import { loadConfig } from "../config";
import { add as addTask } from "../tasks";
import { dispatchTo, type DispatchResult } from "../routing";
import { notifyOwner } from "../notify";
import { writeNote } from "../vault";
import { sliceTranscript } from "./digest";
import { resolveClient } from "./resolve";
import { sourceKey as keyOf } from "./seen";
import type { DigestItem, IngestMode, ItemOwner, MeetingDigest, MeetingRecord, Roster } from "./types";

type Agent = "friday";
const AGENTS: readonly Agent[] = ["friday"];
const LABEL: Record<ItemOwner, string> = { owner: "the owner", clara: "CLARA", friday: "FRIDAY" };

export interface ResolvedItem extends DigestItem {
  /** 1-based position in the digest — stable half of the item's ref. */
  n: number;
}

export interface ItemReceipt {
  n: number;
  owner: ItemOwner;
  taskId?: string;
  /** e.g. "friday:t_123,t_124" | "friday:indeterminate" | "friday:failed" */
  dispatchedRef?: string;
  error?: string;
}

export interface FileResult {
  mode: IngestMode;
  sourceKey: string;
  notePath: string;
  receipts: ItemReceipt[];
  dispatches: { agent: Agent; ok: boolean; indeterminate?: boolean; taskIds?: string[]; error?: string }[];
  notified: boolean;
}

// ── Pure helpers (tested) ────────────────────────────────────────────────────
export function localDate(iso: string, timeZone?: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "an unknown date";
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone });
}

export function itemRef(sourceKey: string, n: number): string {
  return `clara-meeting:${sourceKey}#${n}`;
}

const MONEY_FLAG = "Flag: likely costs money — apply your spend gate.";

/**
 * The single message one agent gets for one meeting. Numbered when it carries ≥2 items; client /
 * project go in the header when every item agrees and per-item otherwise.
 */
export function buildPreamble(
  rec: Pick<MeetingRecord, "title" | "startedAt" | "attendees">,
  items: ResolvedItem[],
  sourceKey: string,
  opts: { timeZone?: string } = {},
): string {
  const who = rec.attendees.length ? rec.attendees.join(", ") : "unknown attendees";
  const clients = new Set(items.map((i) => i.client ?? ""));
  const projects = new Set(items.map((i) => i.project ?? ""));
  const uniform = clients.size <= 1 && projects.size <= 1;
  const c0 = items[0]?.client || "unknown";
  const p0 = items[0]?.project || "—";
  const header = `From CLARA — meeting "${rec.title}" on ${localDate(rec.startedAt, opts.timeZone)} with ${who}. `
    + (uniform ? `Client: ${c0}. Project: ${p0}.` : "Client/project: see each task.");

  const block = (i: ResolvedItem, prefix: string, indent: string): string[] => [
    `${prefix}Task: ${i.item}${i.due ? ` (due ${i.due})` : ""}`,
    ...(uniform ? [] : [`${indent}Client: ${i.client || "unknown"}. Project: ${i.project || "—"}.`]),
    `${indent}Context: ${i.why || "raised in the meeting"}`,
    ...(i.costsMoney ? [`${indent}${MONEY_FLAG}`] : []),
    `${indent}Ref: ${itemRef(sourceKey, i.n)}`,
  ];

  if (items.length === 1) return [header, ...block(items[0], "", "")].join("\n");
  return [header, ...items.flatMap((i, k) => block(i, `${k + 1}. `, "   "))].join("\n");
}

export function slugify(s: string): string {
  return s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60).replace(/-+$/, "") || "meeting";
}

export function ymdLocal(iso: string, timeZone?: string): string {
  const d = new Date(iso);
  const safe = Number.isNaN(d.getTime()) ? new Date() : d;
  // en-CA formats as YYYY-MM-DD.
  return safe.toLocaleDateString("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone });
}

export function notePathFor(rec: Pick<MeetingRecord, "title" | "startedAt">, timeZone?: string): string {
  return `meetings/${ymdLocal(rec.startedAt, timeZone)}-${slugify(rec.title)}.md`;
}

function yamlStr(v: string): string { return JSON.stringify(v); }

function receiptLine(i: ResolvedItem, r: ItemReceipt | undefined, mode: IngestMode): string {
  const tags = [
    i.client ? `client: ${i.client}` : "",
    i.project ? `project: ${i.project}` : "",
    i.due ? `due ${i.due}` : "",
    i.costsMoney ? "COSTS MONEY" : "",
  ].filter(Boolean).join(", ");
  const isAgent = i.owner === "friday";
  let receipt: string;
  if (mode !== "active") {
    receipt = isAgent ? `would dispatch to ${LABEL[i.owner]}` : `would file for ${LABEL[i.owner]}`;
  } else if (!r) {
    receipt = "not filed";
  } else if (isAgent) {
    receipt = r.error
      ? `dispatch to ${LABEL[i.owner]} FAILED (${r.error}) — filed for CLARA to chase${r.taskId ? `, task ${r.taskId}` : ""}`
      : `dispatched → ${r.dispatchedRef ?? LABEL[i.owner]}${r.taskId ? ` (tracking task ${r.taskId})` : ""}`;
  } else {
    receipt = r.taskId ? `task ${r.taskId}` : `not filed${r.error ? ` (${r.error})` : ""}`;
  }
  return `${i.n}. **[${LABEL[i.owner]}]** ${i.item}${tags ? ` _(${tags})_` : ""}\n   - why: ${i.why || "—"}\n   - ${receipt}`;
}

/** Full vault note. Pure — the shadow fixture test renders this. */
export function renderNote(
  rec: MeetingRecord,
  digest: MeetingDigest,
  items: ResolvedItem[],
  opts: { mode: IngestMode; sourceKey: string; receipts?: ItemReceipt[]; generatedAt?: string },
): string {
  const fm = [
    "---",
    `source: ${rec.source}`,
    `sourceId: ${yamlStr(rec.sourceId)}`,
    `title: ${yamlStr(rec.title)}`,
    `start: ${rec.startedAt}`,
    rec.endedAt ? `end: ${rec.endedAt}` : null,
    `attendees: [${rec.attendees.map(yamlStr).join(", ")}]`,
    rec.attendeeEmails?.length ? `attendeeEmails: [${rec.attendeeEmails.map(yamlStr).join(", ")}]` : null,
    rec.shareLink ? `shareLink: ${yamlStr(rec.shareLink)}` : null,
    rec.calendarEventId ? `calendarEventId: ${yamlStr(rec.calendarEventId)}` : null,
    `mode: ${opts.mode}`,
    `ref: ${yamlStr(`clara-meeting:${opts.sourceKey}`)}`,
    digest.injection?.triggered ? "injectionFlagged: true" : null,
    `digestedAt: ${opts.generatedAt ?? new Date().toISOString()}`,
    "---",
  ].filter((l): l is string => l !== null);

  const byN = new Map((opts.receipts ?? []).map((r) => [r.n, r]));
  const transcript = rec.vaultTranscriptPath
    ? `Saved with the call: [[${rec.vaultTranscriptPath.replace(/\.md$/, "")}]]`
    : rec.transcript.trim()
      ? ["```text", sliceTranscript(rec.transcript, 150_000, 50_000).replace(/```/g, "'''"), "```"].join("\n")
      : "_(no transcript)_";

  return [
    ...fm,
    "",
    `# ${rec.title}`,
    "",
    opts.mode === "shadow" ? "> SHADOW run — nothing below was filed or dispatched. Lines read \"would …\"." : "",
    "",
    digest.injection?.triggered
      ? `> WARNING: the prompt-injection detector fired on this transcript (${digest.injection.reasons.join("; ")}). Every item was forced to the owner — nothing was sent to another agent.`
      : "",
    "",
    `**When:** ${localDate(rec.startedAt)} · **Source:** ${rec.source}${rec.shareLink ? ` · [open](${rec.shareLink})` : ""}`,
    `**Attendees:** ${rec.attendees.length ? rec.attendees.join(", ") : "unknown"}`,
    "",
    "## Summary",
    "",
    digest.summary || "_(none)_",
    "",
    "## Decisions",
    "",
    digest.decisions.length ? digest.decisions.map((d) => `- ${d}`).join("\n") : "- _(none recorded)_",
    "",
    "## Tasks",
    "",
    items.length ? items.map((i) => receiptLine(i, byN.get(i.n), opts.mode)).join("\n") : "- _(no action items)_",
    "",
    "## Transcript",
    "",
    transcript,
    "",
  ].filter((l, k, a) => !(l === "" && a[k - 1] === "")).join("\n");
}

/** Post-hoc SMS/digest line for the owner. Pure. */
export function buildNotifyText(
  rec: Pick<MeetingRecord, "title">,
  items: ResolvedItem[],
  opts: { mode: IngestMode; notePath: string; receipts?: ItemReceipt[]; injection?: boolean },
): string {
  const count = (o: ItemOwner) => items.filter((i) => i.owner === o).length;
  const failed = (opts.receipts ?? []).filter((r) => r.error).length;
  const money = items.filter((i) => i.costsMoney).length;
  const verb = opts.mode === "active" ? "sent" : "would send";
  const parts = [
    `Meeting "${rec.title}" digested — ${items.length} item${items.length === 1 ? "" : "s"}.`,
    count("owner") ? `Yours (${count("owner")}): ${items.filter((i) => i.owner === "owner").slice(0, 3).map((i) => i.item).join("; ")}${count("owner") > 3 ? "; …" : ""}.` : "",
    count("clara") ? `CLARA ${count("clara")}.` : "",
    count("friday") ? `FRIDAY ${count("friday")} (${verb}).` : "",
    money ? `${money} flagged as costing money.` : "",
    failed ? `${failed} dispatch${failed === 1 ? "" : "es"} failed — on my list to chase.` : "",
    opts.injection ? "Injection detector fired — everything assigned to you." : "",
    `Note: ${opts.notePath}`,
  ].filter(Boolean).join(" ");
  return `${opts.mode === "shadow" ? "SHADOW: " : ""}${parts}`.slice(0, 700);
}

export function resolveItems(rec: MeetingRecord, digest: MeetingDigest, roster: Roster): ResolvedItem[] {
  return digest.items.map((i, k) => {
    const r = resolveClient(i, rec, roster);
    return { ...i, client: r.client ?? i.client, project: r.project ?? i.project, n: k + 1 };
  });
}

function dueIso(due?: string): string | undefined {
  if (!due || !/^\d{4}-\d{2}-\d{2}$/.test(due)) return undefined;
  const d = new Date(`${due}T12:00:00`);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

function taskDetail(rec: MeetingRecord, i: ResolvedItem, extra?: string): string {
  return [
    i.why ? `Why: ${i.why}` : "",
    `From meeting "${rec.title}" (${localDate(rec.startedAt)})${rec.shareLink ? ` — ${rec.shareLink}` : ""}`,
    i.client ? `Client: ${i.client}` : "",
    i.project ? `Project: ${i.project}` : "",
    // Agent tracking rows carry the due date in text only: a real dueAt would make deadline-scan
    // page the owner about FRIDAY's deadlines.
    i.due && i.owner === "friday" ? `Due: ${i.due}` : "",
    i.costsMoney ? "Likely costs money." : "",
    extra ?? "",
  ].filter(Boolean).join("\n");
}

async function uniqueNotePath(rel: string, sourceId: string): Promise<string> {
  const cfg = await loadConfig();
  const base = rel.replace(/\.md$/, "");
  for (let k = 1; k < 50; k++) {
    const cand = k === 1 ? rel : `${base}-${k}.md`;
    try {
      const raw = await fs.readFile(path.join(cfg.vaultRoot, cand), "utf8");
      if (raw.includes(`sourceId: ${yamlStr(sourceId)}`)) return cand; // same meeting — overwrite
    } catch {
      return cand; // free
    }
  }
  return `${base}-${Date.now()}.md`;
}

function receiptRef(agent: Agent, r: DispatchResult): string {
  if (r.ok) return `${agent}:${r.taskIds?.length ? r.taskIds.join(",") : r.runId ?? "sent"}`;
  return r.indeterminate ? `${agent}:indeterminate` : `${agent}:failed`;
}

/**
 * Carry out a digest. `mode` "off" never reaches here (ingest.ts short-circuits); anything but
 * "active" is treated as shadow.
 */
export async function fileAndDispatch(
  rec: MeetingRecord,
  digest: MeetingDigest,
  mode: IngestMode,
  roster: Roster,
): Promise<FileResult> {
  const sk = keyOf(rec);
  const effective: IngestMode = mode === "active" ? "active" : "shadow";
  const items = resolveItems(rec, digest, roster);
  const receipts: ItemReceipt[] = [];
  const dispatches: FileResult["dispatches"] = [];

  if (effective === "active") {
    // Agents first, so a failed hand-off can fall back onto Clara's own book below.
    for (const agent of AGENTS) {
      const mine = items.filter((i) => i.owner === agent);
      if (!mine.length) continue;
      let res: DispatchResult;
      try {
        res = await dispatchTo(agent, buildPreamble(rec, mine, sk));
      } catch (e) {
        res = { ok: false, target: agent, error: String((e as Error).message ?? e).slice(0, 160) };
      }
      dispatches.push({ agent, ok: res.ok, indeterminate: res.indeterminate, taskIds: res.taskIds, error: res.error });
      const ref = receiptRef(agent, res);
      for (const i of mine) {
        // Indeterminate = probably delivered (see routing.ts) — track it as handed off, not failed.
        const delivered = res.ok || res.indeterminate;
        const t = await addTask({
          title: i.item,
          detail: taskDetail(rec, i, delivered ? `Handed to ${LABEL[agent]}: ${ref}` : `Dispatch to ${LABEL[agent]} failed: ${res.error ?? "unknown"} — chase or re-send.`),
          status: delivered ? "doing" : "open",
          assignee: delivered ? agent : "clara",
          dispatchedRef: ref,
          source: itemRef(sk, i.n),
          tags: ["meeting", ...(i.costsMoney ? ["costs-money"] : [])],
        }).catch(() => null);
        receipts.push({ n: i.n, owner: i.owner, taskId: t?.id, dispatchedRef: ref, error: delivered ? undefined : (res.error ?? "dispatch failed") });
      }
    }
    for (const i of items.filter((x) => x.owner === "owner" || x.owner === "clara")) {
      try {
        const t = await addTask({
          title: i.item,
          detail: taskDetail(rec, i),
          status: "open",
          assignee: i.owner,
          dueAt: dueIso(i.due),
          source: itemRef(sk, i.n),
          tags: ["meeting", ...(i.costsMoney ? ["costs-money"] : [])],
        });
        receipts.push({ n: i.n, owner: i.owner, taskId: t.id });
      } catch (e) {
        receipts.push({ n: i.n, owner: i.owner, error: String((e as Error).message ?? e).slice(0, 120) });
      }
    }
  }

  const notePath = await uniqueNotePath(notePathFor(rec), rec.sourceId);
  await writeNote(notePath, renderNote(rec, digest, items, { mode: effective, sourceKey: sk, receipts }), { actor: "clara" });
  // writeNote already re-indexes the note (fire-and-forget) under the `meetings` provenance tag.

  let notified = false;
  try {
    const r = await notifyOwner({
      kind: "meeting.digest",
      priority: "normal",
      dedupeKey: `meeting-digest:${sk}`,
      text: buildNotifyText(rec, items, { mode: effective, notePath, receipts, injection: digest.injection?.triggered }),
    });
    notified = r.sms || r.queued || Boolean(r.email);
  } catch { /* post-hoc courtesy — never fails the ingest */ }

  return { mode: effective, sourceKey: sk, notePath, receipts, dispatches, notified };
}
