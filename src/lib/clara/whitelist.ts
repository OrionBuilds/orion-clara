// Clara — call-screening whitelist.
//
// effectiveWhitelist() is load-bearing for call/meeting screening and the system self-test drills.
// The optional whitelist.derived.json cache it reads is not written by anything in this repo —
// whatever is already in it keeps working; the configured whitelist is the main source.

import { promises as fs } from "node:fs";
import path from "node:path";
import { loadConfig } from "./config";

// VIP-client whitelist: config.whitelist (+ any frozen derived cache). Never-screened numbers.
export async function effectiveWhitelist(): Promise<string[]> {
  const cfg = await loadConfig();
  let derived: string[] = [];
  try {
    const p = path.join(cfg.dataDir, "whitelist.derived.json");
    const j = JSON.parse(await fs.readFile(p, "utf8")) as { all: string[] };
    derived = j.all ?? [];
  } catch { /* none yet */ }
  return [...new Set([
    ...cfg.whitelist,
    ...derived,
  ])].filter(Boolean);
}
