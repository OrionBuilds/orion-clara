// Clara ↔ Outlook Contacts (Microsoft Graph), two-way.
//
// Replaces google-contacts.ts. The three google-contacts risks this file still has to manage,
// and how Graph changes each:
//
//  1. PEOPLE API'S `updatePersonFields` CLEARS any field it lists but the body omits — which is
//     why the old `buildPersonUpdate` carried a companion "fields" list and enumerated exactly
//     what it was sending. Microsoft Graph's contact PATCH is a genuine partial update: per
//     Graph's own "Update contact" reference, properties not included in the request body keep
//     their previous values. So `buildContactUpdate` below needs no companion field list at
//     all — it just omits anything unchanged, full stop. (Collection-valued properties —
//     emailAddresses — are still replaced wholesale when included, same as Google, so the
//     "preserve the rest of the array" trick below is still needed for those.)
//
//  2. People models many emails/phones per person; Clara models one; Graph splits phone by TYPE
//     (`businessPhones: string[]`, `homePhones: string[]`, `mobilePhone: string`) rather than
//     Google's single flat `phoneNumbers` array. `mobilePhone` is the slot Clara reads/writes —
//     the Graph analogue of "index 0". Because Graph's PATCH is truly partial (see #1),
//     `businessPhones`/`homePhones` are simply never mentioned in any update body, which is
//     sufficient to leave them untouched — no explicit re-send needed the way Google's
//     `phoneNumbers.slice(1)` required.
//
//  3. Splitting a display name into given/family is genuinely lossy on multi-word surnames. We
//     still only rewrite the name when it actually changed.
//
// Clara's own fields (relation/vip) have no `userDefined`-style home in Graph's contact resource,
// and Graph contacts have no "anniversary" property at all (unlike People's `events` array).
// Rather than reach for `singleValueExtendedProperties` (GUID-keyed extended properties — real
// extra complexity, a different API shape entirely), this file reuses the exact marker-in-notes
// technique ms-tasks.ts/google-tasks.ts already use: a `⟦clara:...⟧` tag appended to
// `personalNotes` (Graph's biography-equivalent field — confirmed on the contact resource
// reference), carrying id/relation/vip AND anniversary (since Graph has nowhere else to put it),
// stripped on read so it never shows up as noise in the owner's/Clara's view of the note. Those four
// fields are declared localOnly (relation/vip) or sourced only from the marker (anniversary),
// so a human editing `personalNotes` in Outlook can add real prose without disturbing them, and
// Graph can never silently clear them.
//
// Optimistic concurrency: Graph contacts expose `changeKey` (and, opportunistically, the
// `@odata.etag` envelope annotation other Outlook resources carry) as the etag-equivalent. Unlike
// People API, Graph's contact PATCH does not require — or even accept — an etag in the request
// body, and this adapter does not send an `If-Match` header, so the `etag` parameter threaded
// through `updateRemote` by the generic SyncAdapter contract is accepted but unused here; it is
// still captured via `remoteEtag` purely so the link store's bookkeeping isn't left blank.

import { mfetch, type MAccount } from "./ms-auth";
import {
  listContacts, upsertContact, type Contact, type Relation,
} from "./contacts";
import { runSync, type SyncAdapter, type SyncReport } from "./sync-engine";

const BASE = "https://graph.microsoft.com/v1.0/me/contacts";
const SELECT_FIELDS = "id,changeKey,displayName,givenName,surname,emailAddresses,businessPhones,homePhones,mobilePhone,birthday,personalNotes";

export interface GContact {
  id: string;
  changeKey?: string;
  "@odata.etag"?: string;
  displayName?: string;
  givenName?: string;
  surname?: string;
  emailAddresses?: { address?: string; name?: string }[];
  businessPhones?: string[];
  homePhones?: string[];
  mobilePhone?: string | null;
  // Full ISO 8601 DateTimeOffset, e.g. "1990-05-14T00:00:00Z" — Graph has no year-less-birthday
  // concept (see dateToYmd/ymdToDate below).
  birthday?: string | null;
  personalNotes?: string | null;
}

export interface NContact {
  name: string;
  email?: string;
  phone?: string;
  birthday?: string;      // YYYY-MM-DD
  anniversary?: string;   // YYYY-MM-DD — sourced from the clara: marker, see header comment
  notes?: string;
  relation?: string;      // localOnly
  vip?: boolean;          // localOnly
}

