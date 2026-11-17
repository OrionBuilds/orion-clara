// Clara ↔ Google Workspace — OAuth2 + token management.
//
// Mirrors FRIDAY's auth pattern but with Clara-owned slots + token file so the two apps stay
// independent. Shares OAuth client credentials (GOOGLE_CLIENT_ID/SECRET) with FRIDAY when set.
//
// Slots:
//   "work" — the owner's work Google account (full read/write). The only slot: Clara is an
//            executive assistant for business tasks only.
//
// The owner's personal Gmail is intentionally NOT a slot — excluded by policy. Which address that
// is comes from the owner profile (identity.excludedAccounts), never from source.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { OWNER_PERSONAL_GMAIL } from "./owner";
import path from "node:path";
import os from "node:os";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";

export type GAccount = "work";
export const G_ACCOUNTS: GAccount[] = ["work"];

export const PERSONAL_GMAIL = OWNER_PERSONAL_GMAIL;

// Plus-addressed aliases (<localpart>+anything@gmail.com) deliver to the same personal inbox as
// the bare address, so a strict equality check alone would miss them.
export function normalizeGmail(email: string): string {
  return email.toLowerCase().replace(/\+[^@]*@/, "@");
}

const CLARA_DIR = path.join(os.homedir(), ".agentic-os", "clara");
const TOKEN_STORE = path.join(CLARA_DIR, "google-token.json");

if (!existsSync(CLARA_DIR)) mkdirSync(CLARA_DIR, { recursive: true });

const IDENTITY_SCOPES = [
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "openid",
];

// Scopes are per-slot. The owner's work account gets Clara's full Workspace surface.
//
// Note `contacts` (not contacts.readonly): two-way contact sync writes back to Google.
export const G_SCOPES_BY_ACCOUNT: Record<GAccount, string[]> = {
  work: [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.send",
    "https://www.googleapis.com/auth/gmail.modify",
    // Server-side filters (block_sender / create_filter). Listed here so the NEXT consent grants it.
    //
    // Adding a scope to this list does not widen the refresh token that already exists — Google only
    // grants scopes at consent time — so until the work account is re-authorized, the filters API
    // will 403. That is handled, not ignored: gmail.ts returns `needsConsent` for exactly this case,
    // and blocking still works meanwhile through blocklist.ts, which needs only gmail.modify.
    "https://www.googleapis.com/auth/gmail.settings.basic",
    "https://www.googleapis.com/auth/calendar",
    "https://www.googleapis.com/auth/tasks",
    "https://www.googleapis.com/auth/contacts",
    "https://www.googleapis.com/auth/drive",
    "https://www.googleapis.com/auth/drive.activity.readonly",
    "https://www.googleapis.com/auth/documents",
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/presentations",
    ...IDENTITY_SCOPES,
  ],
};

export function scopesFor(account: GAccount): string[] {
  return G_SCOPES_BY_ACCOUNT[account];
}

/** Which Google slot serves a given principal. The owner's data lives in the "work" slot. */
export function accountFor(_principal: "owner"): GAccount {
  return "work";
}

// Back-compat alias for anything still importing the old flat list.
export const G_SCOPES = G_SCOPES_BY_ACCOUNT.work;

export function redirectUri(): string {
  return process.env.GOOGLE_OAUTH_REDIRECT_URI ?? "http://127.0.0.1:3939/api/google/callback";
}

interface Slot { refresh_token?: string; email?: string }
type Store = Partial<Record<GAccount, Slot>>;

function readStore(): Store {
  try { return JSON.parse(readFileSync(TOKEN_STORE, "utf8")) as Store; }
  catch { return {}; }
}
function writeStore(s: Store): void {
  writeFileSync(TOKEN_STORE, JSON.stringify(s, null, 2));
}

function client(): { id: string; secret: string } | null {
  const id = (process.env.GOOGLE_OAUTH_CLIENT_ID ?? process.env.GOOGLE_CLIENT_ID)?.trim();
  const secret = (process.env.GOOGLE_OAUTH_CLIENT_SECRET ?? process.env.GOOGLE_CLIENT_SECRET)?.trim();
  return id && secret ? { id, secret } : null;
}

export function gConfigured(account: GAccount): boolean {
  return Boolean(client() && readStore()[account]?.refresh_token);
}

export function connectedAccounts(): { account: GAccount; email?: string }[] {
  const store = readStore();
  return G_ACCOUNTS.filter((a) => store[a]?.refresh_token).map((a) => ({ account: a, email: store[a]?.email }));
}

export function consentUrl(account: GAccount): string | null {
  const c = client();
  if (!c) return null;
  const p = new URLSearchParams({
    client_id: c.id,
    redirect_uri: redirectUri(),
    response_type: "code",
    access_type: "offline",
    // `select_account consent` forces Google to always show the account chooser instead of
    // silently reusing whatever the browser last signed in with — the exact failure that landed
    // jordan@example.com on Clara's work slot on 2026-10-02 and sent every outbound email
    // under their identity for a month. The second `consent` keeps the refresh_token guarantee.
    prompt: "select_account consent",
    state: account,
    scope: scopesFor(account).join(" "),
  });
  return `${AUTH_URL}?${p.toString()}`;
}

