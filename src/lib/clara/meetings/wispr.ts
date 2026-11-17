// Clara ↔ Wispr Flow — remote MCP client (read-only), OAuth once.
//
// Wispr's MCP server is not public: the owner copies its URL from Wispr Flow → Settings → MCP →
// "All other apps" into CLARA_WISPR_MCP_URL. Auth is standard MCP OAuth (discovery + PKCE + dynamic
// client registration), all driven by the SDK's `auth()` through the provider below. The provider
// NEVER opens a browser: the first connect stores the authorization URL as `pendingAuthUrl`, and
// GET /api/meetings/wispr/auth redirects the owner there; the callback route hands the code back to
// finishAuth(). Everything persists in <dataDir>/wispr-session.json (tokens included — same posture
// as google-token.json next to it).
//
// Same connection discipline as agent-core's OsMcpClient: a fresh Client + transport per call,
// closed in `finally`. The transport snapshots headers at construction, so a long-lived one would
// happily keep sending an expired token; per-call construction lets the SDK refresh on its own.

import { promises as fs } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError, type OAuthClientProvider, type OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { loadConfig } from "../config";
import type { MeetingRecord } from "./types";

const DEFAULT_REDIRECT = "https://clara.example.com/api/meetings/wispr/callback";
const SESSION_FILE = "wispr-session.json";

export function wisprUrl(): string | null {
  const u = process.env.CLARA_WISPR_MCP_URL?.trim();
  return u || null;
}
export function wisprRedirectUri(): string {
  return process.env.CLARA_WISPR_REDIRECT_URI?.trim() || DEFAULT_REDIRECT;
}
export function wisprConfigured(): boolean {
  return Boolean(wisprUrl());
}

// ── Session persistence ─────────────────────────────────────────────────────
export interface WisprSession {
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  codeVerifier?: string;
  discovery?: OAuthDiscoveryState;
  pendingAuthUrl?: string;
  pendingState?: string;
  /** Poll cursor — the newest `modified_at` we have fully processed. */
  cursorModifiedAt?: string;
  lastPollAt?: string;
  lastOk?: string;
  lastError?: string;
  /** Recorded at DCR time; a changed CLARA_WISPR_REDIRECT_URI means the registration must be redone. */
  registeredRedirectUri?: string;
}

async function sessionPath(): Promise<string> {
  const cfg = await loadConfig();
  await fs.mkdir(cfg.dataDir, { recursive: true });
  return path.join(cfg.dataDir, SESSION_FILE);
}

export async function readSession(): Promise<WisprSession> {
  try { return JSON.parse(await fs.readFile(await sessionPath(), "utf8")) as WisprSession; }
  catch { return {}; }
}