// People API allows an optional `date.year`; Graph's `birthday` is always a full DateTimeOffset
// string, so there's no "omit the year" option on write. We keep the SAME 1900 sentinel
// google-contacts.ts used so NContact.birthday's external contract (what contacts.ts sees) is
// unchanged — a year-less birthday still round-trips as year 1900 — but unlike the Google
// version there's no conditional insertion/omission to do: the sentinel is just a literal year
// that gets reinterpreted as "no real year" by whatever reads NContact.birthday downstream.
function dateToYmd(iso?: string | null): string | undefined {
  const m = iso?.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : undefined;
}

function ymdToDate(ymd?: string): string | undefined {
  const m = ymd?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[1]}-${m[2]}-${m[3]}T00:00:00Z` : undefined;
}

function normPhone(p?: string | null): string | undefined {
  if (!p) return undefined;
  const digits = p.replace(/[^\d+]/g, "");
  return digits || undefined;
}

function normEmail(e?: string | null): string | undefined {
  return e?.trim().toLowerCase() || undefined;
}

function splitName(full: string): { givenName: string; surname?: string } {
  const parts = full.trim().split(/\s+/);
  if (parts.length === 1) return { givenName: parts[0] };
  return { givenName: parts[0], surname: parts.slice(1).join(" ") };
}

// ── Clara's marker (relation/vip/anniversary + the id that rebuilds links) ─────────────────────
// Verbatim technique from google-tasks.ts/ms-tasks.ts, just living in `personalNotes` instead of
// a task body.
const MARKER_RX = /\n?⟦clara:[^⟧]*⟧\s*$/;

function buildMarker(n: NContact, localId: string): string {
  const bits = [`id=${localId}`];
  if (n.relation) bits.push(`relation=${n.relation}`);
  if (n.vip !== undefined) bits.push(`vip=${n.vip}`);
  if (n.anniversary) bits.push(`anniv=${n.anniversary}`);
  return `⟦clara:${bits.join("|")}⟧`;
}

function readMarker(notes?: string | null): Record<string, string> {
  const m = notes?.match(/⟦clara:([^⟧]*)⟧/);
  if (!m) return {};
  return Object.fromEntries(m[1].split("|").map((p) => {
    const i = p.indexOf("=");
    return i < 0 ? [p, "true"] : [p.slice(0, i), p.slice(i + 1)];
  }));
}

function stripMarker(notes?: string | null): string | undefined {
  const s = (notes ?? "").replace(MARKER_RX, "").trim();
  return s || undefined;
}

function composeNotes(n: NContact, localId: string): string {
  const body = n.notes ? `${n.notes}\n\n` : "";
  return `${body}${buildMarker(n, localId)}`;
}

function remoteEtagOf(r?: GContact): string | undefined {
  return r?.["@odata.etag"] ?? r?.changeKey ?? undefined;
}

// ── REST ─────────────────────────────────────────────────────────────────
async function mjson<T>(url: string, init?: RequestInit, account: MAccount = "work"): Promise<T> {
  const r = await mfetch(url, init ?? {}, account);
  if (!r.ok) throw new Error(`Outlook Contacts ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}`);
  return await r.json() as T;
}

interface GContactsPage { value?: GContact[]; "@odata.nextLink"?: string }

export async function listPeople(account: MAccount = "work"): Promise<GContact[]> {
  const out: GContact[] = [];
  let url: string | undefined = `${BASE}?$top=200&$select=${SELECT_FIELDS}`;
  while (url) {
    // Explicitly typed — see the matching comment in ms-tasks.ts's pagination loop for why a
    // bare inferred-from-generic `const j = await mjson<...>(url)` doesn't type-check here.
    const j: GContactsPage = await mjson<GContactsPage>(url, {}, account);
    out.push(...(j.value ?? []));
    url = j["@odata.nextLink"];
  }
  return out;
}

export async function createContact(body: Partial<GContact>, account: MAccount = "work"): Promise<GContact> {
  return mjson<GContact>(BASE, { method: "POST", body: JSON.stringify(body) }, account);
}

export async function updateContactPerson(id: string, body: Partial<GContact>, account: MAccount = "work"): Promise<GContact> {
  // No `updatePersonFields`/etag parameter here — see header comment #1 and the concurrency note.
  return mjson<GContact>(`${BASE}/${encodeURIComponent(id)}`, {
    method: "PATCH", body: JSON.stringify(body),
  }, account);
}

// ── adapter ──────────────────────────────────────────────────────────────
export function contactsAdapter(account: MAccount, remoteRaw: Map<string, GContact>): SyncAdapter<Contact, GContact, NContact> {
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
      for (const r of rows) remoteRaw.set(r.id, r);
      return rows;
    },
    remoteId: (r) => r.id,
    remoteEtag: (r) => remoteEtagOf(r),
    normalizeRemote: (r): NContact => {
      const mk = readMarker(r.personalNotes);
      return {
        name: r.displayName ?? "(no name)",
        email: normEmail(r.emailAddresses?.[0]?.address),
        phone: normPhone(r.mobilePhone),
        birthday: dateToYmd(r.birthday),
        // No native Graph field — carried entirely in the marker, see header comment.
        anniversary: mk.anniv,
        notes: stripMarker(r.personalNotes),
        relation: mk.relation,
        vip: mk.vip === "true" ? true : mk.vip === "false" ? false : undefined,
      };
    },
    embeddedLocalId: (r) => readMarker(r.personalNotes).id,

    createRemote: async (n, localId) => {
      const raw = await createContact(buildContactBody(n, localId), account);
      remoteRaw.set(raw.id, raw);
      return { remoteId: raw.id, etag: remoteEtagOf(raw), raw };
    },

    updateRemote: async (remoteId, n, _etag, localId) => {
      const prev = remoteRaw.get(remoteId);
      const body = buildContactUpdate(n, localId, prev);
      // Nothing actually changed — don't send an empty PATCH, return what we already have.
      if (!Object.keys(body).length && prev) return { etag: remoteEtagOf(prev), raw: prev };
      const raw = await updateContactPerson(remoteId, body, account);
      remoteRaw.set(raw.id, raw);
      return { etag: remoteEtagOf(raw), raw };
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

    // Pure matching logic — copied verbatim from google-contacts.ts, no Graph-specific concern.
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

function buildContactBody(n: NContact, localId: string): Partial<GContact> {
  const body: Partial<GContact> = {
    displayName: n.name,
    ...splitName(n.name),
    personalNotes: composeNotes(n, localId),
  };
  if (n.email) body.emailAddresses = [{ address: n.email }];
  if (n.phone) body.mobilePhone = n.phone;
  const bd = ymdToDate(n.birthday);
  if (bd) body.birthday = bd;
  return body;
}

// Builds a MINIMAL update: only properties that actually changed are included. Unlike
// google-contacts.ts's `buildPersonUpdate`, there's no companion "fields" list to return — Graph's
// PATCH is a true partial update (see header comment #1), so simply omitting a property is
// enough to leave it alone. Collection-valued `emailAddresses` is the one place that still needs
// "preserve everything past index 0" treatment, because Graph (like People) replaces the whole
// collection when it's included at all.
function buildContactUpdate(n: NContact, localId: string, prev?: GContact): Partial<GContact> {
  const body: Partial<GContact> = {};

  const prevName = prev?.displayName;
  if (prevName !== n.name) {
    // Only touch the name when it genuinely changed — never re-split an untouched name.
    body.displayName = n.name;
    Object.assign(body, splitName(n.name));
  }

  const prevEmail = normEmail(prev?.emailAddresses?.[0]?.address);
  if (prevEmail !== n.email) {
    const rest = (prev?.emailAddresses ?? []).slice(1);
    body.emailAddresses = n.email ? [{ address: n.email }, ...rest] : rest;
  }

  const prevPhone = normPhone(prev?.mobilePhone);
  if (prevPhone !== n.phone) {
    // businessPhones/homePhones are never mentioned here, so they're left exactly as-is — no
    // explicit re-send needed (see header comment #2).
    body.mobilePhone = n.phone || null;
  }

  const prevBd = dateToYmd(prev?.birthday);
  if (prevBd !== n.birthday) {
    body.birthday = ymdToDate(n.birthday) ?? null;
  }

  // personalNotes carries both the human note AND the clara: marker (relation/vip/anniversary),
  // so it's rebuilt and compared as one composite value rather than field-by-field.
  const desiredNotes = composeNotes(n, localId);
  if ((prev?.personalNotes ?? "") !== desiredNotes) {
    body.personalNotes = desiredNotes;
  }

  return body;
}

export async function syncContacts(account: MAccount = "work", opts: { dryRun?: boolean } = {}): Promise<SyncReport> {
  // Raw Graph contact records are cached per-run so updates can preserve the multi-valued email
  // entries beyond index 0 that Clara's normalized shape doesn't carry.
  const remoteRaw = new Map<string, GContact>();
  return runSync(contactsAdapter(account, remoteRaw), opts);
}