export async function exchangeCode(code: string, account: GAccount): Promise<{ ok: boolean; error?: string; email?: string }> {
  const c = client();
  if (!c) return { ok: false, error: "GOOGLE_OAUTH_CLIENT_ID/SECRET not set" };
  const r = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code, client_id: c.id, client_secret: c.secret,
      redirect_uri: redirectUri(), grant_type: "authorization_code",
    }),
  });
  if (!r.ok) return { ok: false, error: `token exchange ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}` };
  const j = await r.json() as { refresh_token?: string; access_token?: string };
  if (!j.refresh_token) return { ok: false, error: "no refresh_token returned (re-consent with prompt=consent)" };

  // Pull email so the UI can label which account is which — and, critically, so we can
  // enforce the personal-Gmail exclusion. This must be FAIL-CLOSED: if we can't positively
  // confirm the account isn't the excluded personal Gmail, we refuse to store the token at all,
  // rather than defaulting to "store it" when the verification call merely failed/timed out.
  let email: string | undefined;
  let verifyError: string | undefined;
  try {
    const p = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { Authorization: `Bearer ${j.access_token}` },
    });
    if (p.ok) email = (await p.json() as { email?: string }).email;
    else verifyError = `userinfo ${p.status}`;
  } catch (e) {
    verifyError = (e as Error).message;
  }

  if (!email) {
    return { ok: false, error: `could not verify account email (${verifyError ?? "unknown error"}) — refusing to store token; retry the connection` };
  }
  // Exact match AND plus-addressed aliases (<localpart>+anything@gmail.com deliver to the same
  // personal inbox) are both excluded — a strict equality check alone missed the alias case.
  const normalized = normalizeGmail(email);
  if (normalized === PERSONAL_GMAIL) {
    return { ok: false, error: "personal Gmail is excluded by Clara policy — connect a different account" };
  }
  // Also refuse the owner's WORK identity (2026-10-03). Clara's Gmail is for sending as her —
  // not as the owner. The PERSONAL_GMAIL check above catches jordan.personal@example.com; this catches the
  // Workspace jordan@example.com, which is what the previous flow silently stored.
  const { OWNER_WORK_EMAIL } = await import("./owner");
  if (normalized === normalizeGmail(OWNER_WORK_EMAIL)) {
    return { ok: false, error: `${OWNER_WORK_EMAIL} is the owner's identity — Clara's work slot must be a different mailbox (clara@...). Sign out and re-run the flow, choosing clara's account.` };
  }

  const s = readStore();
  s[account] = { refresh_token: j.refresh_token, email };
  writeStore(s);
  accessCache.delete(account);
  return { ok: true, email };
}

const accessCache = new Map<GAccount, { token: string; exp: number }>();

export async function getAccessToken(account: GAccount): Promise<string> {
  const cached = accessCache.get(account);
  if (cached && Date.now() < cached.exp - 60_000) return cached.token;
  const c = client();
  const s = readStore();
  const rt = s[account]?.refresh_token;
  if (!c || !rt) throw new Error(`Google (${account}) not connected — visit /settings/connect`);
  // Defense in depth: re-check the policy at every token use, not just at OAuth-exchange time —
  // guards against a manually edited token-store file smuggling a personal-Gmail refresh token
  // into the "work" slot after the fact.
  const rawEmail = s[account]?.email;
  const storedEmail = rawEmail ? normalizeGmail(rawEmail) : undefined;
  if (storedEmail === PERSONAL_GMAIL) {
    throw new Error(`Google (${account}) token points at the excluded personal Gmail account — disconnect and reconnect a different account`);
  }
  const r = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: c.id, client_secret: c.secret, refresh_token: rt, grant_type: "refresh_token" }),
  });
  if (!r.ok) throw new Error(`Google (${account}) token refresh ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}`);
  const j = await r.json() as { access_token: string; expires_in?: number };
  const entry = { token: j.access_token, exp: Date.now() + (j.expires_in ?? 3600) * 1000 };
  accessCache.set(account, entry);
  return entry.token;
}

// Which Google APIs the work slot may touch, enforced at call time.
//
// This check makes the scope restriction real regardless of what any stored token happens to
// carry — same fail-closed spirit as the personal-Gmail block above.
const ALLOWED_HOSTS: Record<GAccount, RegExp> = {
  // The owner's work slot: Clara's full Workspace surface.
  work: /^(www\.googleapis\.com|gmail\.googleapis\.com|tasks\.googleapis\.com|people\.googleapis\.com|docs\.googleapis\.com|sheets\.googleapis\.com|slides\.googleapis\.com|driveactivity\.googleapis\.com|oauth2\.googleapis\.com)$/,
};

function assertHostAllowed(url: string, account: GAccount): void {
  let u: URL;
  try { u = new URL(url); } catch { throw new Error(`gfetch: unparseable URL for ${account}: ${url}`); }
  if (!ALLOWED_HOSTS[account].test(u.hostname)) {
    throw new Error(`Google (${account}) is not permitted to call ${u.hostname} — scope policy`);
  }
}

export async function gfetch(url: string, init: RequestInit = {}, account: GAccount = "work"): Promise<Response> {
  assertHostAllowed(url, account);
  const token = await getAccessToken(account);
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  return fetch(url, { ...init, headers });
}
