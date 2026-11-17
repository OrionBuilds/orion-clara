// Clara ↔ Microsoft 365 — OAuth2 (Entra ID v2.0) + token management.
//
// Replaces google-auth.ts. Same shape, same invariants, new identity provider:
//
// Slots:
//   "work" — Clara's own Microsoft 365 mailbox (full read/write). The only slot: Clara is an
//            executive assistant for business tasks only.
//
// The owner's personal email and their own work mailbox are intentionally NOT valid targets for
// this slot — excluded by policy, same as under Google. Which addresses those are comes from the
// owner profile (owner.ts), never from source.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { OWNER_PERSONAL_GMAIL, OWNER_WORK_EMAIL } from "./owner";
import path from "node:path";
import os from "node:os";

export type MAccount = "work";
export const M_ACCOUNTS: MAccount[] = ["work"];

export const EXCLUDED_PERSONAL_EMAIL = OWNER_PERSONAL_GMAIL;
export const EXCLUDED_OWNER_WORK_EMAIL = OWNER_WORK_EMAIL;

// Some mail systems (Gmail, and many Microsoft 365 tenants) deliver plus-addressed aliases
// (<localpart>+anything@domain) to the same inbox as the bare address — normalize both sides of
// every comparison so an alias can't slip past the exclusion checks below.
export function normalizeEmail(email: string): string {
  return email.toLowerCase().replace(/\+[^@]*@/, "@");
}

const CLARA_DIR = path.join(os.homedir(), ".agentic-os", "clara");
const TOKEN_STORE = path.join(CLARA_DIR, "ms-token.json");

if (!existsSync(CLARA_DIR)) mkdirSync(CLARA_DIR, { recursive: true });

// One combined scope list requested at consent time, so a single sign-in click covers mail,
// calendar, the SharePoint file manager, and Microsoft To Do — mirrors the single "work" button
// CLARA already shows today for Google.
export const M_SCOPES_BY_ACCOUNT: Record<MAccount, string[]> = {
  work: [
    "offline_access",
    "openid",
    "profile",
    "User.Read",
    "Mail.ReadWrite",
    "Mail.Send",
    "MailboxSettings.ReadWrite",
    "Calendars.ReadWrite",
    "Contacts.ReadWrite",
    "Sites.ReadWrite.All",
    "Files.ReadWrite.All",
    "Tasks.ReadWrite",
  ],
};

export function scopesFor(account: MAccount): string[] {
  return M_SCOPES_BY_ACCOUNT[account];
}

/** Which Microsoft slot serves a given principal. The owner's data lives in the "work" slot. */
export function accountFor(_principal: "owner"): MAccount {
  return "work";
}

export function redirectUri(): string {
  return process.env.MS_OAUTH_REDIRECT_URI ?? "http://127.0.0.1:3939/api/ms/callback";
}

interface Slot { refresh_token?: string; email?: string }
type Store = Partial<Record<MAccount, Slot>>;

function readStore(): Store {
  try { return JSON.parse(readFileSync(TOKEN_STORE, "utf8")) as Store; }
  catch { return {}; }
}
function writeStore(s: Store): void {
  writeFileSync(TOKEN_STORE, JSON.stringify(s, null, 2));
}

function client(): { id: string; secret: string; tenant: string } | null {
  const id = process.env.MS_OAUTH_CLIENT_ID?.trim();
  const secret = process.env.MS_OAUTH_CLIENT_SECRET?.trim();
  const tenant = process.env.MS_OAUTH_TENANT_ID?.trim();
  return id && secret && tenant ? { id, secret, tenant } : null;
}

function authUrl(tenant: string): string {
  return `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`;
}
function tokenUrl(tenant: string): string {
  return `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`;
}

export function mConfigured(account: MAccount): boolean {
  return Boolean(client() && readStore()[account]?.refresh_token);
}

export function connectedAccounts(): { account: MAccount; email?: string }[] {
  const store = readStore();
  return M_ACCOUNTS.filter((a) => store[a]?.refresh_token).map((a) => ({ account: a, email: store[a]?.email }));
}

export function consentUrl(account: MAccount): string | null {
  const c = client();
  if (!c) return null;
  const p = new URLSearchParams({
    client_id: c.id,
    redirect_uri: redirectUri(),
    response_type: "code",
    response_mode: "query",
    // Forces the account chooser instead of silently reusing whatever the browser last signed
    // in with — the Microsoft analogue of the Google "select_account consent" guard that once
    // let the owner's own identity land in Clara's work slot for a month.
    prompt: "select_account",
    state: account,
    scope: scopesFor(account).join(" "),
  });
  return `${authUrl(c.tenant)}?${p.toString()}`;
}

