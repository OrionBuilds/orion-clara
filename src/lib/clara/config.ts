// Clara — machine-local config. Mirrors FRIDAY's ~/.agentic-os pattern.
import { promises as fs } from "node:fs";
import { existsSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { OWNER_DRIVES } from "./owner";

const CONFIG_DIR = path.join(os.homedir(), ".agentic-os");
const CONFIG_FILE = process.env.CLARA_CONFIG ?? path.join(CONFIG_DIR, "clara.config.json");

if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });

export interface ClaraConfig {
  vaultRoot: string;
  dataDir: string;
  fridayBaseUrl: string;
  /** Client domains CLARA no longer acts for (CLARA_IGNORED_CLIENT_DOMAINS, comma list) — mail, tickets and meetings from them are left alone. */
  ignoredClientDomains: string[];
  /**
   * The CLARA Google Shared Drive id — her own file library, the same arrangement FRIDAY has via
   * FRIDAY_DRIVE_ID. Reached through the work Google account's membership of that shared drive,
   * which is why her Gmail/Calendar OAuth deliberately stays on the owner's account: the drive is
   * shared, the mailbox is not.
   *
   * Find it in the URL when the shared drive is open:
   *   https://drive.google.com/drive/u/0/folders/<THIS>
   */
  claraDriveId: string;
  twilio: {
    accountSid: string;
    authToken: string;
    number: string;
    webhookBase: string;
  };
  elevenlabs: {
    apiKey: string;
    voiceId: string;
    tone: { owner: string; vendor: string };
  };
  principals: {
    owner: { phones: string[]; emails: string[] };
  };
  whitelist: string[];         // E.164 VIP-client numbers that never get screened
  // Optional home/office location, used to bias Google Places business lookups (places.ts) toward
  // nearby results. Unset → Places queries fall back to requiring a city/ZIP in the request text.
  homeLat: number | null;
  homeLng: number | null;
  // LM Studio — local OpenAI-compatible server, Clara's enforced local-only brain for anything
  // routed through sensitivity.ts. lmStudioModel/lmStudioEmbedModel are optional pins; unset,
  // lmstudio.ts auto-detects whichever chat/embedding model LM Studio actually has loaded right
  // now (via its extended /api/v0/models endpoint) rather than guessing from a name pattern.
  lmStudioBaseUrl: string;
  lmStudioModel: string | null;
  lmStudioEmbedModel: string | null;
  quietHours: string; // "START-END" 24h local, e.g. "22-7" — wraps midnight
  // Local call transcription (B5). LM Studio has no audio-transcription endpoint, so this is a
  // separate CLI pipeline: whisper.cpp (whisper-cli.exe) + a ggml model file, with ffmpeg doing the
  // 8kHz (Twilio) -> 16kHz mono resample whisper.cpp requires. Neither binary ships with Clara —
  // both are a one-time manual install; /system's health row surfaces whether they're findable.
  whisperBin: string;
  whisperModel: string;
  ffmpegBin: string;
}

