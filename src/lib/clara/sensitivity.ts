// Clara — sensitivity gate.
//
// Any prompt/action tagged sensitive routes to a LOCAL LLM only (LM Studio / Ollama).
// Hard-fails if a caller tries to send sensitive content to a cloud engine.

import type { EngineHint } from "./types";

// Vault tags & filename patterns that mark content as sensitive.
const SENSITIVE_PATTERNS = [
  /\/sensitive\//i,
  /\bmedical\b|\blab.results\b|\bdiagnos/i,
  /\bssn\b|\bein\b|\btax id\b/i,
  /\baccount\s*#|\brouting\s*#/i,
  /\bprivileged\b|\battorney.client\b|\blegal\shold\b/i,
  /\binvestor.update\b|\bcap.table\b|\bboard.deck\b/i,
];

export function classify(input: { path?: string; text?: string; explicit?: boolean }): EngineHint {
  if (input.explicit) return { intent: "sensitive", sensitive: true };
  const hay = `${input.path ?? ""}\n${input.text ?? ""}`;
  const sensitive = SENSITIVE_PATTERNS.some((rx) => rx.test(hay));
  return { intent: sensitive ? "sensitive" : "reasoning", sensitive };
}

export type Engine = "claude" | "codex" | "hermes" | "antigravity" | "lmstudio" | "ollama";
const LOCAL_ENGINES: Engine[] = ["lmstudio", "ollama"];

export function assertLocalIfSensitive(hint: EngineHint, chosen: Engine): void {
  if (hint.sensitive && !LOCAL_ENGINES.includes(chosen)) {
    throw new Error(
      `sensitivity gate: refused to route sensitive content to '${chosen}'. Allowed: ${LOCAL_ENGINES.join(", ")}`
    );
  }
}

// Force-route helper: given a hint, pick a safe engine.
export function pickEngine(hint: EngineHint, preferred: Engine): Engine {
  if (hint.sensitive) return LOCAL_ENGINES.includes(preferred) ? preferred : "lmstudio";
  return preferred;
}
