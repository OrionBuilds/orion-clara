// Clara — meeting digestion: shared shapes.
//
// CLARA is the sole meeting digester across the three agents. A MeetingRecord is the normalised
// input regardless of where the transcript came from (Wispr Flow, a Gemini/Meet notes doc in Drive,
// or one of Clara's own transcribed phone calls); a MeetingDigest is what the model extracts from it.

export type MeetingSource = "wispr" | "meet" | "call";

export interface MeetingRecord {
  source: MeetingSource;
  /** Stable id within the source — Wispr meeting id, Drive file id, Twilio call sid. */
  sourceId: string;
  title: string;
  /** Display names as the source reports them. */
  attendees: string[];
  attendeeEmails?: string[];
  startedAt: string;   // ISO
  endedAt?: string;    // ISO
  transcript: string;
  /** The source's own summary/notes when it provides one (Wispr summary, Gemini notes body). A hint, never the answer. */
  summary?: string;
  shareLink?: string;
  calendarEventId?: string;
  /** Vault-relative path of a transcript Clara already saved (phone calls) — the note links it instead of copying it. */
  vaultTranscriptPath?: string;
}


export type ItemOwner = "owner" | "clara" | "friday";
export const ITEM_OWNERS: readonly ItemOwner[] = ["owner", "clara", "friday"] as const;

export interface DigestItem {
  owner: ItemOwner;
  item: string;
  why: string;
  client?: string;
  project?: string;
  due?: string;
  costsMoney?: boolean;
}

export interface MeetingDigest {
  summary: string;
  decisions: string[];
  items: DigestItem[];
  /** Set when the injection detector fired on the transcript — every owner was forced to `owner`. */
  injection?: { triggered: boolean; reasons: string[] };
}

export type IngestMode = "off" | "shadow" | "active";

export interface RosterProject { id: string; name: string; clientId?: string; clientName?: string; status?: string }
export interface RosterContact { name: string; email?: string; relation: string }
export interface Roster { projects: RosterProject[]; contacts: RosterContact[] }
