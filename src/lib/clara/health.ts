// Clara — system health probe for the /system dashboard.

import { ttsHealthSnapshot } from "./ttsHealth";
import { promises as fs } from "node:fs";
import path from "node:path";
import { loadConfig } from "./config";
import { connectedAccounts, M_ACCOUNTS } from "./ms-auth";
import { twilioConfig, elevenKey } from "./channels";
import { placesConfigured } from "./places";
import { googleKeyCandidateNames } from "./google-key";
import { fridayHealth } from "./friday-bridge";
import { classify, pickEngine, assertLocalIfSensitive } from "./sensitivity";
import { isSensitiveHit } from "./rag";
import { whisperHealth, type WhisperHealth } from "./transcribe";
import { engineHealthDeep, type DeepHealthMap } from "./engines";
import { stirlingHealth } from "./stirling";
import { lmStudioBaseUrl, lmStudioChatModel, lmStudioEmbedModel } from "./lmstudio";
import { weatherConfigured } from "./weather";
import { searchDrive } from "./ms-files";
import { loadLinks, loadPending } from "./sync-engine";
import { OWNER_FIRST } from "./owner";

export interface HealthReport {
  engines: {
    lmstudio: { reachable: boolean; note?: string; chatModel?: string; embedModel?: string };
    anthropic: { configured: boolean };
    elevenlabs: { configured: boolean; usable: boolean; reason?: string };
  };
  // Full 5-engine roster (claude/codex/antigravity/hermes/lmstudio) — configured + auth status.
  engineRoster: DeepHealthMap;
  integrations: {
    googleWork: boolean;
    twilio: boolean;
    places: boolean;
    weather: boolean;
    // Only populated when the Maps key is unresolved — names of Google-ish env vars Clara can
    // see, so a key set under an unexpected name is findable without exposing any secret.
    googleKeyCandidates?: string[];
    drive: { ok: boolean; detail?: string };
    sync: { kind: string; account: string; lastRunAt: string | null; linked: number; pending: number }[];
    friday: { ok: boolean; base: string; error?: string };
    // The Office OS (CRM/tickets over MCP) — a real contacts_list call, so "signed in" is proven, not assumed.
    os: { enabled: boolean; ok: boolean; ms?: number; detail?: string };
    stirlingPdf: boolean;
    whisper: WhisperHealth;
    // Wispr Flow meeting source (remote MCP) + the meeting-ingest gate. No tokens, no auth URL.
    wispr: { configured: boolean; connected: boolean; mode: string; lastPollAt?: string; lastOk?: string; lastError?: string };
  };
  vault: { root: string; sizeMb: number; fileCount: number };
  sensitivity: {
    testCases: { name: string; explicit?: boolean; verdictSensitive: boolean; enginePicked: string; blocked: boolean }[];
    ok: boolean;
  };
}

async function walk(dir: string): Promise<{ bytes: number; files: number }> {
  let bytes = 0, files = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop()!;
    let entries: import("node:fs").Dirent[] = [];
    try { entries = await fs.readdir(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) stack.push(full);
      else { try { const s = await fs.stat(full); bytes += s.size; files++; } catch { /* skip */ } }
    }
  }
  return { bytes, files };
}

