// Routing-clarify — when it's genuinely unclear whether a portal ticket belongs to FRIDAY (dev) or
// is ads/marketing (the owner's call), CLARA asks the client to say which, instead of guessing or silently parking
// it on the owner's book (2026-09-18 — the narrower, routing-only counterpart to FRIDAY's
// content-ambiguity clarify feature: CLARA never interprets WHAT a client wants, only WHICH bench
// should; asking the client to disambiguate that is new here).
//
// Store: dataDir/routing_clarifications.json, same tmp+rename pattern as delegations.ts. The
// transition/classification logic is pure and unit-tested; the file I/O is the thin part.
//
// No SMS nudge here (unlike FRIDAY's version): the portal ticket data model carries no
// client phone number, and CLARA has no client-SMS capability. A single 24h-silence owner
// escalation stands in for the nudge step.

import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { loadConfig } from "../config";
import type { PortalTicket, TicketTarget } from "./classify";

export interface RoutingClarify {
  id: string;
  ticketId: string;
  projectId: string;
  subject: string;
  description: string;
  clientEmail?: string;
  clientName?: string;
  // Preserved from the original ticket (2026-09-18 code-review fix) so the synthetic PortalTicket
  // rebuilt for dispatch on resolution doesn't silently drop them — dispatchAndAck/downstream bench
  // intake reads contact_id for client linking and priority/request_type/service_category for
  // triage classification; ticket_number is what shows up in owner-facing receipts/comments.
  contactId?: string;
  priority?: string;
  requestType?: string;
  serviceCategory?: string;
  ticketNumber?: string | number;
  qa: Array<{ question: string; answer: string }>;
  round: 1 | 2;
  question: string;
  status: "awaiting_reply" | "resolved";
  emailThreadId?: string;
  emailSeenMs?: number;
  askedAt: string;
  escalatedAt?: string;
  createdAt: string;
  updatedAt: string;
}

// ── Pure ─────────────────────────────────────────────────────────────────────────────────────

export const ROUTING_CLARIFY_QUESTION =
  "just to make sure this goes to the right person — is this mainly about your website/app, or something else?";

export function newRoutingClarify(t: PortalTicket, now = new Date().toISOString()): RoutingClarify {
  return {
    id: crypto.randomUUID(), ticketId: t.id, projectId: t.project_id,
    subject: t.subject ?? "", description: t.description ?? "",
    clientEmail: t.client_email ?? undefined, clientName: t.client_name ?? t.company_name ?? undefined,
    contactId: t.contact_id ?? undefined, priority: t.priority ?? undefined,
    requestType: t.request_type ?? undefined, serviceCategory: t.service_category ?? undefined,
    ticketNumber: t.ticket_number ?? undefined,
    qa: [], round: 1, question: ROUTING_CLARIFY_QUESTION, status: "awaiting_reply",
    askedAt: now, createdAt: now, updatedAt: now,
  };
}

export type RoutingTarget = TicketTarget;

// Purpose-built for the exact binary question CLARA asks (ROUTING_CLARIFY_QUESTION below) — NOT
// routing.ts's proposeRoute, whose FRIDAY_SIGNALS/SEO_SIGNALS are deliberately narrow technical
// jargon ("deploy", "repo", "PR") a non-technical client answering "it's my website" would never
// say. Combining the client's answer with the ORIGINAL (already dual-matching) ticket text and
// re-running proposeRoute was tried and rejected: the original text's own noise keeps it ambiguous
// forever, since a plain client answer rarely adds fresh jargon. Classify the answer alone instead.
const WEBSITE_ANSWER = /\b(website|web ?site|app|application|site|dev(elopment)?|software|platform|portal|deploy|bug|broken|error)\b/i;
// SEO is FRIDAY's (2026-10-09), so it's a website-side answer, not an ads one.
const SEO_ANSWER = /\b(seo|search rankings?|google business profile|gbp|backlinks?)\b/i;
const ADS_ANSWER = /\b(ads?|ad campaign|campaign|marketing|facebook|instagram|google ads|social( media)?)\b/i;

/** Classify the client's answer to "website/app or ad campaigns?" — never guesses when the answer
 *  itself doesn't clearly say one or the other (mentions both, or neither). Classifies ONLY the
 *  LATEST round's answer (2026-09-18 code-review fix): joining every round's answer meant a
 *  genuinely ambiguous round-1 reply ("fix the deploy and raise the ad budget") permanently poisoned
 *  round 2 even after the client gave a clean, unambiguous follow-up answer. */
export function classifyRoutingAnswer(qa: Array<{ answer: string }>): RoutingTarget | "ambiguous" {
  const text = qa[qa.length - 1]?.answer ?? "";
  const website = WEBSITE_ANSWER.test(text) || SEO_ANSWER.test(text);
  const ads = ADS_ANSWER.test(text);
  if (website && !ads) return "friday";
  // Ads/marketing is not offered — that's the owner's conversation.
  if (ads && !website) return "owner";
  return "ambiguous";
}

export type RoutingClarifyOutcome = "resolved" | "ask_again" | "force_owner";

/** Bounded to 2 rounds — round 1 still ambiguous → ask once more; round 2 still ambiguous →
 *  default to the owner (never guess friday-vs-owner, and never a third ask). */
export function routingClarifyOutcome(round: 1 | 2, classification: RoutingTarget | "ambiguous"): RoutingClarifyOutcome {
  if (classification !== "ambiguous") return "resolved";
  return round >= 2 ? "force_owner" : "ask_again";
}

/** Single-tier silence handling (no SMS nudge available — see file header): 24h with no reply on
 *  either channel → escalate to the owner once. */
export function routingClarifySilenceAction(askedAtMs: number, nowMs: number, escalatedAt: number | null): "none" | "escalate" {
  if (nowMs - askedAtMs >= 24 * 3600_000 && !escalatedAt) return "escalate";
  return "none";
}

// ── Store ────────────────────────────────────────────────────────────────────────────────────

async function file(): Promise<string> {
  const cfg = await loadConfig();
  await fs.mkdir(cfg.dataDir, { recursive: true });
  return path.join(cfg.dataDir, "routing_clarifications.json");
}

export async function readAll(): Promise<RoutingClarify[]> {
  try {
    const rows = JSON.parse(await fs.readFile(await file(), "utf8")) as RoutingClarify[];
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

async function writeAll(rows: RoutingClarify[]): Promise<void> {
  const p = await file();
  const tmp = `${p}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(rows, null, 2), "utf8");
  await fs.rename(tmp, p);
}

export async function upsert(row: RoutingClarify): Promise<void> {
  const rows = await readAll();
  const i = rows.findIndex((r) => r.id === row.id);
  if (i >= 0) rows[i] = row; else rows.push(row);
  await writeAll(rows);
}

export async function awaitingReply(): Promise<RoutingClarify[]> {
  return (await readAll()).filter((r) => r.status === "awaiting_reply");
}
