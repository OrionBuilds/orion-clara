// Escalation rail (owner-comms overhaul, 2026-09-24): FRIDAY never texts or calls the
// owner themselves. When something is a genuine emergency — production down, a security finding,
// money running away — they POST it here and CLARA decides how to reach the owner. She is the ONE voice
// allowed on their phone.
//
// Decision: category production|security|revenue → notifyOwner critical with that emergency
// category (the policy pages by SMS + a spoken call, ignoring quiet hours); anything else, or a
// duplicate within the dedupe window, → immediate email only. Every escalation also lands in the
// shared thread and the ledger, and a durable email copy carries the full detail and links.
//
// Gated by the interagent secret like every sibling-facing surface (loopback callers clear it).

import { NextRequest, NextResponse } from "next/server";
import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import { verifyInteragentSecret, type EscalationRequest, type EscalationResponse } from "@autom8ionlab/agent-core";
import { notifyOwner } from "@/lib/clara/notify";
import { sendMail } from "@/lib/clara/ms-mail";
import { loadConfig } from "@/lib/clara/config";
import { appendMessage } from "@/lib/clara/messages";
import { append as ledgerAppend } from "@/lib/clara/ledger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FROM = new Set(["friday"]);
const CATEGORIES = new Set(["production", "security", "revenue"]);
const DEDUPE_FILE = path.join(os.homedir(), ".agentic-os", "clara", "escalations.json");
const DEDUPE_MS = 6 * 60 * 60 * 1000;

type Seen = Record<string, { at: string; id: string }>;