const DEFAULTS: ClaraConfig = {
  // Clara's Obsidian vault folder. CLARA_VAULT_ROOT overrides; otherwise ~/clara-vault/CLARA.
  vaultRoot: process.env.CLARA_VAULT_ROOT?.trim() || path.join(os.homedir(), "clara-vault", "CLARA"),
  dataDir: path.join(os.homedir(), ".agentic-os", "clara"),
  fridayBaseUrl: process.env.FRIDAY_BASE_URL ?? "http://127.0.0.1:3737",
  ignoredClientDomains: (process.env.CLARA_IGNORED_CLIENT_DOMAINS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
  // Same arrangement as FRIDAY_DRIVE_ID: env override first, then the owner profile's drive id
  // (git-ignored — the real id never lives in source). The id is verified rather than guessed:
  // health.ts probes it at startup and fails loudly if it ever stops resolving, which answers the
  // earlier objection that a wrong-but-present id writes real files somewhere unintended.
  claraDriveId: (process.env.CLARA_DRIVE_ID ?? "").trim() || (OWNER_DRIVES.claraDriveId ?? ""),
  twilio: {
    accountSid: process.env.CLARA_TWILIO_ACCOUNT_SID ?? "",
    authToken: process.env.CLARA_TWILIO_AUTH_TOKEN ?? "",
    number: process.env.CLARA_TWILIO_NUMBER ?? "",
    webhookBase: process.env.CLARA_PUBLIC_WEBHOOK_BASE ?? "",
  },
  elevenlabs: {
    apiKey: process.env.ELEVENLABS_API_KEY ?? "",
    voiceId: process.env.CLARA_ELEVENLABS_VOICE_ID ?? "",
    tone: {
      owner:   "warm-familiar",
      vendor: "crisp-professional",
    },
  },
  principals: {
    owner: {
      phones: [process.env.OWNER_PHONE ?? ""].filter(Boolean),
      emails: [process.env.OWNER_EMAIL_WORK ?? ""].filter(Boolean),
    },
  },
  whitelist: (process.env.WHITELIST_NUMBERS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  homeLat: process.env.CLARA_HOME_LAT ? Number(process.env.CLARA_HOME_LAT) : null,
  homeLng: process.env.CLARA_HOME_LNG ? Number(process.env.CLARA_HOME_LNG) : null,
  // LMSTUDIO_BASE_URL is the unprefixed name commonly set in .env.local (e.g. LM Studio on another
  // machine on the LAN) - without it in this chain, CLARA silently fell through to the localhost
  // default and every LM Studio call (embeddings included) failed.
  lmStudioBaseUrl: (process.env.CLARA_LMSTUDIO_URL ?? process.env.LMSTUDIO_BASE_URL ?? process.env.AGENTIC_OS_LMSTUDIO_URL ?? "http://localhost:1234/v1").replace(/\/+$/, ""),
  lmStudioModel: process.env.CLARA_LMSTUDIO_MODEL ?? process.env.AGENTIC_OS_LMSTUDIO_MODEL ?? null,
  lmStudioEmbedModel: process.env.CLARA_LMSTUDIO_EMBED_MODEL ?? process.env.CLARA_EMBED_MODEL ?? null,
  quietHours: process.env.CLARA_QUIET_HOURS ?? "22-7",
  whisperBin: process.env.CLARA_WHISPER_BIN ?? "",
  whisperModel: process.env.CLARA_WHISPER_MODEL ?? "",
  ffmpegBin: process.env.CLARA_FFMPEG_BIN ?? "ffmpeg",
};

let cached: ClaraConfig | null = null;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// Recursive merge — a shallow `{...DEFAULTS, ...onDisk}` spread silently drops sibling default
// keys whenever the on-disk file has a PARTIAL nested object (e.g. {"spend":{"perTxnUsd":250}}
// would previously wipe out perDayUsd entirely, making the daily cap check evaluate against
// `undefined` — which is always false in JS, silently disabling the cap). Arrays are replaced
// wholesale (merging arrays element-wise isn't meaningful for whitelist/number lists).
export function deepMerge<T>(base: T, override: Partial<T>): T {
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return (override === undefined ? base : override) as T;
  }
  const out: Record<string, unknown> = { ...base };
  for (const key of Object.keys(override)) {
    const b = (base as Record<string, unknown>)[key];
    const o = override[key as keyof T];
    out[key] = isPlainObject(b) && isPlainObject(o) ? deepMerge(b, o as Record<string, unknown>) : o;
  }
  return out as T;
}

// Fields that must NEVER be persisted to the on-disk config file, and must always be sourced
// from env at read time regardless of what an old copy on disk might contain — closes the
// "live API keys get a second plaintext copy on disk" finding. This file lives outside the
// vault and outside whatever protection the .env file has, so it must not become a durable
// second home for live credentials.
function redactSecrets(cfg: ClaraConfig): ClaraConfig {
  return {
    ...cfg,
    twilio: { ...cfg.twilio, authToken: "" },
    elevenlabs: { ...cfg.elevenlabs, apiKey: "" },
  };
}

export async function loadConfig(): Promise<ClaraConfig> {
  if (cached) return cached;
  let onDisk: Partial<ClaraConfig> = {};
  try {
    onDisk = JSON.parse(await fs.readFile(CONFIG_FILE, "utf8"));
  } catch {
    // First run — write defaults so the operator has something to edit, minus live secrets.
    await fs.writeFile(CONFIG_FILE, JSON.stringify(redactSecrets(DEFAULTS), null, 2), "utf8");
  }
  const merged = deepMerge(DEFAULTS, onDisk);
  // Regardless of what the merge produced (including a stale plaintext copy from before this
  // fix existed), the live secret values always come from env, never from disk.
  cached = {
    ...merged,
    twilio: { ...merged.twilio, authToken: DEFAULTS.twilio.authToken },
    elevenlabs: { ...merged.elevenlabs, apiKey: DEFAULTS.elevenlabs.apiKey },
  };
  return cached;
}

export function configPath(): string {
  return CONFIG_FILE;
}
