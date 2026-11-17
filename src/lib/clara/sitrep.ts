// Clara — one grounded picture of the whole operation, for answering "status" / "what's down"
// from a phone and for grounding her conversational replies.
//
// The problem this solves: Clara's SMS replies were pure LLM output with memory-RAG and no live
// state at all, so "is everything running?" got a fluent answer assembled from nothing. FRIDAY has
// had grounding since ownerChat.ts; Clara — the one chosen as the front door — did not.
//
// Everything here is READ-ONLY and best-effort. A probe that fails becomes "unknown" in the report
// rather than throwing, because a status command must still answer when half the estate is down —
// that is precisely when it is asked. The two failure shapes are kept distinct: `up: false` means
// the probe completed and the agent is not serving; `up: null` means we could not tell.

import { promises as fs } from "node:fs";
import path from "node:path";
import { loadConfig } from "./config";
import { fridayHealth } from "./friday-bridge";
import { listPending, shortCode } from "./approvals";
import { summarizeAgentApprovals, type AgentApprovalsSummary } from "./agentProxy";

export type AgentName = "clara" | "friday";

export interface AgentLine {
  name: AgentName;
  /** true = serving, false = probed and not serving, null = could not determine. */
  up: boolean | null;
  detail?: string;
}

export interface Sitrep {
  agents: AgentLine[];
  approvals: {
    clara: number;
    friday: number;
    /** True when a count came from agentProxy's cache because the agent was unreachable. */
    stale: { friday: boolean };
    oldest: AgentApprovalsSummary["oldest"];
    claraOldest: Array<{ code: string; title: string }>;
  };
  brain: { lmStudioModels: number | null };
  /**
   * Is the orion link alive?
   *
   * Absent until 2026-08-03, and its absence cost four hours: when Clara's OS refresh token was
   * revoked, /api/system/health kept returning 200, sitrep kept reporting three green agents, and
   * the ONLY symptom was that her scheduled OS work silently stopped being claimed. Every surface
   * that could have said so was looking somewhere else. api/os/auth/route.ts documents that
   * outage in a comment; this is the check that would have caught it.
   */
  os: { signedIn: boolean; identity?: string; detail?: string };
  /**
   * What Clara's own reasoning has cost today, and the local-vs-paid split. Not the client-money
   * controls — this is her token bill. Until 2026-08-03 she had no cost accounting at all.
   */
  spend: { todayUsd: number; capUsd: number; byEngine: Record<string, { calls: number; costUsd: number }> };
  /**
   * Each agent's autonomy modes. Part of status because "what is running" is incomplete without
   * "how much is it allowed to do on its own" — and because these are now changeable by text, so
   * the answer can differ from whatever the env file says.
   */
  autonomy: Array<{ agent: "friday"; dials: Array<{ name: string; value: string }> }>;
  /**
   * Whether agent-to-agent auth actually works with each agent. "unauthorized" means the shared
   * secret differs (or is missing on one side) — the failure that silently degrades routing and
   * the money relay rather than breaking them visibly, so it is worth reporting.
   */
  interagent: Array<{ agent: "friday"; auth: "ok" | "unauthorized" | "unreachable" }>;
  /** Scheduled jobs skipped while Clara was down, in the last 7 days. */
  missedFires: number;
  generatedAt: string;
}

/**
 * Recognize the status verb. Deliberately anchored and narrow — this intercepts the message before
 * the conversational LLM ever sees it, so a loose pattern would silently swallow real conversation.
 * "everything ok?" is NOT here on purpose: it reads as small talk at least as often as a health
 * check, and mis-routing it costs a real reply. Anything not matched still reaches the LLM, which
 * now gets the same live state as context — so a near-miss degrades to a grounded answer, not a
 * wrong one.
 */
export function isStatusCommand(text: string): boolean {
  const t = text.trim().toLowerCase().replace(/[?!.]+$/, "");
  return (
    /^(status|sitrep|system status|status report)$/.test(t) ||
    /^what('s| is|s)? (down|broken|running)$/.test(t) ||
    /^(is )?(everything|anything) (down|broken)$/.test(t) ||
    /^are (you|we|the agents) (all )?(up|running|ok)$/.test(t)
  );
}

/** Probe an agent's HTTP health endpoint. Short timeout — a status reply must not hang. */
async function probe(url: string, timeoutMs = 4000): Promise<boolean | null> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return r.ok;
  } catch (e) {
    // A refused connection is a definite "down"; a timeout or DNS failure could be either, so it
    // stays unknown rather than being reported as an outage Clara cannot actually confirm.
    //
    // The cause has to be unwrapped explicitly: undici surfaces every transport error as a bare
    // `TypeError: fetch failed` and hides the real errno on `.cause`, so matching String(e) alone
    // could never return false — a genuinely dead agent was reported as merely "unreachable".
    // Caught by stopping a peer agent and reading the live report.
    const cause = (e as { cause?: unknown })?.cause;
    const text = `${String(e)} ${String((cause as { code?: string })?.code ?? "")} ${String(cause ?? "")}`;
    if (/ECONNREFUSED|ECONNRESET|refused/i.test(text)) return false;
    return null;
  }
}