async function loadSeen(): Promise<Seen> {
  try { return JSON.parse(await fs.readFile(DEDUPE_FILE, "utf8")) as Seen; } catch { return {}; }
}
async function saveSeen(s: Seen): Promise<void> {
  const cutoff = Date.now() - DEDUPE_MS;
  for (const [k, v] of Object.entries(s)) if (new Date(v.at).getTime() < cutoff) delete s[k];
  await fs.mkdir(path.dirname(DEDUPE_FILE), { recursive: true }).catch(() => {});
  const tmp = `${DEDUPE_FILE}.${process.pid}.${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(s, null, 2), "utf8");
  await fs.rename(tmp, DEDUPE_FILE);
}

// In-process serialisation of check-and-reserve: two escalations arriving together must not both
// read the file before either writes. (One Node process serves this route.)
let seenLock: Promise<unknown> = Promise.resolve();
function withSeenLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = seenLock.then(fn, fn);
  seenLock = run.catch(() => undefined);
  return run;
}

const clean = (s: unknown, max: number): string =>
  String(s ?? "").replace(/[\p{Extended_Pictographic}️‍]/gu, "").replace(/\s+/g, " ").trim().slice(0, max);

function validate(body: Record<string, unknown>): { ok: true; req: EscalationRequest } | { ok: false; error: string } {
  const from = String(body.from ?? "").toLowerCase();
  const category = String(body.category ?? "").toLowerCase();
  const headline = clean(body.headline, 120);
  const detail = String(body.detail ?? "").trim().slice(0, 2000);
  const dedupeKey = String(body.dedupeKey ?? "").trim().slice(0, 200);
  if (!FROM.has(from)) return { ok: false, error: "from must be friday" };
  if (!CATEGORIES.has(category)) return { ok: false, error: "category must be production|security|revenue" };
  if (!headline) return { ok: false, error: "headline required" };
  if (!dedupeKey) return { ok: false, error: "dedupeKey required" };
  const rawLinks = Array.isArray(body.links) ? body.links : [];
  const links = rawLinks
    .map((l) => (l && typeof l === "object" ? { label: clean((l as { label?: unknown }).label, 60), url: String((l as { url?: unknown }).url ?? "").trim() } : null))
    .filter((l): l is { label: string; url: string } => !!l && /^https?:\/\//i.test(l.url))
    .slice(0, 6);
  const src = (body.source && typeof body.source === "object" ? body.source : {}) as { app?: unknown; kind?: unknown; refId?: unknown };
  const nd = body.needsDecision && typeof body.needsDecision === "object" ? (body.needsDecision as { question?: unknown; options?: unknown }) : undefined;
  return {
    ok: true,
    req: {
      from: from as EscalationRequest["from"],
      kind: "escalate",
      category: category as EscalationRequest["category"],
      headline,
      detail,
      links,
      dedupeKey,
      occurredAt: typeof body.occurredAt === "string" && !Number.isNaN(Date.parse(body.occurredAt)) ? body.occurredAt : new Date().toISOString(),
      source: { app: from as EscalationRequest["from"], kind: clean(src.kind, 80) || "unknown", ...(src.refId ? { refId: String(src.refId).slice(0, 80) } : {}) },
      ...(body.suggestedAction ? { suggestedAction: clean(body.suggestedAction, 200) } : {}),
      ...(nd?.question ? { needsDecision: { question: clean(nd.question, 240), options: Array.isArray(nd.options) ? nd.options.map((o) => clean(o, 40)).filter(Boolean).slice(0, 4) : [] } } : {}),
      ...(body.clientName ? { clientName: clean(body.clientName, 80) } : {}),
    },
  };
}

const WHO: Record<string, string> = { production: "production is affected", security: "this is a security matter", revenue: "money is at risk" };

/** Vault memory for an escalation (first report or repeat). Best-effort: never blocks the response. */
async function rememberEscalation(e: EscalationRequest, outcome: string): Promise<void> {
  try {
    const { recordOutcome, shortHash } = await import("@/lib/clara/vaultMemory");
    // Same identity as the dedupe key, hashed so slugging/truncation can't merge distinct escalations.
    await recordOutcome({ thread: `escalation-${e.from}-${e.category}-${shortHash(`${e.from}:${e.category}:${e.dedupeKey}`, 16)}`, kind: "escalation", status: "open",
      title: `${e.from.toUpperCase()} emergency (${e.category}): ${e.headline}`, subject: e.clientName,
      outcome, done: e.detail.slice(0, 600), next: e.suggestedAction,
      links: e.links });
  } catch { /* memory is best-effort */ }
}

export async function POST(req: NextRequest) {
  if (!verifyInteragentSecret(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const parsed: unknown = await req.json().catch(() => ({}));
  const body = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  const v = validate(body);
  if (!v.ok) return NextResponse.json({ ok: false, via: "escalate", error: v.error } satisfies EscalationResponse, { status: 400 });
  const e = v.req;
  const agent = e.from.toUpperCase();
  const id = `esc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;

  // Dedupe is scoped to the reporting agent and category: different agents' keys never
  // collide, and the same key with a different category is a different emergency. The reservation
  // is made only after a delivery channel succeeded (below) so a failed page can be retried.
  const scopedKey = `${e.from}:${e.category}:${e.dedupeKey}`;
  const prior = await withSeenLock(async () => {
    const seen = await loadSeen();
    const p = seen[scopedKey];
    return p && Date.now() - new Date(p.at).getTime() < DEDUPE_MS ? p : null;
  });
  const duplicate = Boolean(prior);

  const link = e.links[0]?.url;
  const smsText = [
    `${agent} emergency: ${e.headline}.`,
    e.suggestedAction ? `Suggested: ${e.suggestedAction}.` : "",
    e.needsDecision?.question ? `${e.needsDecision.question}` : "",
    link ? link : "",
    "Details are in your email.",
  ].filter(Boolean).join(" ").slice(0, 600);
  const callText = `Sir, ${agent} has flagged an emergency: ${e.headline}. ${WHO[e.category] ?? ""}. ${e.suggestedAction ? `Suggested action: ${e.suggestedAction}.` : ""} The details are in your email.`;

  // Thread + ledger first, so the context exists even if delivery fails. Duplicates are recorded
  // too: the thread and ledger are the audit trail, only the page is suppressed.
  await appendMessage("clara", `${agent} escalation (${e.category}${duplicate ? ", repeat" : ""}): ${e.headline}${e.detail ? ` — ${e.detail.slice(0, 400)}` : ""}`).catch(() => {});
  await ledgerAppend({
    kind: "action", actor: "clara", what: `escalation ${duplicate ? "repeated" : "received"} from ${e.from}: ${e.headline}`,
    meta: { id, category: e.category, dedupeKey: scopedKey, source: e.source, links: e.links, clientName: e.clientName, ...(prior ? { priorId: prior.id } : {}) },
  }).catch(() => {});

  // Durable copy with the full detail — always, duplicate or not.
  let emailed = false;
  try {
    const cfg = await loadConfig();
    const to = cfg.principals.owner.emails[0];
    if (to) {
      const bodyLines = [
        `What happened`, e.headline, "", e.detail || "(no further detail provided)", "",
        `Why it matters`, `${agent} classed this as ${e.category}${e.clientName ? ` for ${e.clientName}` : ""} — ${WHO[e.category] ?? ""}.`, "",
        `What ${agent} suggests`, e.suggestedAction || "Nothing specific — review the links below.", "",
        ...(e.needsDecision?.question ? [`Your call`, `${e.needsDecision.question}${e.needsDecision.options.length ? ` (${e.needsDecision.options.join(" / ")})` : ""}`, `Reply to this email in plain words, or tell me on the phone.`, ""] : []),
        ...(e.links.length ? [`Links`, ...e.links.map((l) => `${l.label || "Link"}: ${l.url}`), ""] : []),
        `Reported ${e.occurredAt} via ${e.source.kind}${e.source.refId ? ` (${e.source.refId})` : ""}.`,
      ];
      const r = await sendMail({ to, subject: `Emergency from ${agent}: ${e.headline}`, body: bodyLines.join("\n"), headers: { "X-Clara-Notify": "1", "X-Agent": "clara", "X-Escalation-Id": id } });
      emailed = r.ok;
    }
  } catch { /* email is best-effort; the page below is the primary path */ }

  if (duplicate && prior) {
    // Repeat within the window: email + thread + ledger happened above; the page is not repeated.
    // Vault memory still gets the repeat's detail on the same escalation thread.
    await rememberEscalation(e, `Repeated within the dedupe window; page suppressed${emailed ? ", details emailed" : ""}.`);
    await ledgerAppend({ kind: "action", actor: "clara", what: `escalation deduped (page suppressed): ${e.from}: ${e.headline}`, meta: { id, priorId: prior.id, emailed } }).catch(() => {});
    return NextResponse.json({ ok: true, id: prior.id, action: "deduped", via: "escalate" } satisfies EscalationResponse);
  }

  const n = await notifyOwner({
    kind: `escalation.${e.from}.${e.category}`,
    text: smsText,
    priority: "critical",
    emergencyCategory: e.category,
    call: true,
    callText,
    dedupeKey: `escalation:${scopedKey}`,
  }).catch(() => ({ sms: false, call: false, queued: false as const }));

  // The reservation is for the PAGE. Email alone does not reserve it: if the page failed but the
  // email went out, the caller's retry must be allowed to page again, not be told "deduped".
  const paged = n.call || n.sms || n.queued;
  if (!paged && !emailed) {
    // Nothing reached the owner and nothing is queued: do NOT reserve the key — the caller's retry (or
    // its own email fallback) must get a fresh attempt, not a "deduped" acknowledgement.
    await ledgerAppend({ kind: "action", actor: "clara", what: `escalation delivery FAILED on every channel: ${e.from}: ${e.headline}`, meta: { id } }).catch(() => {});
    return NextResponse.json({ ok: false, id, via: "escalate", error: "no delivery channel succeeded — retry" } satisfies EscalationResponse, { status: 503 });
  }
  if (paged) {
    await withSeenLock(async () => {
      const seen = await loadSeen();
      seen[scopedKey] = { at: new Date().toISOString(), id };
      await saveSeen(seen);
    }).catch(() => {});
  }

  const action: EscalationResponse["action"] = n.call ? "called" : n.sms ? "texted" : n.queued ? "queued" : "emailed";
  await rememberEscalation(e, `Handled by ${action}.`);
  await ledgerAppend({ kind: "action", actor: "clara", what: `escalation handled: ${action} (${e.from}: ${e.headline})`, meta: { id, sms: n.sms, call: n.call, queued: n.queued, emailed } }).catch(() => {});
  return NextResponse.json({ ok: true, id, action, via: "escalate" } satisfies EscalationResponse);
}
