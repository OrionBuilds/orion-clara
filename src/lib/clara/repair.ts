// Clara — remote repair by text. "restart friday" from a phone, with a real before/after report.
//
// She runs on the same workstation as the other two agents and the MCP server, so she can do what
// you would do at the keyboard: kill the process and let its supervisor bring it back. That is not
// a new mechanism — it is exactly what the existing watchdogs do when a service stops answering
// (a process supervisor force-recycles the same way), and it is proven in this environment.
//
// ── The boundary ──────────────────────────────────────────────────────────────────────────────
// Restart and report. Nothing else. No logging in as the owner, no spending, nothing client-facing, no
// deletes, no config edits. The target is chosen from a fixed table below and never interpolated
// from message text, so there is no path from an SMS to an arbitrary command — which matters more
// here than anywhere else in Clara, because this is the one module that runs OS-level commands and
// she reads untrusted inbound text for a living.
//
// ── Why kill-and-let-the-supervisor-relaunch ──────────────────────────────────────────────────
// Stop-ScheduledTask/Start-ScheduledTask looks tidier but does not reliably take the child node
// process with it, which would leave the port held and the "restart" silently doing nothing. The
// supervisors already own relaunch and poll every few seconds; killing the listener is the honest
// signal to them.

import { promises as fs } from "node:fs";
import path from "node:path";
import { loadConfig } from "./config";
import { append as ledgerAppend } from "./ledger";

export type RepairTarget = "friday" | "clara" | "mcp";

interface ServiceSpec {
  label: string;
  port: number;
  /** Path that returns 200 when the service is actually serving, not merely listening. */
  healthPath: string;
}

// Ports are the identity here. Matching on a command-line substring is what made an earlier
// restart in this codebase hit the wrong agent — "clara" appears in the install path of every process
// launched from that directory — so the listening socket is the only unambiguous handle.
const SERVICES: Record<RepairTarget, ServiceSpec> = {
  friday: { label: "FRIDAY", port: 3737, healthPath: "/api/health" },
  clara: { label: "CLARA", port: 3939, healthPath: "/api/system/health" },
  mcp: { label: "the OS MCP server", port: 3100, healthPath: "/health" },
};

/** How long to wait for a supervisor to bring a service back before calling it a failed restart. */
const RELAUNCH_TIMEOUT_MS = 90_000;

export interface RestartCommand {
  target: RepairTarget;
}

/**
 * Recognize "restart friday" / "restart the mcp" / "reboot clara".
 *
 * Anchored and enumerated: the verb must start the message and the target must be one of four
 * known names. "restart" with no target returns null rather than guessing, because guessing which
 * service to bounce is not a recoverable mistake — you would be told something restarted while the
 * thing you meant stayed down.
 */
export function parseRestartCommand(text: string): RestartCommand | null {
  const t = text.trim().toLowerCase().replace(/[.!?]+$/, "");
  const m = /^(?:restart|reboot|recycle|bounce)\s+(?:the\s+)?(friday|clara|mcp|yourself|you)$/.exec(t);
  if (!m) return null;
  const raw = m[1];
  const target = raw === "yourself" || raw === "you" ? "clara" : (raw as RepairTarget);
  return { target };
}

// ── Process control ───────────────────────────────────────────────────────────────────────────

/**
 * Run a short PowerShell snippet and return stdout. Only ever called with the literal scripts
 * below — `port` is a number from the SERVICES table, never message text.
 */
async function ps(script: string, timeoutMs = 30_000): Promise<string> {
  const { execFile } = await import("node:child_process");
  return new Promise<string>((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 },
      (_err, stdout) => resolve(String(stdout ?? "").trim()),
    );
  });
}

async function listenerPid(port: number): Promise<number | null> {
  const out = await ps(
    `(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess`,
    15_000,
  );
  const pid = Number.parseInt(out, 10);
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

async function healthy(spec: ServiceSpec): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${spec.port}${spec.healthPath}`, { signal: AbortSignal.timeout(6000) });
    return r.ok;
  } catch {
    return false;
  }
}

export interface RestartResult {
  ok: boolean;
  message: string;
}

/**
 * Restart another service and report what actually happened: old pid, new pid, and whether it is
 * serving again. Reporting the pid change is the point — "restarted" on its own is a claim, while
 * "41464 -> 19100, health 200" is evidence, and the failure this guards against is a kill that
 * nothing relaunched.
 */
export async function restartService(target: Exclude<RepairTarget, "clara">): Promise<RestartResult> {
  const spec = SERVICES[target];
  const oldPid = await listenerPid(spec.port);

  if (oldPid === null) {
    // Nothing is listening. It may already be down and mid-relaunch, so wait rather than kill
    // something that does not exist — and say which of the two it turned out to be.
    const back = await waitForHealth(spec);
    return back
      ? { ok: true, message: `${spec.label} wasn't listening but came back on its own — healthy now on :${spec.port}.` }
      : { ok: false, message: `${spec.label} isn't listening on :${spec.port} and didn't come back. Its supervisor may be down too — that needs the machine.` };
  }

  await ps(`Stop-Process -Id ${oldPid} -Force -ErrorAction SilentlyContinue`, 15_000);
  await ledgerAppend({
    kind: "action", actor: "clara",
    what: `restarted ${spec.label} by request (killed pid ${oldPid}, waiting for supervisor)`,
    meta: { target, oldPid: String(oldPid) },
  }).catch(() => {});

  const back = await waitForHealth(spec);
  const newPid = await listenerPid(spec.port);

  if (!back) {
    return {
      ok: false,
      message: `Killed ${spec.label} (pid ${oldPid}) but it hasn't come back after ${Math.round(RELAUNCH_TIMEOUT_MS / 1000)}s. Its supervisor isn't relaunching it — ${spec.label} is DOWN and needs the machine.`,
    };
  }
  return {
    ok: true,
    message: `${spec.label} restarted — pid ${oldPid} → ${newPid ?? "?"}, health check passing on :${spec.port}.`,
  };
}

async function waitForHealth(spec: ServiceSpec): Promise<boolean> {
  const deadline = Date.now() + RELAUNCH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    if (await healthy(spec)) return true;
  }
  return false;
}

/**
 * Restarting Clara herself is a different shape: she is the process being killed, so she cannot
 * report the outcome afterwards. The reply has to go out first, and the caller must have already
 * sent it before this runs.
 *
 * A breadcrumb is written to the data directory before the kill so the restart is not invisible if
 * it fails — otherwise a self-restart that never comes back leaves no trace anywhere that it was
 * even attempted.
 */
export async function restartSelf(): Promise<void> {
  const cfg = await loadConfig();
  const spec = SERVICES.clara;
  const pid = await listenerPid(spec.port);
  await fs
    .writeFile(
      path.join(cfg.dataDir, "self-restart.json"),
      JSON.stringify({ requestedAt: new Date().toISOString(), pid }, null, 2),
      "utf8",
    )
    .catch(() => {});
  await ledgerAppend({
    kind: "action", actor: "clara",
    what: `self-restart requested by SMS (pid ${pid ?? "unknown"})`,
    meta: { target: "clara", pid: String(pid ?? "") },
  }).catch(() => {});

  // Detached and delayed: the kill must not race the outbound SMS still being handed to Twilio.
  if (pid !== null) {
    void ps(`Start-Sleep -Seconds 5; Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue`, 30_000);
  }
}

export function serviceLabel(t: RepairTarget): string {
  return SERVICES[t].label;
}