// A cheap real call — proves the Files/Sites scope actually got granted, not just that a token
// exists. A brand-new token without it returns 403 here, which is exactly what we want to surface
// on /system rather than discovering it the first time the owner asks Clara to find a file.
//
// GRAPH REWRITE: Google's check resolved a specific shared-drive id (claraDriveId, a Google Drive
// concept) and confirmed it was reachable. SharePoint/ms-files.ts has no "shared drive by id"
// model — it resolves ONE configured drive via MS_SHAREPOINT_DRIVE_ID / MS_SHAREPOINT_SITE_ID
// (driveId()/driveBase()). The equivalent check here is: does that drive resolve at all, and is
// its root reachable — which doubles as confirming MS_SHAREPOINT_DRIVE_ID/SITE_ID are actually
// set, not just that some token exists.
async function probeDrive(): Promise<{ ok: boolean; detail?: string }> {
  try {
    await searchDrive("clara-drive-probe", { max: 1 });
    const { driveBase, filesConfigured } = await import("./ms-files");
    if (!filesConfigured()) return { ok: true, detail: "SharePoint drive not configured (MS_SHAREPOINT_DRIVE_ID/SITE_ID unset)" };
    const base = await driveBase("work");
    const { mfetch } = await import("./ms-auth");
    const r = await mfetch(`${base}/root?$select=id,name`, {}, "work");
    if (!r.ok) return { ok: false, detail: `SharePoint drive not reachable (HTTP ${r.status})` };
    const d = await r.json().catch(() => null) as { name?: string } | null;
    return { ok: true, detail: d?.name ? `drive "${d.name}" reachable` : undefined };
  } catch (e) {
    const msg = String((e as Error).message ?? e);
    if (/not connected/i.test(msg)) return { ok: false, detail: "Microsoft not connected" };
    // Graph's own distinct shapes for "scope missing" vs "not configured at all" — surfacing which
    // one matters, since "reconnect the account" is useless advice when the drive id is just unset.
    if (/not configured/i.test(msg)) return { ok: false, detail: msg.slice(0, 160) };
    if (/Authorization_RequestDenied|ErrorAccessDenied|insufficient/i.test(msg)) {
      return { ok: false, detail: "scope not granted — reconnect the work account" };
    }
    if (/\b403\b/.test(msg)) return { ok: false, detail: `403 — ${msg.slice(0, 160)}` };
    return { ok: false, detail: msg.slice(0, 160) };
  }
}

async function syncStatus(): Promise<HealthReport["integrations"]["sync"]> {
  const combos: { kind: "tasks" | "contacts"; account: (typeof M_ACCOUNTS)[number] }[] = [
    ...M_ACCOUNTS.map((a) => ({ kind: "tasks" as const, account: a })),
    { kind: "contacts" as const, account: "work" as const },
  ];
  const out: HealthReport["integrations"]["sync"] = [];
  for (const { kind, account } of combos) {
    const store = await loadLinks(kind, account).catch(() => null);
    const pending = await loadPending(kind, account).catch(() => []);
    out.push({
      kind, account,
      lastRunAt: store?.lastRunAt ?? null,
      linked: store ? Object.keys(store.links).length : 0,
      pending: pending.length,
    });
  }
  return out;
}

async function pingLmStudio(): Promise<{ reachable: boolean; note?: string; chatModel?: string; embedModel?: string }> {
  try {
    const base = await lmStudioBaseUrl();
    const r = await fetch(`${base}/models`, { signal: AbortSignal.timeout(3000) });
    if (!r.ok) return { reachable: false, note: `HTTP ${r.status}` };
    // Best-effort — resolving the actual model IDs is what makes /system a real verification
    // surface ("is Clara using the right models") instead of just a green/red reachability dot.
    const [chatModel, embedModel] = await Promise.all([
      lmStudioChatModel().catch((e) => `unresolved: ${(e as Error).message}`),
      lmStudioEmbedModel().catch((e) => `unresolved: ${(e as Error).message}`),
    ]);
    return { reachable: true, chatModel, embedModel };
  } catch (e) { return { reachable: false, note: (e as Error).message }; }
}

