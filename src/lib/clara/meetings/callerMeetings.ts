// Clara — work-line meeting recall.
//
// Someone calls the owner's work phone and wants to pick up where a meeting left off. If the caller is
// in that meeting's `attendees:` list, we hand the call brain a compact block pulled from the vault
// note — summary + decisions + the caller's own tasks only — so Clara can answer from it. If the
// caller isn't a known attendee of anything recent, the block is empty and the brain's attendee-
// only rule tells her to decline specifics and take a message.
//
// What we deliberately don't surface here, even to real attendees:
//   - the raw transcript (verbatim speech is the biggest leak risk and the model doesn't need it
//     to answer "what did we decide" or "what did I agree to");
//   - action items owned by someone else (keeps "what did the owner say they'd do" from being readable
//     to anyone else who was in the room — if a caller wants that status, Clara passes to the owner);
//   - meetings older than `days` (14 by default — a stale window keeps her from reading from
//     months-old notes to a caller whose relationship with the subject matter has changed).
//
// Name matching is intentionally conservative: a case-insensitive full name OR a last-name match
// when it's unambiguous within the meeting's attendee list. A bare first name alone is not enough
// (two attendees sharing a first name would both match).

import { promises as fs } from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { loadConfig } from "../config";

const DEFAULT_DAYS = 14;
const DEFAULT_LIMIT = 3;

export interface MeetingFrontmatter {
  title?: string;
  // js-yaml coerces ISO-8601 timestamps to Date (YAML 1.1 timestamp type); we normalise before use.
  start?: string | Date;
  end?: string | Date;
  attendees?: string[];
  shareLink?: string;
  source?: string;
}

function startAsIso(v: string | Date | undefined): string | null {
  if (!v) return null;
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v.toISOString() : null;
  if (typeof v === "string" && v.trim()) return v;
  return null;
}

export interface MeetingDigest {
  title: string;
  startISO: string;
  summary: string;
  decisions: string[];
  callerTasks: string[];
}

export function tokens(name: string): string[] {
  // We keep single-char tokens so an initial ("E. Rivera") still contributes a first-token to the
  // ct.length>=2 check that unlocks the unambiguous last-name match.
  return name
    .toLowerCase()
    .replace(/[^a-z\s'-]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Does `attendees` include `callerName`? Match on full-name equality OR last-name match that is
 * unambiguous within the attendee list. A single first-name token is not enough — two attendees
 * sharing a first name in one meeting is a real case.
 */
export function attendeeMatches(attendees: string[], callerName: string | undefined | null): boolean {
  if (!callerName) return false;
  const ct = tokens(callerName);
  if (ct.length === 0) return false;
  const normalized = attendees.map((a) => tokens(a));
  // 1) Full-name equality (case-insensitive). "Taylor Client" matches "taylor client".
  const callerFull = ct.join(" ");
  if (normalized.some((att) => att.join(" ") === callerFull)) return true;
  // 2) Last-name only match, but only if that last name appears in exactly one attendee record.
  if (ct.length >= 2) {
    const last = ct[ct.length - 1];
    const hits = normalized.filter((att) => att[att.length - 1] === last).length;
    if (hits === 1) return true;
  }
  return false;
}

/**
 * Split a meeting note's markdown body into sections keyed by H2 heading. Section values are the
 * trimmed body text between a heading and the next heading (or end of file).
 */
export function splitSections(body: string): Record<string, string> {
  const lines = body.split(/\r?\n/);
  const out: Record<string, string> = {};
  let current: string | null = null;
  const buf: string[] = [];
  const flush = (): void => {
    if (current != null) out[current.toLowerCase()] = buf.join("\n").trim();
    buf.length = 0;
  };
  for (const line of lines) {
    const m = line.match(/^##\s+(.+?)\s*$/);
    if (m) {
      flush();
      current = m[1];
      continue;
    }
    if (current != null) buf.push(line);
  }
  flush();
  return out;
}

/** Parse "- item" or "1. item" / "1) item" bulleted lines. One item per line; others are dropped. */
export function parseBullets(text: string): string[] {
  if (!text) return [];
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const m = raw.match(/^\s*(?:[-*]|\d+[.)])\s+(.*\S)\s*$/);
    if (m) out.push(m[1]);
  }
  return out;
}

/**
 * From a meeting's "Tasks" section (bulleted lines like `**[Jordan]** Send the developer…`), return
 * only the ones owned by the caller — matched the same way `attendeeMatches` matches the frontmatter
 * attendee list. "why:" sub-bullets and task-id lines are stripped.
 */
export function callerTasksFromSection(section: string, callerName: string | undefined | null): string[] {
  if (!callerName) return [];
  const bullets = parseBullets(section);
  const out: string[] = [];
  for (const b of bullets) {
    const m = b.match(/^\*\*\[([^\]]+)\]\*\*\s*(.+)$/);
    if (!m) continue;
    const owner = m[1].trim();
    const body = m[2].replace(/_\(project:[^)]*\)_/g, "").trim();
    if (attendeeMatches([owner], callerName)) out.push(body);
  }
  return out;
}