async function writeSession(s: WisprSession): Promise<void> {
  const p = await sessionPath();
  const tmp = `${p}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(s, null, 2), { encoding: "utf8", mode: 0o600 });
  await fs.rename(tmp, p);
}

export async function patchSession(patch: Partial<WisprSession>): Promise<WisprSession> {
  const next = { ...(await readSession()), ...patch };
  for (const k of Object.keys(next) as (keyof WisprSession)[]) if (next[k] === undefined) delete next[k];
  await writeSession(next);
  return next;
}

// ── OAuth provider ──────────────────────────────────────────────────────────
export class WisprAuthProvider implements OAuthClientProvider {
  get redirectUrl(): string { return wisprRedirectUri(); }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "CLARA",
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  async state(): Promise<string> {
    const s = randomBytes(16).toString("hex");
    await patchSession({ pendingState: s });
    return s;
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    const s = await readSession();
    // A registration bound to a different redirect URI is useless — force a fresh DCR.
    if (s.clientInformation && s.registeredRedirectUri && s.registeredRedirectUri !== this.redirectUrl) return undefined;
    return s.clientInformation;
  }
  async saveClientInformation(info: OAuthClientInformationMixed): Promise<void> {
    await patchSession({ clientInformation: info, registeredRedirectUri: this.redirectUrl });
  }

  async tokens(): Promise<OAuthTokens | undefined> { return (await readSession()).tokens; }
  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await patchSession({ tokens, pendingAuthUrl: undefined, lastError: undefined });
  }

  /** Never opens a browser — the auth route reads pendingAuthUrl and redirects the owner. */
  async redirectToAuthorization(url: URL): Promise<void> {
    await patchSession({ pendingAuthUrl: url.toString() });
  }

  async saveCodeVerifier(v: string): Promise<void> { await patchSession({ codeVerifier: v }); }
  async codeVerifier(): Promise<string> {
    const v = (await readSession()).codeVerifier;
    if (!v) throw new Error("wispr: no PKCE code verifier on file — start the sign-in again");
    return v;
  }

  async saveDiscoveryState(d: OAuthDiscoveryState): Promise<void> { await patchSession({ discovery: d }); }
  async discoveryState(): Promise<OAuthDiscoveryState | undefined> { return (await readSession()).discovery; }

  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): Promise<void> {
    const patch: Partial<WisprSession> = {};
    if (scope === "all" || scope === "client") { patch.clientInformation = undefined; patch.registeredRedirectUri = undefined; }
    if (scope === "all" || scope === "tokens") patch.tokens = undefined;
    if (scope === "all" || scope === "verifier") patch.codeVerifier = undefined;
    if (scope === "all" || scope === "discovery") patch.discovery = undefined;
    await patchSession(patch);
  }
}

// ── Per-call client ─────────────────────────────────────────────────────────
function newTransport(provider: WisprAuthProvider): StreamableHTTPClientTransport {
  const url = wisprUrl();
  if (!url) throw new Error("CLARA_WISPR_MCP_URL not set — copy it from Wispr Flow → Settings → MCP → All other apps");
  return new StreamableHTTPClientTransport(new URL(url), { authProvider: provider });
}

async function withClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const provider = new WisprAuthProvider();
  const transport = newTransport(provider);
  const client = new Client({ name: "CLARA", version: "0.1.0" }, { capabilities: {} });
  await client.connect(transport); // no tokens → provider stores pendingAuthUrl, SDK throws UnauthorizedError
  try {
    return await fn(client);
  } finally {
    await client.close().catch(() => {});
  }
}

/** Tool results arrive as MCP content [{type:"text", text:"<json>"}] — unwrap and parse. */
async function callTool<T>(client: Client, name: string, args: Record<string, unknown>): Promise<T> {
  const res = await client.callTool({ name, arguments: args });
  const text = Array.isArray(res.content)
    ? (res.content as { type: string; text?: string }[]).filter((c) => c.type === "text").map((c) => c.text ?? "").join("")
    : "";
  if (res.isError) throw new Error(`wispr: ${name} failed: ${text.slice(0, 300)}`);
  try { return JSON.parse(text) as T; }
  catch { throw new Error(`wispr: ${name} returned non-JSON content: ${text.slice(0, 200)}`); }
}

// ── Auth entry points (routes) ──────────────────────────────────────────────
export async function wisprConnected(): Promise<boolean> {
  return Boolean((await readSession()).tokens?.access_token);
}

/**
 * Start (or restart) the sign-in. Drops any stored tokens so the SDK is forced through the
 * authorization step, then attempts a connect purely to make the provider capture the auth URL.
 */
export async function beginAuth(): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  if (!wisprConfigured()) return { ok: false, error: "CLARA_WISPR_MCP_URL not set" };
  await patchSession({ tokens: undefined, pendingAuthUrl: undefined });
  try {
    await withClient(async () => undefined);
  } catch (e) {
    if (!(e instanceof UnauthorizedError)) {
      const msg = String((e as Error).message ?? e);
      await patchSession({ lastError: `auth: ${msg.slice(0, 200)}` });
      return { ok: false, error: msg };
    }
  }
  const url = (await readSession()).pendingAuthUrl;
  return url ? { ok: true, url } : { ok: false, error: "Wispr did not ask for authorization — is the server URL right?" };
}

export async function finishAuth(code: string, state?: string | null): Promise<{ ok: true } | { ok: false; error: string }> {
  const s = await readSession();
  if (s.pendingState && state && s.pendingState !== state) return { ok: false, error: "state mismatch — restart the sign-in" };
  try {
    const transport = newTransport(new WisprAuthProvider());
    await transport.finishAuth(code);
    await patchSession({ pendingAuthUrl: undefined, pendingState: undefined, codeVerifier: undefined, lastError: undefined });
    // Prove the tokens actually work before reporting success.
    await withClient(async (c) => { await c.listTools(); });
    await patchSession({ lastOk: new Date().toISOString() });
    return { ok: true };
  } catch (e) {
    const msg = String((e as Error).message ?? e);
    await patchSession({ lastError: `finishAuth: ${msg.slice(0, 200)}` });
    return { ok: false, error: msg };
  }
}

export interface WisprStatus {
  configured: boolean;
  connected: boolean;
  redirectUri: string;
  pendingAuthUrl?: string;
  cursorModifiedAt?: string;
  lastPollAt?: string;
  lastOk?: string;
  lastError?: string;
}
export async function wisprStatus(): Promise<WisprStatus> {
  const s = await readSession();
  return {
    configured: wisprConfigured(),
    connected: Boolean(s.tokens?.access_token),
    redirectUri: wisprRedirectUri(),
    pendingAuthUrl: s.pendingAuthUrl,
    cursorModifiedAt: s.cursorModifiedAt,
    lastPollAt: s.lastPollAt,
    lastOk: s.lastOk,
    lastError: s.lastError,
  };
}

// ── Transcript chunk helpers (pure — tested) ────────────────────────────────
const CONTINUE_RX = /continue with view_transcript\.start_char=(\d+)/;
const TRUNCATED_LINE_RX = /^\s*\(\.\.\.truncated,.*?\)\s*$/gm;
const MARKER_LINE_RX = /^\s*<<<.*?>>>\s*$/gm;

/** Absolute start_char for the next chunk, or null when the chunk was the last one. */
export function nextOffset(chunk: string): number | null {
  const m = chunk.match(CONTINUE_RX);
  return m ? Number(m[1]) : null;
}

/** Drop Wispr's `<<<PARTICIPANT NAMES …>>>` / `<<<END TRANSCRIPT>>>` wrapper lines and the truncation notice. */
export function stripMarkers(chunk: string): string {
  return chunk.replace(TRUNCATED_LINE_RX, "").replace(MARKER_LINE_RX, "").replace(/\n{3,}/g, "\n\n").trim();
}

// ── Meetings ────────────────────────────────────────────────────────────────
export interface WisprMeetingMeta {
  id: string;
  title: string;
  attendees: string[];
  start: string;
  end?: string;
  modified_at?: string;
  finalized?: boolean;
  has_transcript?: boolean;
  share_link?: string;
  content_excerpt?: string;
}
interface SearchResult { meetings?: WisprMeetingMeta[]; has_more?: boolean; next_cursor?: string }
interface GetMeetingResult {
  summary?: string;
  attendees?: { name?: string; response?: string; organizer?: boolean }[];
  transcript?: string;
  content?: string;
  start?: string;
  end?: string;
  share_link?: string;
}

const PAGE_LIMIT = 50;
const MAX_PAGES = 10;
const CHUNK_CHARS = 40_000;
const MAX_CHUNKS = 12; // ~480k chars — far past any real meeting

/** Finalized meetings with a transcript, modified since `sinceISO`, oldest first. */
export async function listRecentMeetings(sinceISO: string): Promise<WisprMeetingMeta[]> {
  return withClient(async (client) => {
    const out: WisprMeetingMeta[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const args: Record<string, unknown> = { since: sinceISO, limit: PAGE_LIMIT };
      if (cursor) args.cursor = cursor;
      const r = await callTool<SearchResult>(client, "search_meetings", args);
      out.push(...(r.meetings ?? []));
      if (!r.has_more || !r.next_cursor) break;
      cursor = r.next_cursor;
    }
    return out
      .filter((m) => m.finalized && m.has_transcript)
      .sort((a, b) => (a.start ?? "").localeCompare(b.start ?? ""));
  });
}

/** Full meeting — pages the transcript by the continuation marker; attendee emails best-effort. */
export async function getMeeting(id: string, meta?: Partial<WisprMeetingMeta>): Promise<MeetingRecord> {
  return withClient(async (client) => {
    const parts: string[] = [];
    let first: GetMeetingResult | null = null;
    let start = 0;
    for (let i = 0; i < MAX_CHUNKS; i++) {
      const r = await callTool<GetMeetingResult>(client, "get_meeting", {
        meeting_id: id,
        view_transcript: { start_char: start, char_limit: CHUNK_CHARS },
      });
      if (!first) first = r;
      const chunk = r.transcript ?? "";
      parts.push(stripMarkers(chunk));
      const next = nextOffset(chunk);
      if (next == null || next <= start) break;
      start = next;
    }
    const m = first ?? {};
    let attendeeEmails: string[] | undefined;
    try {
      const e = await callTool<unknown>(client, "get_meeting_attendee_emails", { meeting_id: id });
      attendeeEmails = extractEmails(e);
    } catch { /* best-effort */ }

    // get_meeting carries no title. The scheduled poll passes the search_meetings stub; a manual
    // `/api/meetings/ingest {id}` does not — so find this meeting in search_meetings around its start.
    if (!meta?.title && m.start) {
      try {
        const since = new Date(new Date(m.start).getTime() - 2 * 86_400_000).toISOString();
        let cursor: string | undefined;
        for (let page = 0; page < 3 && !meta?.title; page++) {
          const args: Record<string, unknown> = { since, limit: 50 };
          if (cursor) args.cursor = cursor;
          const r = await callTool<{ meetings?: Array<Partial<WisprMeetingMeta> & { id?: string }>; has_more?: boolean; next_cursor?: string }>(client, "search_meetings", args);
          const hit = (r.meetings ?? []).find((x) => x.id === id);
          if (hit) { meta = { ...hit, ...(meta ?? {}) }; break; }
          if (!r.has_more || !r.next_cursor) break;
          cursor = r.next_cursor;
        }
      } catch { /* best-effort: fall back to "Untitled meeting" */ }
    }

    const names = (m.attendees ?? []).map((a) => a.name?.trim()).filter((n): n is string => Boolean(n));
    const summary = [m.summary?.trim(), m.content?.trim()].filter(Boolean).join("\n\n") || undefined;
    return {
      source: "wispr",
      sourceId: id,
      title: meta?.title?.trim() || "Untitled meeting",
      attendees: names.length ? names : (meta?.attendees ?? []),
      attendeeEmails,
      startedAt: m.start ?? meta?.start ?? new Date().toISOString(),
      endedAt: m.end ?? meta?.end,
      transcript: parts.filter(Boolean).join("\n"),
      summary,
      shareLink: m.share_link ?? meta?.share_link,
    };
  });
}

/** get_meeting_attendee_emails' exact shape isn't pinned — pull anything email-like out of it. */
function extractEmails(v: unknown): string[] | undefined {
  const found = new Set<string>();
  const walk = (x: unknown): void => {
    if (typeof x === "string") { if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x)) found.add(x.toLowerCase()); return; }
    if (Array.isArray(x)) { x.forEach(walk); return; }
    if (x && typeof x === "object") Object.values(x as Record<string, unknown>).forEach(walk);
  };
  walk(v);
  return found.size ? [...found] : undefined;
}

// ── Poll bookkeeping (used by ingest.ts) ────────────────────────────────────
export async function recordPoll(r: { ok: boolean; error?: string; cursorModifiedAt?: string }): Promise<void> {
  const now = new Date().toISOString();
  await patchSession({
    lastPollAt: now,
    ...(r.ok ? { lastOk: now, lastError: undefined } : { lastError: (r.error ?? "unknown").slice(0, 200) }),
    ...(r.cursorModifiedAt ? { cursorModifiedAt: r.cursorModifiedAt } : {}),
  });
}
