// Clara — the YAML-ish frontmatter format her vault markdown uses.
//
// Both the task and contact stores write `---\nkey: value\n---\n\n# Heading\n\nbody`. Until now
// nothing ever read it back: the stores loaded their JSON index and treated the markdown as
// write-only output, which meant an edit made in Obsidian was invisible to Clara and got silently
// overwritten on her next write. This parser closes that loop, making the vault a real editing
// surface and the source of truth, with the JSON index demoted to a rebuildable cache.
//
// Deliberately not a full YAML parser — the format is ours, it's flat, and pulling in a YAML
// dependency to read `key: value` lines would be the wrong trade.

export interface ParsedMd {
  fm: Record<string, string>;
  heading?: string;
  body: string;
}

export function parseMd(raw: string): ParsedMd {
  const text = raw.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  const fm: Record<string, string> = {};
  let rest = text;

  if (text.startsWith("---\n")) {
    const end = text.indexOf("\n---", 3);
    if (end !== -1) {
      const block = text.slice(4, end);
      rest = text.slice(end + 4).replace(/^\n+/, "");
      for (const line of block.split("\n")) {
        const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
        if (m) fm[m[1]] = m[2].trim();
      }
    }
  }

  let heading: string | undefined;
  const hm = rest.match(/^#\s+(.+?)\s*$/m);
  if (hm) {
    heading = hm[1];
    rest = rest.slice(hm.index! + hm[0].length).replace(/^\n+/, "");
  }

  return { fm, heading, body: rest.trimEnd() };
}

// `tags: [a, b, c]` → ["a","b","c"]. Also tolerates a bare comma list from a hand edit.
export function parseList(v: string | undefined): string[] | undefined {
  if (!v) return undefined;
  const inner = v.trim().replace(/^\[/, "").replace(/\]$/, "");
  const parts = inner.split(",").map((s) => s.trim()).filter(Boolean);
  return parts.length ? parts : undefined;
}

export function parseBool(v: string | undefined, fallback = false): boolean {
  if (v == null) return fallback;
  return /^(true|yes|1)$/i.test(v.trim());
}