/**
 * Parse one meeting markdown file into a MeetingDigest, or null if the file doesn't parse or the
 * caller wasn't in `attendees`. `raw` is the file content; the frontmatter/body split follows
 * meetings/file.ts's writer (opening `---` / closing `---` lines).
 */
export function digestForCaller(raw: string, callerName: string | undefined | null): MeetingDigest | null {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) return null;
  let fm: MeetingFrontmatter;
  try {
    fm = yaml.load(m[1]) as MeetingFrontmatter;
  } catch {
    return null;
  }
  const startISO = startAsIso(fm?.start);
  if (!fm?.attendees?.length || !fm.title || !startISO) return null;
  if (!attendeeMatches(fm.attendees, callerName)) return null;
  const sections = splitSections(m[2]);
  const summary = (sections["summary"] ?? "").trim();
  const decisions = parseBullets(sections["decisions"] ?? "");
  const callerTasks = callerTasksFromSection(sections["tasks"] ?? "", callerName);
  // A meeting with nothing to say isn't worth sending to the brain.
  if (!summary && decisions.length === 0 && callerTasks.length === 0) return null;
  return { title: fm.title, startISO, summary, decisions, callerTasks };
}

interface BuildOpts {
  days?: number;
  limit?: number;
  /** Clock injected for tests. Defaults to Date.now. */
  now?: Date;
  /** Directory override — only used by tests. In production it's resolved from `vaultRoot`. */
  dir?: string;
}

/**
 * Resolve, read and format the "MEETINGS_YOU_WERE_IN" block for a caller. Returns "" (not null)
 * when the caller is known but no recent meeting matches, so the call-session field stays
 * distinguishable from "not resolved yet". Returns null only when the vault folder doesn't exist.
 */
export async function buildCallerMeetingContext(
  callerName: string | undefined | null,
  opts: BuildOpts = {},
): Promise<string | null> {
  if (!callerName) return "";
  const now = opts.now ?? new Date();
  const days = opts.days ?? DEFAULT_DAYS;
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const dir = opts.dir ?? path.join((await loadConfig()).vaultRoot, "meetings");
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return null;
  }
  const cutoff = now.getTime() - days * 24 * 60 * 60 * 1000;
  const digests: MeetingDigest[] = [];
  for (const name of entries) {
    if (!name.endsWith(".md")) continue;
    const abs = path.join(dir, name);
    let raw: string;
    try {
      const stat = await fs.stat(abs);
      if (!stat.isFile()) continue;
      raw = await fs.readFile(abs, "utf8");
    } catch {
      continue;
    }
    const d = digestForCaller(raw, callerName);
    if (!d) continue;
    const t = Date.parse(d.startISO);
    if (!Number.isFinite(t) || t < cutoff) continue;
    digests.push(d);
  }
  digests.sort((a, b) => Date.parse(b.startISO) - Date.parse(a.startISO));
  const kept = digests.slice(0, limit);
  if (kept.length === 0) return "";
  return formatBlock(kept);
}

export function formatBlock(digests: MeetingDigest[]): string {
  const lines: string[] = ["MEETINGS_YOU_WERE_IN (most recent first — only these may be discussed with this caller):"];
  for (const d of digests) {
    const date = d.startISO.slice(0, 10);
    lines.push(`- "${d.title}" (${date})`);
    if (d.summary) lines.push(`  Summary: ${collapse(d.summary)}`);
    if (d.decisions.length) {
      lines.push(`  Decisions:`);
      for (const x of d.decisions) lines.push(`    - ${collapse(x)}`);
    }
    if (d.callerTasks.length) {
      lines.push(`  Their open items:`);
      for (const x of d.callerTasks) lines.push(`    - ${collapse(x)}`);
    }
  }
  return lines.join("\n");
}

function collapse(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}