async function countMissedFires(dataDir: string): Promise<number> {
  try {
    const raw = await fs.readFile(path.join(dataDir, "missed-fires.json"), "utf8");
    const rows = JSON.parse(raw) as Array<{ recordedAt?: string }>;
    const cutoff = Date.now() - 7 * 24 * 3_600_000;
    return rows.filter((r) => r.recordedAt && Date.parse(r.recordedAt) > cutoff).length;
  } catch {
    return 0; // no file = nothing was ever missed
  }
}

/**
 * Is the OS session usable?
 *
 * Deliberately more than "does the vault file exist" — a revoked refresh token leaves the file in
 * place, which is exactly how the 2026-08-01 outage stayed invisible. agent_whoami is the cheapest
 * call that actually exercises the token.
 */
async function probeOs(): Promise<Sitrep["os"]> {
  try {
    const { osClient, osEnabled } = await import("./osClient");
    if (!osEnabled()) return { signedIn: false, detail: "no OS session — visit /api/os/auth to sign in" };
    const raw = await osClient.callTool("agent_whoami", {});
    const parsed = unwrapOs(raw) as { email?: string; user_id?: string };
    if (!parsed?.user_id) return { signedIn: false, detail: "OS session present but agent_whoami returned nothing — token likely revoked" };
    return { signedIn: true, identity: parsed.email ?? parsed.user_id };
  } catch (e) {
    return { signedIn: false, detail: `OS unreachable: ${String(e).slice(0, 120)}` };
  }
}

function unwrapOs(content: unknown): unknown {
  if (Array.isArray(content)) {
    const first = content.find((c) => c && typeof c === "object" && "text" in (c as object));
    if (first && typeof (first as { text?: unknown }).text === "string") {
      try { return JSON.parse((first as { text: string }).text); } catch { return null; }
    }
  }
  return content;
}

export async function gatherSitrep(): Promise<Sitrep> {
  const cfg = await loadConfig();
  const osState = await probeOs();

  const [friday, claraPending, agentApprovals, lmModels, missedFires, spend, autonomy, interagent] = await Promise.all([
    fridayHealth().catch(() => ({ ok: false, base: "", error: "probe failed" })),
    listPending().catch(() => []),
    summarizeAgentApprovals().catch((): AgentApprovalsSummary => ({
      counts: { friday: 0 },
      fromCache: { friday: true },
      oldest: [],
    })),
    fetch(`${cfg.lmStudioBaseUrl}/models`, { signal: AbortSignal.timeout(4000) })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => (j?.data?.length ?? null) as number | null)
      .catch(() => null),
    countMissedFires(cfg.dataDir),
    import("./usage").then(async (m) => ({
      todayUsd: await m.spendToday(),
      capUsd: m.dayMaxCostUsd(),
      byEngine: await m.spendByEngineToday(),
    })).catch(() => ({ todayUsd: 0, capUsd: 0, byEngine: {} })),
    // Read-only, and null-tolerant: an agent that is down simply contributes no modes rather than
    // failing the whole status reply.
    import("./dials").then(async (m) => {
      const f = await m.readDials("friday");
      return [{ agent: "friday" as const, dials: (f ?? []).map((d) => ({ name: d.name, value: d.value })) }];
    }).catch(() => []),
    import("./dials").then(async (m) => {
      const f = await m.probeInteragentAuth("friday");
      return [{ agent: "friday" as const, auth: f }];
    }).catch(() => []),
  ]);

  return {
    agents: [
      // Clara answers her own status by existing: this code is running inside her server process.
      { name: "clara", up: true },
      { name: "friday", up: friday.ok ? true : false, detail: friday.ok ? undefined : friday.error },
    ],
    approvals: {
      clara: claraPending.length,
      friday: agentApprovals.counts.friday,

      stale: agentApprovals.fromCache,
      oldest: agentApprovals.oldest,
      claraOldest: claraPending.slice(0, 3).map((a) => ({ code: shortCode(a.id), title: a.title })),
    },
    brain: { lmStudioModels: lmModels },
    os: osState,
    spend,
    autonomy,
    interagent,
    missedFires,
    generatedAt: new Date().toISOString(),
  };
}

function agentGlyph(a: AgentLine): string {
  if (a.up === true) return "✅";
  if (a.up === false) return "🔴";
  return "❔";
}

/**
 * The reply to "status" / "what's down". Written to fit an SMS: lead with what is wrong, because
 * that is the only reason the question gets asked, and keep the all-clear to one line.
 */
