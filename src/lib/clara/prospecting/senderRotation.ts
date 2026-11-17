// senderRotation.ts — which verified sender identity an outbound email goes out from (plan §38),
// plus the two bounce breakers that can take a domain or the whole send pipeline offline.
//
// Honest limitation, same spirit as contacts/rungs/dbprPhone.ts's documented gap: the plan's
// formula ("cap = min(current_daily_limit, start_daily_volume + day_index*(target-start)/
// ramp_duration_days)") is implemented exactly as `warmupCapForDay` below, fully testable — but the
// OS's `email_campaign_domains` edge function (Mailgun-backed warmup tracking) has no "list" action
// (only create/verify/delete/start_warmup/pause_warmup/resume_warmup/sync_stats/
// apply_recommendation — confirmed by reading supabase/functions/email-campaign-domains/index.ts),
// so there is no way to discover a domain's live warmup row (or its id, needed by pause_warmup) over
// MCP today. It's also a genuinely separate system from the one email-send actually sends through
// (Resend via `email_from_addresses`/`email_domains` — email_campaign_domains is Mailgun-backed).
// So: `listSenderIdentities` sources real, sendable identities from `email_from_addresses_list`
// (what `fromAddressId` actually needs to be) and treats each as fully warmed (no cap) absent
// richer data; `warmupCapForDay` stands ready for whichever future PR wires real per-domain ramp
// data to this shape. The two breakers below are entirely LOCAL state (this module's own pause
// file, same convention as outbound.ts's global breaker) — pausing a sender here stops Clara's own
// rotation from picking it, independent of Mailgun's warmup system, which nothing currently reads.

import { promises as fs } from "node:fs";
import path from "node:path";
import { loadConfig } from "../config";
import { osClient } from "../osClient";

// ── Pure: warm-up cap math ───────────────────────────────────────────────────────────────────

export interface SenderDomainState {
  id: string;
  domain: string;
  active: boolean;
  /** Absent/undefined = no warmup tracking for this sender — treated as fully ramped (no cap). */
  currentDailyLimit?: number;
  startDailyVolume?: number;
  targetDailyVolume?: number;
  rampDurationDays?: number;
  warmupStartedAt?: string;
  sentToday: number;
}

/** Pure. The plan's exact formula: `min(current_daily_limit, start + day_index*(target-start)/
 *  ramp_days)`, floored at start_daily_volume (a ramp never goes negative/below where it started)
 *  and never above current_daily_limit. Returns Infinity when no warmup fields are present at all
 *  (see module doc — the common case today). */
export function warmupCapForDay(d: SenderDomainState, now: Date = new Date()): number {
  if (d.currentDailyLimit === undefined) return Infinity;
  if (!d.warmupStartedAt || d.startDailyVolume === undefined || d.targetDailyVolume === undefined || !d.rampDurationDays) {
    return d.currentDailyLimit;
  }
  const dayIndex = Math.max(0, Math.floor((now.getTime() - Date.parse(d.warmupStartedAt)) / 86_400_000));
  const ramped = d.startDailyVolume + (dayIndex * (d.targetDailyVolume - d.startDailyVolume)) / d.rampDurationDays;
  return Math.min(d.currentDailyLimit, Math.max(d.startDailyVolume, Math.round(ramped)));
}

export interface PickSenderOpts {
  /** The contact's previously-used domain, when one exists — "contact sticky to one domain"
   *  (plan §38). Re-selected as long as it's still active and under its cap; otherwise falls
   *  through to least-used-today, same as a contact with no history. */
  stickyDomainId?: string;
  now?: Date;
}

/** Pure. Active, under-cap domains only; least-used-today wins (spreads load evenly across a warm
 *  pool); the sticky domain is preferred first when it still qualifies. Undefined means no eligible
 *  sender exists right now — the caller (sequenceRunner) treats that as a capacity block, not an
 *  error. */
export function pickSenderDomain(domains: readonly SenderDomainState[], opts: PickSenderOpts = {}): SenderDomainState | undefined {
  const now = opts.now ?? new Date();
  const eligible = (d: SenderDomainState) => d.active && d.sentToday < warmupCapForDay(d, now);

  if (opts.stickyDomainId) {
    const sticky = domains.find((d) => d.id === opts.stickyDomainId);
    if (sticky && eligible(sticky)) return sticky;
  }
  const pool = domains.filter(eligible);
  if (!pool.length) return undefined;
  return [...pool].sort((a, b) => a.sentToday - b.sentToday)[0];
}

// ── Pure: bounce breakers ────────────────────────────────────────────────────────────────────

export const DOMAIN_HARD_BOUNCE_THRESHOLD = 5;
export const DOMAIN_COMPLAINT_THRESHOLD = 1;
export const GLOBAL_BREAKER_WINDOW = 100;
export const GLOBAL_BREAKER_RATE = 0.03;

export interface DomainBounceStats {
  hardBouncesToday: number;
  complaintsToday: number;
}
export interface BreakerDecision {
  pause: boolean;
  reason?: string;
}

