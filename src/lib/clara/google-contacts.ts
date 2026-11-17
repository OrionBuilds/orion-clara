// Clara ↔ Google Contacts (People API), two-way.
//
// The dangerous half of sync, for three concrete reasons — all mitigated here, none eliminated:
//
//  1. `updatePersonFields` CLEARS any field it lists but the body omits. Every update below
//     enumerates exactly the fields it is actually sending, and no others.
//  2. People models many emails/phones per person; Clara models one. Extras are preserved by
//     writing back only index 0 and leaving the rest of the array untouched.
//  3. Splitting a display name into given/family is genuinely lossy on multi-word surnames
//     ("Ana Maria de la Cruz"). We only rewrite the name when it actually changed, so an
//     untouched contact never gets its name mangled as a side effect of some other edit.
//
// Clara's own fields (relation/vip) live in `userDefined` and are declared localOnly, so
// Google can never clear them.

import { gfetch, type GAccount } from "./google-auth";
import {
  listContacts, upsertContact, type Contact, type Relation,
} from "./contacts";
import { runSync, type SyncAdapter, type SyncReport } from "./sync-engine";

const BASE = "https://people.googleapis.com/v1";
const PERSON_FIELDS = "names,emailAddresses,phoneNumbers,birthdays,events,biographies,userDefined,metadata";
const CLARA_ID_KEY = "clara.id";

export interface GPerson {
  resourceName: string;
  etag?: string;
  names?: { displayName?: string; givenName?: string; familyName?: string; metadata?: { primary?: boolean } }[];
  emailAddresses?: { value?: string }[];
  phoneNumbers?: { value?: string }[];
  birthdays?: { date?: { year?: number; month?: number; day?: number } }[];
  events?: { type?: string; date?: { year?: number; month?: number; day?: number } }[];
  biographies?: { value?: string; contentType?: string }[];
  userDefined?: { key?: string; value?: string }[];
}

export interface NContact {
  name: string;
  email?: string;
  phone?: string;
  birthday?: string;      // YYYY-MM-DD
  anniversary?: string;   // YYYY-MM-DD
  notes?: string;
  relation?: string;      // localOnly
  vip?: boolean;          // localOnly
}

// Google allows a year-less birthday; Clara's type is a full date. 1900 is the conventional
// sentinel and is stripped back out on read so it never surfaces as a real birth year.
const NO_YEAR = 1900;