async function graphMe(accessToken: string): Promise<{ email?: string; error?: string }> {
  try {
    const r = await fetch("https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!r.ok) return { error: `me ${r.status}` };
    const j = (await r.json()) as { mail?: string; userPrincipalName?: string };
    return { email: j.mail ?? j.userPrincipalName };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

export async function exchangeCode(code: string, account: MAccount): Promise<{ ok: boolean; error?: string; email?: string }> {
  const c = client();
  if (!c) return { ok: false, error: "MS_OAUTH_CLIENT_ID/SECRET/TENANT_ID not set" };
  const r = await fetch(tokenUrl(c.tenant), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code, client_id: c.id, client_secret: c.secret,
      redirect_uri: redirectUri(), grant_type: "authorization_code",
      scope: scopesFor(account).join(" "),
    }),
  });
  if (!r.ok) return { ok: false, error: `token exchange ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}` };
  const j = (await r.json()) as { refresh_token?: string; access_token?: string };
  if (!j.refresh_token) return { ok: false, error: "no refresh_token returned (offline_access scope missing from consent?)" };

  // Pull the mailbox identity so the UI can label which account is which, and — critically — so
  // we can enforce the personal/owner-identity exclusion. FAIL-CLOSED: if we can't positively
  // confirm the account isn't excluded, refuse to store the token rather than defaulting to
  // "store it" when the verification call merely failed or timed out.
  const { email, error: verifyError } = await graphMe(j.access_token!);
  if (!email) {
    return { ok: false, error: `could not verify account email (${verifyError ?? "unknown error"}) — refusing to store token; retry the connection` };
  }
  const normalized = normalizeEmail(email);
  if (normalized === normalizeEmail(EXCLUDED_PERSONAL_EMAIL)) {
    return { ok: false, error: "personal email is excluded by Clara policy — connect a different account" };
  }
  // Also refuse the owner's own work identity — Clara's mailbox is for sending as her, not as
  // the owner. This is the exact mistake that once sent a month of outbound mail under their identity.
  if (normalized === normalizeEmail(EXCLUDED_OWNER_WORK_EMAIL)) {
    return { ok: false, error: `${EXCLUDED_OWNER_WORK_EMAIL} is the owner's identity — Clara's work slot must be a different mailbox (clara@...). Sign out and re-run the flow, choosing Clara's account.` };
  }

  const s = readStore();
  s[account] = { refresh_token: j.refresh_token, email };
  writeStore(s);
  accessCache.delete(account);
  return { ok: true, email };
}

const accessCache = new Map<MAccount, { token: string; exp: number }>();

export async function getAccessToken(account: MAccount): Promise<string> {
  const cached = accessCache.get(account);
  if (cached && Date.now() < cached.exp - 60_000) return cached.token;
  const c = client();
  const s = readStore();
  const rt = s[account]?.refresh_token;
  if (!c || !rt) throw new Error(`Microsoft (${account}) not connected — visit /settings/connect`);
  // Defense in depth: re-check the policy at every token use, not just at OAuth-exchange time —
  // guards against a manually edited token-store file smuggling an excluded identity into the
  // "work" slot after the fact.
  const rawEmail = s[account]?.email;
  const storedEmail = rawEmail ? normalizeEmail(rawEmail) : undefined;
  if (storedEmail === normalizeEmail(EXCLUDED_PERSONAL_EMAIL) || storedEmail === normalizeEmail(EXCLUDED_OWNER_WORK_EMAIL)) {
    throw new Error(`Microsoft (${account}) token points at an excluded identity — disconnect and reconnect a different account`);
  }
  const r = await fetch(tokenUrl(c.tenant), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: c.id, client_secret: c.secret, refresh_token: rt, grant_type: "refresh_token",
      scope: scopesFor(account).join(" "),
    }),
  });
  if (!r.ok) throw new Error(`Microsoft (${account}) token refresh ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}`);
  const j = (await r.json()) as { access_token: string; refresh_token?: string; expires_in?: number };
  // Microsoft rotates refresh tokens on use; persist the new one or the old one goes stale.
  if (j.refresh_token && j.refresh_token !== rt) {
    const store = readStore();
    if (store[account]) { store[account]!.refresh_token = j.refresh_token; writeStore(store); }
  }
  const entry = { token: j.access_token, exp: Date.now() + (j.expires_in ?? 3600) * 1000 };
  accessCache.set(account, entry);
  return entry.token;
}

// Which hosts the work slot may touch, enforced at call time — same defense-in-depth spirit as
// the identity checks above, regardless of what any stored token happens to carry.
const ALLOWED_HOSTS: Record<MAccount, RegExp> = {
  work: /^(graph\.microsoft\.com|login\.microsoftonline\.com)$/,
};

function assertHostAllowed(url: string, account: MAccount): void {
  let u: URL;
  try { u = new URL(url); } catch { throw new Error(`mfetch: unparseable URL for ${account}: ${url}`); }
  if (!ALLOWED_HOSTS[account].test(u.hostname)) {
    throw new Error(`Microsoft (${account}) is not permitted to call ${u.hostname} — scope policy`);
  }
}

export async function mfetch(url: string, init: RequestInit = {}, account: MAccount = "work"): Promise<Response> {
  assertHostAllowed(url, account);
  const token = await getAccessToken(account);
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  return fetch(url, { ...init, headers });
}
