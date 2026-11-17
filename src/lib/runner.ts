// Clara — CLI subprocess runner. Binary resolution is Clara-specific (auto-detects via `which`
// + known install-location guesses, resolved once at module load — cheap, no auth probe;
// engines.ts's engineHealthDeep() does the real auth check). Env sanitization/PATH-repair/spawn
// choreography live in the shared runner module (@autom8ionlab/agent-core), which this file
// itself was ported from before the extraction.

import { execSync } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import {
  runProcess, spawnProcess, safeArg, validateFlagArgs, HOME_DIR,
  type RunResult, type AgentEnvOptions,
} from "@autom8ionlab/agent-core";

export { safeArg, validateFlagArgs };
export type { RunResult };

const IS_WIN = process.platform === "win32";

export type AgentName = "claude" | "codex" | "antigravity" | "hermes";

function which(cmd: string): string | null {
  try {
    const probe = IS_WIN ? `where ${cmd}` : `command -v ${cmd}`;
    const out = execSync(probe, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    const lines = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (IS_WIN) {
      // `where` often returns multiple matches for an npm-installed CLI — both an extensionless
      // POSIX shell shim (for WSL/git-bash) and a .cmd wrapper (for cmd.exe/PowerShell). Node's
      // spawn() can't execute the extensionless shim directly on Windows without a shell, so it
      // silently fails even though the same command works fine when typed into a real shell
      // (whose own PATHEXT resolution picks the .cmd automatically). Prefer a real Windows
      // executable extension when one exists among the matches.
      const winExec = lines.find((l) => /\.(cmd|exe|bat)$/i.test(l));
      return winExec ?? lines[0] ?? null;
    }
    return lines[0] ?? null;
  } catch { return null; }
}

// Antigravity CLI (`agy`) installs under %LOCALAPPDATA%\agy\bin, usually off the Next server's PATH.
function antigravityGuess(): string | null {
  const guesses = [
    path.join(process.env.LOCALAPPDATA ?? path.join(HOME_DIR, "AppData", "Local"), "agy", "bin", "agy.exe"),
    path.join(HOME_DIR, ".local", "bin", "agy"),
  ];
  for (const g of guesses) if (existsSync(g)) return g;
  return null;
}

export const ENGINE_BIN: Record<AgentName, string | null> = {
  claude: process.env.CLARA_CLAUDE_BIN?.trim() || which("claude"),
  codex: process.env.CLARA_CODEX_BIN?.trim() || which("codex"),
  antigravity: process.env.CLARA_ANTIGRAVITY_BIN?.trim() || which("agy") || antigravityGuess(),
  hermes: process.env.CLARA_HERMES_BIN?.trim() || which("hermes"),
};

function binFor(agent: AgentName): string {
  const bin = ENGINE_BIN[agent];
  if (!bin) throw new Error(`${agent} is not installed or not configured. Set CLARA_${agent.toUpperCase()}_BIN or install the CLI.`);
  return bin;
}

// ANTHROPIC_API_KEY is a FALLBACK-ONLY credential for Clara's direct-Anthropic-HTTP call sites
// (business-call-brain, documents, consolidate, gifts, legal-tax, telephony, travel, the Twilio SMS
// route). It must NOT leak into the spawned `claude` CLI: the CLI treats any inherited key as its
// auth source and, if it's invalid or scoped wrong, refuses instead of falling back to `claude
// login` subscription auth. Same bug a sibling agent already hit and fixed for itself (src/lib/runner.ts) —
// Clara never got the equivalent fix, which would silently break every OS-enabled CLI run too.
// 2026-08-20: claude-code-router (CCR), an unrelated tool installed on this machine, sets
// ANTHROPIC_MODEL (and these sibling vars) in the ambient environment for its own proxy routing —
// a value the real `claude` CLI would reject if it ever fell back to reading it. FRIDAY hit this
// live; CLARA has no confirmed call site that omits --model today, but strip it defensively
// alongside the ANTHROPIC_API_KEY fix below, same reasoning.
const ENV_OPTIONS: AgentEnvOptions = {
  extraPathDirs: [path.join(process.env.LOCALAPPDATA ?? path.join(HOME_DIR, "AppData", "Local"), "agy", "bin")],
  extraHostDenylist: ["ANTHROPIC_API_KEY", "ANTHROPIC_MODEL", "ANTHROPIC_API_BASE_URL", "CCR_CLAUDE_CODE_MODEL", "CODEXL_CLAUDE_CODE_MODEL"],
  keepHostEnvFlag: "CLARA_KEEP_HOST_ENV",
};

// 2026-08-20: stripping env vars alone isn't enough to keep a spawned `claude` call away from
// claude-code-router (CCR) — CCR's apiKeyHelper + ANTHROPIC_BASE_URL/API_BASE_URL/MODEL overrides
// live in the owner's global ~/.claude/settings.json, which the CLI reads for itself at startup
// regardless of the parent process's env. Confirmed live on FRIDAY: it failed every claude
// dispatch for hours with "connectors are disabled ... takes precedence over your claude.ai
// login" even after the env-var fix. The owner wants CCR kept for their own interactive use, so instead
// of touching that file, every CLARA-spawned `claude` call skips the "user" settings scope via
// --setting-sources — their own sessions (which never pass this flag) are unaffected.
function withSettingSources(agent: AgentName, args: readonly string[]): readonly string[] {
  return agent === "claude" ? ["--setting-sources", "project,local", ...args] : args;
}

export async function run(
  agent: AgentName,
  args: readonly string[],
  opts: { timeoutMs?: number; cwd?: string; input?: string; extraEnv?: Record<string, string>; onChunk?: (text: string) => void } = {},
): Promise<RunResult> {
  let bin: string;
  try { bin = binFor(agent); }
  catch (e) { return { ok: false, code: -1, stdout: "", stderr: String(e), durationMs: 0 }; }
  return runProcess(bin, withSettingSources(agent, args), { ...opts, envOptions: ENV_OPTIONS });
}

export function spawnStream(
  agent: AgentName,
  args: readonly string[],
  opts: { cwd?: string; input?: string; extraEnv?: Record<string, string> } = {},
): ChildProcessWithoutNullStreams {
  const bin = binFor(agent);
  return spawnProcess(bin, withSettingSources(agent, args), { ...opts, envOptions: ENV_OPTIONS });
}
