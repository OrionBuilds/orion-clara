// Clara — contacts CRUD backed by vault/contacts/*.md with YAML-like frontmatter.
//
// One markdown file per contact keeps everything portable + Obsidian-friendly, and the markdown
// is now genuinely READ as the source of truth — a contact edited in Obsidian is picked up rather
// than silently overwritten. _contacts.json is a derived cache rebuilt on every load.

import { promises as fs } from "node:fs";
import path from "node:path";
import { loadConfig } from "./config";
import { writeVipList, readVipList } from "./triage";
import { parseMd, parseBool } from "./frontmatter";

export type Relation = "friend" | "vendor" | "vip-work" | "colleague" | "other";

export interface Contact {
  id: string;                     // slug of name
  name: string;
  relation: Relation;
  email?: string;
  phone?: string;                 // E.164
  birthday?: string;              // YYYY-MM-DD
  anniversary?: string;           // YYYY-MM-DD
  vip: boolean;                   // gets escalated in mail triage
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

function slug(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "contact";
}

async function dir(): Promise<string> {
  const cfg = await loadConfig();
  const d = path.join(cfg.vaultRoot, "contacts");
  await fs.mkdir(d, { recursive: true });
  return d;
}
async function indexFile(): Promise<string> {
  return path.join(await dir(), "_contacts.json");
}

const RELATIONS: Relation[] = ["friend", "vendor", "vip-work", "colleague", "other"];

function fromMd(raw: string, fallbackId: string): Contact | null {
  const { fm, heading, body } = parseMd(raw);
  const name = fm.name || heading;
  if (!name) return null;
  return {
    id: fm.id || fallbackId,
    name,
    relation: RELATIONS.includes(fm.relation as Relation) ? (fm.relation as Relation) : "other",
    email: fm.email || undefined,
    phone: fm.phone || undefined,
    birthday: fm.birthday || undefined,
    anniversary: fm.anniversary || undefined,
    vip: parseBool(fm.vip),
    notes: body || undefined,
    createdAt: fm.created || new Date().toISOString(),
    updatedAt: fm.updated || fm.created || new Date().toISOString(),
  };
}

// Markdown is authoritative; the JSON index is rebuilt from it on every read.
async function loadIndex(): Promise<Contact[]> {
  const d = await dir();
  let files: string[] = [];
  try { files = await fs.readdir(d); } catch { return []; }
  const rows: Contact[] = [];
  for (const f of files) {
    if (!f.endsWith(".md")) continue;
    const raw = await fs.readFile(path.join(d, f), "utf8").catch(() => null);
    if (raw == null) continue;
    const c = fromMd(raw, f.replace(/\.md$/, ""));
    if (c) rows.push(c);
  }
  rows.sort((a, b) => a.name.localeCompare(b.name));
  await fs.writeFile(await indexFile(), JSON.stringify(rows, null, 2), "utf8").catch(() => {});
  return rows;
}

async function saveIndex(rows: Contact[]): Promise<void> {
  await fs.writeFile(await indexFile(), JSON.stringify(rows, null, 2), "utf8").catch(() => {});
}

// A contact hand-created in Obsidian may carry its id in frontmatter under a different filename.
async function fileForId(id: string): Promise<string> {
  const d = await dir();
  const direct = `${id}.md`;
  if (await fs.stat(path.join(d, direct)).catch(() => null)) return direct;
  const files = await fs.readdir(d).catch(() => [] as string[]);
  for (const f of files) {
    if (!f.endsWith(".md")) continue;
    const raw = await fs.readFile(path.join(d, f), "utf8").catch(() => "");
    if (fromMd(raw, f.replace(/\.md$/, ""))?.id === id) return f;
  }
  return direct;
}

function toMd(c: Contact): string {
  const fm = [
    "---",
    `id: ${c.id}`,
    `name: ${c.name}`,
    `relation: ${c.relation}`,
    c.email ? `email: ${c.email}` : null,
    c.phone ? `phone: ${c.phone}` : null,
    c.birthday ? `birthday: ${c.birthday}` : null,
    c.anniversary ? `anniversary: ${c.anniversary}` : null,
    `vip: ${c.vip}`,
    `created: ${c.createdAt}`,
    `updated: ${c.updatedAt}`,
    "---",
    "",
    `# ${c.name}`,
    "",
    c.notes ?? "",
  ].filter(Boolean).join("\n");
  return fm + "\n";
}

// Rebuild the mail triage VIP list from contacts marked vip=true.
async function refreshVipList(): Promise<void> {
  const rows = await loadIndex();
  const current = await readVipList();
  const vip = [...new Set([...current.vip, ...rows.filter((r) => r.vip && r.email).map((r) => r.email!)])];
  await writeVipList({ vip });
}

// Accepts a PATCH: any subset of fields, as long as the record can be identified (an `id`, or a
// `name` to slug into one). Undefined fields leave the existing value alone rather than clearing
// it — sync callers patch one field at a time and must not blank the rest.
export type ContactPatch = Partial<Omit<Contact, "createdAt" | "updatedAt">> & { id?: string; name?: string };

export async function upsertContact(input: ContactPatch): Promise<Contact> {
  const rows = await loadIndex();
  const id = input.id ?? (input.name ? slug(input.name) : undefined);
  if (!id) throw new Error("upsertContact needs an id or a name");
  const now = new Date().toISOString();
  const existing = rows.find((r) => r.id === id);
  if (!existing && !input.name) throw new Error(`upsertContact: no existing contact ${id} and no name given`);

  // Strip undefined so a partial patch can't blank out fields the caller didn't mention.
  const patch = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined));
  const next: Contact = {
    relation: "other",
    vip: false,
    createdAt: now,
    ...(existing ?? {}),
    ...patch,
    id,
    name: (patch.name as string | undefined) ?? existing?.name ?? input.name!,
    updatedAt: now,
  } as Contact;

  const i = rows.findIndex((r) => r.id === id);
  if (i >= 0) rows[i] = next; else rows.push(next);
  await saveIndex(rows);
  await fs.writeFile(path.join(await dir(), await fileForId(id)), toMd(next), "utf8");
  await refreshVipList();
  return next;
}

export async function listContacts(): Promise<Contact[]> {
  return loadIndex();
}
export async function getContact(id: string): Promise<Contact | null> {
  return (await loadIndex()).find((r) => r.id === id) ?? null;
}
export async function deleteContact(id: string): Promise<boolean> {
  const rows = await loadIndex();
  const i = rows.findIndex((r) => r.id === id);
  if (i < 0) return false;
  const target = await fileForId(id);
  rows.splice(i, 1);
  await saveIndex(rows);
  await fs.unlink(path.join(await dir(), target)).catch(() => {});
  return true;
}
