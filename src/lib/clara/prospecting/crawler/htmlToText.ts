// crawler/htmlToText.ts — turn a fetched page's raw HTML into plain text for the classifier and
// (PR 8's) extractor, without a new HTML-parser dependency — a regex/state-machine pass is this
// codebase's existing style (see entity/normalize.ts) and is tractable at this scope.
//
// Keeps: heading text, prefixed by level ("# ", "## ", …) so the document's structure survives
// flattening; and every anchor's href + visible text — including `mailto:`/`tel:` links — both
// inline (where the link's visible text already sat in the flow) and in a "Links:" footer, so a
// caller that only looks at `.text` never loses a contact method that happened to sit behind
// icon-only anchor text. Script/style/noscript content is dropped entirely rather than flattened.

export interface ExtractedLink {
  href: string;
  text: string;
}

export interface HtmlToTextResult {
  text: string;
  links: ExtractedLink[];
}

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", ndash: "–",
  rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", hellip: "…", copy: "©",
};

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec: string) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&(\w+);/g, (m: string, name: string) => ENTITIES[name] ?? m);
}

function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]+>/g, " "))
    .replace(/[ \t]+/g, " ")
    .trim();
}

const BLOCK_CLOSE_RE = /<\/(p|div|li|tr|section|article|header|footer|nav|ul|ol|table|h[1-6])>/gi;

/** Strips tags from `html`, keeping heading structure and every anchor's href+text recoverable. */
export function htmlToText(html: string): HtmlToTextResult {
  if (!html || !html.trim()) return { text: "", links: [] };

  // Drop non-content blocks entirely — their text is noise, not content.
  let s = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|head)\b[^>]*>[\s\S]*?<\/\1>/gi, " ");

  // Collect every anchor's href + visible text BEFORE stripping tags, including mailto:/tel: —
  // whatever anchors are already in the markup, none are lost even if their visible text is empty
  // (icon-only links still keep the href via the footer below).
  const links: ExtractedLink[] = [];
  const seenLinks = new Set<string>();
  s = s.replace(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, inner: string) => {
    const text = stripTags(inner);
    const key = `${href}|${text}`;
    if (!seenLinks.has(key)) {
      seenLinks.add(key);
      links.push({ href: href.trim(), text });
    }
    return ` ${text} `;
  });

  // Headings: pull their (already anchor-flattened) inner text out onto its own line, prefixed by
  // level so "# About Us" / "## Our Team" survive as recognizable structure.
  s = s.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, level: string, inner: string) => {
    const prefix = "#".repeat(Number(level));
    return `\n\n${prefix} ${stripTags(inner)}\n\n`;
  });

  // Remaining block-level boundaries become line breaks so paragraphs/list items/rows don't run
  // together into one unreadable line.
  s = s.replace(BLOCK_CLOSE_RE, "\n");
  s = s.replace(/<br\s*\/?>/gi, "\n");

  s = stripTags(s);
  s = s.replace(/\n{3,}/g, "\n\n").replace(/[ \t]{2,}/g, " ").trim();

  if (links.length) {
    const footer = links.map((l) => (l.text ? `${l.text}: ${l.href}` : l.href)).join("\n");
    s = s ? `${s}\n\nLinks:\n${footer}` : `Links:\n${footer}`;
  }

  return { text: s, links };
}