/** Pure: ≥5 hard bounces/day OR ≥1 complaint pauses the domain (plan §38 exactly). */
export function domainBreakerShouldPause(stats: DomainBounceStats): BreakerDecision {
  if (stats.complaintsToday >= DOMAIN_COMPLAINT_THRESHOLD) return { pause: true, reason: `${stats.complaintsToday} spam complaint(s) today` };
  if (stats.hardBouncesToday >= DOMAIN_HARD_BOUNCE_THRESHOLD) return { pause: true, reason: `${stats.hardBouncesToday} hard bounces today (>= ${DOMAIN_HARD_BOUNCE_THRESHOLD})` };
  return { pause: false };
}

/** Pure: global bounce+complaint rate over the last 100 sends exceeding 3% pauses the WHOLE
 *  pipeline, not just one domain — this is a signal something is systemically wrong (a bad list, a
 *  broken template), not a per-domain reputation issue. Under 100 total sends, there isn't a
 *  meaningful rate yet — never pauses on a small sample. */
export function globalBreakerShouldPause(sentLast100: number, badLast100: number): BreakerDecision {
  if (sentLast100 < GLOBAL_BREAKER_WINDOW) return { pause: false };
  const rate = badLast100 / sentLast100;
  if (rate > GLOBAL_BREAKER_RATE) return { pause: true, reason: `${(rate * 100).toFixed(1)}% bounce/complaint rate over the last ${sentLast100} sends (> ${GLOBAL_BREAKER_RATE * 100}%)` };
  return { pause: false };
}

// ── Local pause state (file-backed, mirrors outbound.ts's global breaker convention) ───────────

interface DomainPauseRecord { domain: string; at: string; reason: string }
interface GlobalPauseRecord { at: string; reason: string }

async function stateDir(): Promise<string> {
  const cfg = await loadConfig();
  await fs.mkdir(cfg.dataDir, { recursive: true });
  return cfg.dataDir;
}
async function domainPauseFile(): Promise<string> { return path.join(await stateDir(), "prospecting", "email-domain-pauses.json"); }
async function globalPauseFile(): Promise<string> { return path.join(await stateDir(), "prospecting", "email-global-pause.json"); }

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try { return JSON.parse(await fs.readFile(file, "utf8")) as T; } catch { return fallback; }
}
async function writeJson(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(value, null, 2), "utf8").catch(() => undefined);
}

export async function isDomainPaused(domain: string): Promise<boolean> {
  const rows = await readJson<DomainPauseRecord[]>(await domainPauseFile(), []);
  return rows.some((r) => r.domain === domain);
}
export async function pauseDomain(domain: string, reason: string): Promise<void> {
  const file = await domainPauseFile();
  const rows = await readJson<DomainPauseRecord[]>(file, []);
  if (rows.some((r) => r.domain === domain)) return;
  rows.push({ domain, at: new Date().toISOString(), reason });
  await writeJson(file, rows);
}
export async function resumeDomain(domain: string): Promise<void> {
  const file = await domainPauseFile();
  const rows = await readJson<DomainPauseRecord[]>(file, []);
  const next = rows.filter((r) => r.domain !== domain);
  if (next.length !== rows.length) await writeJson(file, next);
}
export async function pausedDomains(): Promise<DomainPauseRecord[]> {
  return readJson<DomainPauseRecord[]>(await domainPauseFile(), []);
}

export async function isGlobalEmailPaused(): Promise<boolean> {
  return (await readJson<GlobalPauseRecord | null>(await globalPauseFile(), null)) !== null;
}
export async function setGlobalEmailPause(reason: string): Promise<void> {
  await writeJson(await globalPauseFile(), { at: new Date().toISOString(), reason } satisfies GlobalPauseRecord);
}
export async function clearGlobalEmailPause(): Promise<void> {
  await writeJson(await globalPauseFile(), null);
}

// ── Live sender identity list (email_from_addresses_list — CLARA_OS_TOOLS, main osClient) ──────

function unwrapToolContent(content: unknown): unknown {
  if (Array.isArray(content)) {
    const first = content.find((c) => c && typeof c === "object" && "text" in (c as object));
    if (first && typeof (first as { text?: unknown }).text === "string") {
      try { return JSON.parse((first as { text: string }).text); } catch { return (first as { text: string }).text; }
    }
  }
  return content;
}

export interface SenderIdentity {
  fromAddressId: string;
  email: string;
  domain: string;
}

/** Every active verified sender Resend can actually send through. Excludes nothing per-domain-cap
 *  related (see module doc) — callers combine this with their own `sentToday` counts (from the
 *  local outreach ledger) and `pickSenderDomain` above to rotate. */
export async function listSenderIdentities(): Promise<SenderIdentity[]> {
  const raw = unwrapToolContent(await osClient.callTool("email_from_addresses_list", {}).catch(() => []));
  const rows = Array.isArray(raw) ? raw : [];
  return rows
    .filter((r): r is Record<string, unknown> => Boolean(r) && typeof r === "object")
    .filter((r) => r.active !== false && typeof r.email === "string")
    .map((r) => ({ fromAddressId: String(r.id ?? ""), email: String(r.email), domain: String(r.email).split("@")[1] ?? "" }))
    .filter((s) => s.fromAddressId && s.domain);
}