export function formatSitrepSms(s: Sitrep): string {
  const down = s.agents.filter((a) => a.up !== true);
  const lines: string[] = [];

  if (down.length) {
    // "down" and "not answering" are different claims and are kept apart: the first is confirmed,
    // the second means the probe itself was inconclusive and the agent may well be fine.
    lines.push(down.map((a) => {
      const state = a.up === false ? "is down" : "isn't answering";
      return `${agentGlyph(a)} ${a.name.toUpperCase()} ${state}${a.detail ? ` — ${a.detail.slice(0, 60)}` : ""}`;
    }).join("\n"));
  } else {
    lines.push("✅ All agents up.");
  }

  // Right under the agent line, because "all three agents up" was the exact reassurance being
  // printed on 2026-08-01 while the OS link was dead and none of Clara's scheduled OS work had
  // been claimed for hours. Three green agents and a severed OS look identical without this.
  if (!s.os.signedIn) {
    lines.push(`🔴 orion link is DOWN${s.os.detail ? ` — ${s.os.detail.slice(0, 70)}` : ""}. Scheduled OS work is not running.`);
  }

  const totalApprovals = s.approvals.clara + s.approvals.friday;
  if (totalApprovals) {
    const parts: string[] = [];
    if (s.approvals.clara) parts.push(`me ${s.approvals.clara}`);
    if (s.approvals.friday) parts.push(`FRIDAY ${s.approvals.friday}${s.approvals.stale.friday ? "*" : ""}`);

    lines.push(`⏳ ${totalApprovals} waiting on you — ${parts.join(", ")}.`);
    const oldest = s.approvals.oldest[0];
    if (oldest) lines.push(`Oldest: ${oldest.title.slice(0, 60)} (${oldest.age}).`);
    // The asterisk is load-bearing — a cached count can be wrong in the direction that matters.
    if (s.approvals.stale.friday) lines.push("* cached — that agent wasn't reachable.");
  } else {
    lines.push("⏳ Nothing waiting on you.");
  }

  if (s.brain.lmStudioModels === 0 || s.brain.lmStudioModels === null) {
    lines.push("🧠 LM Studio has no models loaded — no local failover brain.");
  }
  // Only surface authority when it is ACTIVE. Shadow and off are the safe resting states and
  // listing them every time would bury the one line that matters — an agent currently allowed to
  // act without asking.
  const live = s.autonomy
    .flatMap((a) => a.dials.filter((d) => (d.name === "authority" && d.value === "active") || (d.name === "money_auto" && d.value === "on"))
      .map((d) => `${a.agent.toUpperCase()} ${d.name}=${d.value}`));
  if (live.length) lines.push(`⚡ Acting without asking: ${live.join(", ")}.`);

  const badAuth = s.interagent.filter((i) => i.auth === "unauthorized").map((i) => i.agent.toUpperCase());
  if (badAuth.length) lines.push(`🔑 Agent-to-agent auth failing with ${badAuth.join(", ")} — the shared secret doesn't match. Routing still works but decisions relayed there won't be attributed to me.`);

  // Reported only when there is something to react to. A quiet local-only day says nothing, and a
  // status reply that recites $0.00 every time trains you to stop reading it.
  if (s.spend.capUsd > 0 && s.spend.todayUsd >= s.spend.capUsd * 0.5) {
    const pct = Math.round((s.spend.todayUsd / s.spend.capUsd) * 100);
    lines.push(`💵 My model spend today: $${s.spend.todayUsd.toFixed(2)} of $${s.spend.capUsd} (${pct}%).`);
  }

  if (s.missedFires) lines.push(`⏰ ${s.missedFires} scheduled job(s) skipped in the last week while I was down.`);

  return lines.join("\n");
}

/**
 * The same facts as a context block for the conversational prompt, so a casual "how are things?"
 * is answered from live state instead of invention. Deliberately terse: it shares the SMS token
 * budget with memory-RAG, and an unreadable wall of status would crowd out the actual retrieval.
 */
export function sitrepContextBlock(s: Sitrep): string {
  const agents = s.agents.map((a) => `${a.name}=${a.up === true ? "up" : a.up === false ? "DOWN" : "unknown"}`).join(", ");
  const bits = [
    `agents: ${agents}`,
    `pending approvals: clara ${s.approvals.clara}, friday ${s.approvals.friday}`,
  ];
  if (s.brain.lmStudioModels !== null) bits.push(`lm studio models: ${s.brain.lmStudioModels}`);
  for (const a of s.autonomy) {
    if (a.dials.length) bits.push(`${a.agent} modes: ${a.dials.map((d) => `${d.name}=${d.value}`).join(", ")}`);
  }
  bits.push(`my model spend today: $${s.spend.todayUsd.toFixed(2)} of $${s.spend.capUsd}`);
  if (s.missedFires) bits.push(`missed scheduled jobs (7d): ${s.missedFires}`);
  return `LIVE SYSTEM STATE (as of now — use these numbers, never guess at them):\n${bits.join("\n")}`;
}
