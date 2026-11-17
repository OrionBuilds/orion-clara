// Clara — one-shot boot: ensure vault subdirs, config file, data dir all exist.
// Called at every server startup and at the top of each API route.

import { promises as fs } from "node:fs";
import path from "node:path";
import { loadConfig } from "./config";
import { OWNER_FIRST } from "./owner";

const VAULT_SUBDIRS = [
  "briefs",
  "tasks",
  "contacts",
  "transcripts",
  "ledger",
  "followups",
  "sensitive",
  "vendors",
  "preferences",
];

let done = false;

export async function ensureBootstrapped(): Promise<void> {
  if (done) return;
  const cfg = await loadConfig();
  await fs.mkdir(cfg.vaultRoot, { recursive: true });
  await fs.mkdir(cfg.dataDir, { recursive: true });
  await Promise.all(VAULT_SUBDIRS.map((d) => fs.mkdir(path.join(cfg.vaultRoot, d), { recursive: true })));

  // Vault README once — so opening the vault in Obsidian isn't a blank canvas.
  const readmePath = path.join(cfg.vaultRoot, "README.md");
  try { await fs.access(readmePath); }
  catch {
    await fs.writeFile(readmePath, README, "utf8");
  }
  done = true;
}

const README = `# Clara — vault

This vault is Clara's memory of ${OWNER_FIRST}'s work. She writes here; you can read (and edit) here.

## Structure

- **briefs/** — daily morning / evening briefs, Sunday weekly reviews.
- **tasks/** — one markdown file per open/closed task. \`_index.json\` is the machine index.
- **contacts/** — profiles for the owner, VIP clients, business partners, colleagues.
- **vendors/** — office services, contractors, IT, printers — with history and ratings.
- **preferences/** — coffee order, seat/hotel prefs, allergies, communication style.
- **followups/** — open waiting-on-them queue.
- **ledger/** — every charge, booking, sent email, call. Append-only JSONL.
- **transcripts/** — call recordings + transcripts, one folder per day.
- **sensitive/** — anything Clara must reason about with a LOCAL model only.

Edit any markdown here freely. Clara re-reads on next boot / next scan.
`;