function dateToYmd(d?: { year?: number; month?: number; day?: number }): string | undefined {
  if (!d?.month || !d?.day) return undefined;
  const y = d.year ?? NO_YEAR;
  return `${String(y).padStart(4, "0")}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;
}

function ymdToDate(ymd?: string): { year?: number; month: number; day: number } | undefined {
  if (!ymd) return undefined;
  const m = ymd.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return undefined;
  const year = Number(m[1]);
  return { ...(year === NO_YEAR ? {} : { year }), month: Number(m[2]), day: Number(m[3]) };
}

function normPhone(p?: string): string | undefined {
  if (!p) return undefined;
  const digits = p.replace(/[^\d+]/g, "");
  return digits || undefined;
}

function normEmail(e?: string): string | undefined {
  return e?.trim().toLowerCase() || undefined;
}

function splitName(full: string): { givenName: string; familyName?: string } {
  const parts = full.trim().split(/\s+/);
  if (parts.length === 1) return { givenName: parts[0] };
  return { givenName: parts[0], familyName: parts.slice(1).join(" ") };
}

// ── REST ─────────────────────────────────────────────────────────────────
async function gjson<T>(url: string, init?: RequestInit, account: GAccount = "work"): Promise<T> {
  const r = await gfetch(url, init ?? {}, account);
  if (!r.ok) throw new Error(`People API ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}`);
  return await r.json() as T;
}

export async function listPeople(account: GAccount = "work"): Promise<GPerson[]> {
  const out: GPerson[] = [];
  let pageToken: string | undefined;
  do {
    const url = `${BASE}/people/me/connections?pageSize=200&personFields=${PERSON_FIELDS}`
      + (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : "");
    const j = await gjson<{ connections?: GPerson[]; nextPageToken?: string }>(url, {}, account);
    out.push(...(j.connections ?? []));
    pageToken = j.nextPageToken;
  } while (pageToken);
  return out;
}

export async function createContact(body: Partial<GPerson>, account: GAccount = "work"): Promise<GPerson> {
  return gjson<GPerson>(`${BASE}/people:createContact?personFields=${PERSON_FIELDS}`, {
    method: "POST", body: JSON.stringify(body),
  }, account);
}

export async function updateContactPerson(
  resourceName: string, etag: string | undefined, body: Partial<GPerson>, updateFields: string[], account: GAccount = "work",
): Promise<GPerson> {
  const url = `${BASE}/${resourceName}:updateContact`
    + `?updatePersonFields=${encodeURIComponent(updateFields.join(","))}&personFields=${PERSON_FIELDS}`;
  return gjson<GPerson>(url, {
    method: "PATCH", body: JSON.stringify({ ...body, etag, resourceName }),
  }, account);
}

// ── adapter ──────────────────────────────────────────────────────────────
export function contactsAdapter(account: GAccount, remoteRaw: Map<string, GPerson>): SyncAdapter<Contact, GPerson, NContact> {
  return {
    kind: "contacts",
    account,
    localOnlyFields: ["relation", "vip"],

    listLocal: () => listContacts(),
    localId: (c) => c.id,
    normalizeLocal: (c): NContact => ({
      name: c.name,
      email: normEmail(c.email),
      phone: normPhone(c.phone),
      birthday: c.birthday,
      anniversary: c.anniversary,
      notes: c.notes,
      relation: c.relation,
      vip: c.vip,
    }),

    listRemote: async () => {
      const rows = await listPeople(account);
      remoteRaw.clear();
      for (const r of rows) remoteRaw.set(r.resourceName, r);
      return rows;
    },
    remoteId: (r) => r.resourceName,
    remoteEtag: (r) => r.etag,
    normalizeRemote: (r): NContact => {
      const ud = Object.fromEntries((r.userDefined ?? []).map((u) => [u.key ?? "", u.value ?? ""]));
      const anniv = (r.events ?? []).find((e) => e.type === "anniversary");
      return {
        name: r.names?.[0]?.displayName ?? "(no name)",
        email: normEmail(r.emailAddresses?.[0]?.value),
        phone: normPhone(r.phoneNumbers?.[0]?.value),
        birthday: dateToYmd(r.birthdays?.[0]?.date),
        anniversary: dateToYmd(anniv?.date),
        notes: r.biographies?.[0]?.value || undefined,
        // Clara-owned; read back so an unchanged round-trip doesn't look like a change.
        relation: ud["clara.relation"] || undefined,
        vip: ud["clara.vip"] === "true" ? true : ud["clara.vip"] === "false" ? false : undefined,
      };
    },
    embeddedLocalId: (r) => (r.userDefined ?? []).find((u) => u.key === CLARA_ID_KEY)?.value,

    createRemote: async (n, localId) => {
      const raw = await createContact(buildPersonBody(n, localId), account);
      remoteRaw.set(raw.resourceName, raw);
      return { remoteId: raw.resourceName, etag: raw.etag, raw };
    },

    updateRemote: async (remoteId, n, etag, localId) => {
      const prev = remoteRaw.get(remoteId);
      const { body, fields } = buildPersonUpdate(n, localId, prev);
      // Field-level diff found nothing to send. People rejects an empty updatePersonFields, and
      // there'd be nothing to write anyway — return the record we already have untouched.
      if (!fields.length && prev) return { etag: prev.etag, raw: prev };
      const raw = await updateContactPerson(remoteId, etag ?? prev?.etag, body, fields, account);
      remoteRaw.set(raw.resourceName, raw);
      return { etag: raw.etag, raw };
    },

    applyLocal: async (localId, n) => {
      const saved = await upsertContact({
        ...(localId ? { id: localId } : {}),
        name: n.name,
        email: n.email,
        phone: n.phone,
        birthday: n.birthday,
        anniversary: n.anniversary,
        notes: n.notes,
        ...(n.relation ? { relation: n.relation as Relation } : {}),
        ...(n.vip !== undefined ? { vip: n.vip } : {}),
      });
      return saved.id;
    },

    matchCandidate: (n, pool) => {
      if (n.email) {
        const byEmail = pool.filter((p) => p.n.email && p.n.email === n.email);
        if (byEmail.length === 1) return { id: byEmail[0].id, confidence: 1.0 };
      }
      if (n.phone) {
        const byPhone = pool.filter((p) => p.n.phone && p.n.phone === n.phone);
        if (byPhone.length === 1) return { id: byPhone[0].id, confidence: 0.9 };
      }
      const norm = (s: string) => s.toLowerCase().trim().replace(/\s+/g, " ");
      const byName = pool.filter((p) => norm(p.n.name) === norm(n.name));
      if (byName.length === 1) return { id: byName[0].id, confidence: 0.7 };
      return null;
    },
  };
}

function claraUserDefined(n: NContact, localId: string): { key: string; value: string }[] {
  const out = [{ key: CLARA_ID_KEY, value: localId }];
  if (n.relation) out.push({ key: "clara.relation", value: n.relation });
  if (n.vip !== undefined) out.push({ key: "clara.vip", value: String(n.vip) });
  return out;
}

function buildPersonBody(n: NContact, localId: string): Partial<GPerson> {
  const body: Partial<GPerson> = {
    names: [{ displayName: n.name, ...splitName(n.name) }],
    userDefined: claraUserDefined(n, localId),
  };
  if (n.email) body.emailAddresses = [{ value: n.email }];
  if (n.phone) body.phoneNumbers = [{ value: n.phone }];
  const bd = ymdToDate(n.birthday);
  if (bd) body.birthdays = [{ date: bd }];
  const an = ymdToDate(n.anniversary);
  if (an) body.events = [{ type: "anniversary", date: an }];
  if (n.notes) body.biographies = [{ value: n.notes, contentType: "TEXT_PLAIN" }];
  return body;
}

// Builds a MINIMAL update: only the fields that actually changed are listed in
// updatePersonFields, because People clears every listed field the body doesn't populate.
// Multi-valued fields keep the entries beyond index 0 that Clara doesn't model.
function buildPersonUpdate(
  n: NContact, localId: string, prev?: GPerson,
): { body: Partial<GPerson>; fields: string[] } {
  const body: Partial<GPerson> = {};
  const fields: string[] = [];

  const prevName = prev?.names?.[0]?.displayName;
  if (prevName !== n.name) {
    // Only touch the name when it genuinely changed — never re-split an untouched name.
    body.names = [{ ...(prev?.names?.[0] ?? {}), displayName: n.name, ...splitName(n.name) }];
    fields.push("names");
  }

  const prevEmail = normEmail(prev?.emailAddresses?.[0]?.value);
  if (prevEmail !== n.email) {
    const rest = (prev?.emailAddresses ?? []).slice(1);
    body.emailAddresses = n.email ? [{ value: n.email }, ...rest] : rest;
    fields.push("emailAddresses");
  }

  const prevPhone = normPhone(prev?.phoneNumbers?.[0]?.value);
  if (prevPhone !== n.phone) {
    const rest = (prev?.phoneNumbers ?? []).slice(1);
    body.phoneNumbers = n.phone ? [{ value: n.phone }, ...rest] : rest;
    fields.push("phoneNumbers");
  }

  const prevBd = dateToYmd(prev?.birthdays?.[0]?.date);
  if (prevBd !== n.birthday) {
    const bd = ymdToDate(n.birthday);
    body.birthdays = bd ? [{ date: bd }] : [];
    fields.push("birthdays");
  }

  const prevAnnivEvent = (prev?.events ?? []).find((e) => e.type === "anniversary");
  if (dateToYmd(prevAnnivEvent?.date) !== n.anniversary) {
    const others = (prev?.events ?? []).filter((e) => e.type !== "anniversary");
    const an = ymdToDate(n.anniversary);
    body.events = an ? [{ type: "anniversary", date: an }, ...others] : others;
    fields.push("events");
  }

  const prevNotes = prev?.biographies?.[0]?.value || undefined;
  if (prevNotes !== n.notes) {
    body.biographies = n.notes ? [{ value: n.notes, contentType: "TEXT_PLAIN" }] : [];
    fields.push("biographies");
  }

  // Clara's own metadata — keep any userDefined keys that aren't hers.
  const desired = claraUserDefined(n, localId);
  const foreign = (prev?.userDefined ?? []).filter((u) => !(u.key ?? "").startsWith("clara."));
  const prevClara = JSON.stringify((prev?.userDefined ?? []).filter((u) => (u.key ?? "").startsWith("clara.")));
  if (prevClara !== JSON.stringify(desired)) {
    body.userDefined = [...desired, ...foreign];
    fields.push("userDefined");
  }

  return { body, fields };
}

export async function syncContacts(account: GAccount = "work", opts: { dryRun?: boolean } = {}): Promise<SyncReport> {
  // Raw People records are cached per-run so updates can preserve the multi-valued entries and
  // foreign userDefined keys Clara's normalized shape doesn't carry.
  const remoteRaw = new Map<string, GPerson>();
  return runSync(contactsAdapter(account, remoteRaw), opts);
}