export async function healthReport(): Promise<HealthReport> {
  const cfg = await loadConfig();
  const [lm, gAccounts, size, friday, engineRoster, stirlingPdf, weather, drive, sync, whisper, os] = await Promise.all([
    pingLmStudio(),
    connectedAccounts(),
    walk(cfg.vaultRoot),
    fridayHealth(),
    engineHealthDeep(),
    stirlingHealth(),
    // Cached internally (5 min TTL), so this no longer spawns a subprocess per page load. The
    // .catch() matters because every other entry here has one — without it a single throw from
    // this probe would take out the whole /system page.
    weatherConfigured().catch(() => false),
    probeDrive(),
    syncStatus().catch(() => [] as HealthReport["integrations"]["sync"]),
    whisperHealth().catch(() => ({ binFound: false, modelFound: false, ffmpegFound: false }) as WhisperHealth),
    osHealth().catch((e) => ({ enabled: true, ok: false, detail: String(e).slice(0, 160) })),
  ]);

  // Sensitivity probes — for each seed, classify + pickEngine + assert. If any sensitive
  // input picks a cloud engine, the report flags it.
  const seeds = [
    { name: "medical/lab", input: { text: `${OWNER_FIRST}'s lab results came back — cholesterol 260` } },
    { name: "sensitive path", input: { path: "vault/sensitive/investor-update.md" } },
    { name: "attorney/client", input: { text: "Attorney-client privileged — draft response to notice" } },
    { name: "cap table", input: { text: "Update the investor cap table for the SAFE round" } },
    { name: "benign", input: { text: "Book dinner Saturday at 7" } },
  ];
  const tested: HealthReport["sensitivity"]["testCases"] = [];
  let ok = true;
  for (const s of seeds) {
    const hint = classify(s.input);
    const picked = pickEngine(hint, "claude");
    let blocked = false;
    try { assertLocalIfSensitive(hint, picked); }
    catch { blocked = true; ok = false; }
    tested.push({ name: s.name, verdictSensitive: hint.sensitive, enginePicked: picked, blocked });
  }

  // RAG-specific probes (B2): memory.ts's relPaths have NO leading slash ("sensitive/x.md"), which
  // the folder pattern above (/\/sensitive\//i) does NOT match on its own — a bare classify() call
  // on that path would miss it. isSensitiveHit() in rag.ts dual-checks the top-level folder name
  // explicitly; these two probes prove that gate actually catches what classify() alone would leak.
  const sensitiveHitCaught = isSensitiveHit({ relPath: "sensitive/family-medical.md", snippet: "reference data" });
  tested.push({ name: "RAG: sensitive/ folder (no leading slash)", verdictSensitive: sensitiveHitCaught, enginePicked: "excluded from cloud RAG", blocked: sensitiveHitCaught });
  if (!sensitiveHitCaught) ok = false; // this IS the leak the dual-check exists to close

  const benignHitPassed = isSensitiveHit({ relPath: "contacts/jane-doe.md", snippet: "Contact record (reference data)" });
  tested.push({ name: "RAG: benign vault hit", verdictSensitive: benignHitPassed, enginePicked: "eligible for cloud RAG", blocked: false });
  // A false positive here isn't a leak (just over-exclusion), so it doesn't flip `ok`.

  return {
    engines: {
      lmstudio: lm,
      anthropic: { configured: Boolean(process.env.ANTHROPIC_API_KEY) },
      elevenlabs: (() => { const configured = Boolean(elevenKey()); const t = ttsHealthSnapshot(); return { configured, usable: configured && t.usable, ...(t.reason ? { reason: t.reason } : {}) }; })(),
    },
    engineRoster,
    integrations: {
      googleWork: gAccounts.some((a) => a.account === "work"),
      twilio: Boolean(twilioConfig()),
      places: placesConfigured(),
      weather,
      ...(placesConfigured() ? {} : { googleKeyCandidates: googleKeyCandidateNames() }),
      drive,
      sync,
      friday,
      os,
      stirlingPdf,
      whisper,
      wispr: await wisprHealth(),
    },
    vault: { root: cfg.vaultRoot, sizeMb: Number((size.bytes / 1024 / 1024).toFixed(2)), fileCount: size.files },
    sensitivity: { testCases: tested, ok },
  };
}

async function osHealth(): Promise<HealthReport["integrations"]["os"]> {
  const { osClient, osEnabled } = await import("./osClient");
  if (!osEnabled()) return { enabled: false, ok: false, detail: "OS sign-in not completed (/api/os/auth)" };
  const t0 = Date.now();
  try {
    await Promise.race([
      osClient.callTool("contacts_list", { limit: 1 }),
      new Promise((_, rej) => setTimeout(() => rej(new Error("timeout 4s")), 4000)),
    ]);
    return { enabled: true, ok: true, ms: Date.now() - t0 };
  } catch (e) {
    return { enabled: true, ok: false, ms: Date.now() - t0, detail: String(e).slice(0, 160) };
  }
}

async function wisprHealth(): Promise<HealthReport["integrations"]["wispr"]> {
  try {
    const { wisprStatus } = await import("./meetings/wispr");
    const { meetingIngestMode } = await import("./meetings/ingest");
    const s = await wisprStatus();
    return { configured: s.configured, connected: s.connected, mode: meetingIngestMode(), lastPollAt: s.lastPollAt, lastOk: s.lastOk, lastError: s.lastError };
  } catch (e) {
    return { configured: false, connected: false, mode: "unknown", lastError: String((e as Error).message ?? e).slice(0, 160) };
  }
}
