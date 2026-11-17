// Clara — client/project context for a digest: FRIDAY's project list + Clara's work contacts.
//
// FRIDAY owns the client/project model; CLARA borrows it over HTTP (interagent header), caches it
// ten minutes, and treats a dead FRIDAY as "no projects known" rather than a failure — the digest
// is still worth filing without a project tag on it.

import { interagentAuthHeaders } from "@autom8ionlab/agent-core";
import { loadConfig } from "../config";
import { listContacts } from "../contacts";
import type { DigestItem, MeetingRecord, Roster, RosterContact, RosterProject } from "./types";

const TTL_MS = 10 * 60_000;
const cache = globalThis as unknown as { __claraMeetingRoster?: { at: number; data: Roster } };

interface FridayProject { id?: string; name?: string; clientId?: string; clientName?: string; client?: { name?: string } | string; status?: string }

async function fridayProjects(): Promise<RosterProject[]> {
  const cfg = await loadConfig();
  try {
    const r = await fetch(`${cfg.fridayBaseUrl.replace(/\/$/, "")}/api/friday/projects`, {
      headers: interagentAuthHeaders(),
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) return [];
    const j = await r.json().catch(() => null) as { projects?: FridayProject[] } | null;
    return (j?.projects ?? [])
      .filter((p) => p.id && p.name)
      .map((p) => ({
        id: String(p.id),
        name: String(p.name),
        clientId: p.clientId,
        clientName: p.clientName ?? (typeof p.client === "string" ? p.client : p.client?.name),
        status: p.status,
      }));
  } catch {
    return [];
  }
}

async function workContacts(): Promise<RosterContact[]> {
  try {
    return (await listContacts())
      .filter((c) => c.relation === "vip-work" || c.relation === "colleague")
      .map((c) => ({ name: c.name, email: c.email, relation: c.relation }));
  } catch {
    return [];
  }
}

export async function loadRoster(opts: { force?: boolean } = {}): Promise<Roster> {
  if (!opts.force && cache.__claraMeetingRoster && Date.now() - cache.__claraMeetingRoster.at < TTL_MS) {
    return cache.__claraMeetingRoster.data;
  }
  const [projects, contacts] = await Promise.all([fridayProjects(), workContacts()]);
  const data: Roster = { projects, contacts };
  cache.__claraMeetingRoster = { at: Date.now(), data };
  return data;
}

/** Prompt block listing what the model may name as client/project. Pure. */
export function rosterBlock(roster: Roster): string {
  const active = roster.projects.filter((p) => !p.status || !/archived|closed|done|cancel/i.test(p.status)).slice(0, 60);
  const lines = [
    "Known projects (use these exact names when a task belongs to one; omit otherwise):",
    active.length ? active.map((p) => `- ${p.name}${p.clientName ? ` (client: ${p.clientName})` : ""}`).join("\n") : "- (none known)",
    "Known work contacts:",
    roster.contacts.length ? roster.contacts.slice(0, 60).map((c) => `- ${c.name}${c.email ? ` <${c.email}>` : ""}`).join("\n") : "- (none known)",
  ];
  return lines.join("\n");
}

const norm = (s: string) => s.toLowerCase().trim();
const contains = (hay: string, needle: string) => needle.length >= 3 && norm(hay).includes(norm(needle));

/**
 * Case-insensitive containment against the roster, then an attendee-email fallback (a contact
 * whose address was on the call). Pure — no I/O. Returns whatever it can settle.
 */
export function resolveClient(
  item: Pick<DigestItem, "client" | "project">,
  rec: Pick<MeetingRecord, "title" | "attendees" | "attendeeEmails">,
  roster: Roster,
): { client?: string; project?: string } {
  let project = roster.projects.find((p) => item.project && (contains(p.name, item.project) || contains(item.project, p.name)));
  let client = project?.clientName;

  if (!client && item.client) {
    const byProject = roster.projects.find((p) => p.clientName && (contains(p.clientName, item.client!) || contains(item.client!, p.clientName)));
    const byContact = roster.contacts.find((c) => contains(c.name, item.client!) || contains(item.client!, c.name));
    client = byProject?.clientName ?? byContact?.name ?? item.client;
    project = project ?? byProject;
  }
  if (!client) {
    const emails = (rec.attendeeEmails ?? []).map(norm);
    const hit = roster.contacts.find((c) => c.email && emails.includes(norm(c.email)));
    if (hit) client = hit.name;
  }
  if (!client) {
    const hit = roster.projects.find((p) => p.clientName && contains(rec.title, p.clientName));
    if (hit) { client = hit.clientName; project = project ?? hit; }
  }
  return { client, project: project?.name ?? item.project };
}
