// Clara — LM Studio base URL + model resolution, single source of truth.
//
// Ten-plus call sites across this codebase used to each independently hardcode a base URL and
// send the literal model string "local" — which happened to "work" only because LM Studio
// doesn't validate the model field and silently routes to whatever's loaded when there's no
// ambiguity (confirmed by testing). That's fragile: it breaks the moment two chat models are
// loaded at once, and gave no way to verify which model was actually in play. This module
// resolves the real, currently-loaded model via LM Studio's extended /api/v0/models endpoint
// (which reports a `state: "loaded"` per model, unlike the standard /v1/models — that one just
// lists everything ever downloaded regardless of load state).

import { loadConfig } from "./config";

export async function lmStudioBaseUrl(): Promise<string> {
  const cfg = await loadConfig();
  const base = cfg.lmStudioBaseUrl.replace(/\/+$/, "");
  // Guard against a custom CLARA_LMSTUDIO_URL set without the /v1 suffix — every call site
  // appends OpenAI-style paths (/chat/completions, /embeddings, /models) expecting it to already
  // be there, so a missing suffix would otherwise silently 404 every single request at once.
  return /\/v1$/.test(base) ? base : `${base}/v1`;
}

interface LoadedModel { id: string; type: string }

const loadedCache: { at: number; data: LoadedModel[] } = { at: 0, data: [] };
const LOADED_CACHE_MS = 60_000;

async function lmStudioLoadedModels(): Promise<LoadedModel[]> {
  const now = Date.now();
  if (now - loadedCache.at < LOADED_CACHE_MS) return loadedCache.data;
  try {
    const base = await lmStudioBaseUrl();
    const root = base.replace(/\/v1$/, "");
    const r = await fetch(`${root}/api/v0/models`, { signal: AbortSignal.timeout(4000) });
    if (!r.ok) return loadedCache.data;
    const j = await r.json() as { data?: { id: string; type: string; state: string }[] };
    const loaded = (j.data ?? []).filter((m) => m.state === "loaded").map((m) => ({ id: m.id, type: m.type }));
    loadedCache.at = now;
    loadedCache.data = loaded;
    return loaded;
  } catch {
    return loadedCache.data;
  }
}

export async function lmStudioChatModel(): Promise<string> {
  const cfg = await loadConfig();
  if (cfg.lmStudioModel) return cfg.lmStudioModel;
  const loaded = await lmStudioLoadedModels();
  const chat = loaded.find((m) => m.type !== "embeddings");
  if (chat) return chat.id;
  throw new Error("No LM Studio chat model resolved — set CLARA_LMSTUDIO_MODEL or load a model in LM Studio.");
}

export async function lmStudioEmbedModel(): Promise<string> {
  const cfg = await loadConfig();
  if (cfg.lmStudioEmbedModel) return cfg.lmStudioEmbedModel;
  const loaded = await lmStudioLoadedModels();
  const embed = loaded.find((m) => m.type === "embeddings");
  if (embed) return embed.id;
  // Last-resort default matches what's been hardcoded here historically — preserves existing
  // behavior if LM Studio happens to be unreachable at the moment this is called.
  return "text-embedding-nomic-embed-text-v1.5";
}
