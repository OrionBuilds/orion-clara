"use client";
// Shared markdown renderer — react-markdown/remark-gfm/rehype-highlight have been in package.json
// since the start with zero imports anywhere in the app. First real consumer: the /vault editor's
// preview pane; also used by the /calls transcript viewer (B5) and chat citation hovers later.
//
// Frontmatter is pre-split via the existing parseMd() (frontmatter.ts) and rendered as a small
// key/value chip table above the body — never fed into react-markdown, which has no YAML-ish
// frontmatter concept and would otherwise render it as a literal "---" horizontal rule + garbage.
//
// Wikilinks ([[Note]], [[Note|Alias]], [[Note#heading]]) are pre-transformed into normal markdown
// links pointing at /vault?path=... before the markdown parse — MB4 fills in real resolution via
// resolveWikilink; unresolved links render as dead-link spans.

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import Link from "next/link";
import { parseMd } from "@/lib/clara/frontmatter";

const WIKILINK_RX = /\[\[([^\]|#\n]+)(?:#[^\]|\n]*)?(?:\|([^\]\n]*))?\]\]/g;

export interface WikilinkResolver {
  /** Returns the resolved vault relPath for a wikilink target, or null if unresolved. */
  resolve: (target: string) => string | null;
}

function transformWikilinks(md: string, resolver?: WikilinkResolver): string {
  return md.replace(WIKILINK_RX, (_m, target: string, alias?: string) => {
    const label = (alias || target).trim();
    const resolved = resolver?.resolve(target.trim());
    if (resolved) return `[${label}](/vault?path=${encodeURIComponent(resolved)})`;
    // Unresolved — still a link (creates-on-click is a fair Obsidian-like affordance later), but
    // visually distinct so a dead reference doesn't read as a working navigation link.
    return `[${label}](#unresolved-wikilink "${target.trim()} not found")`;
  });
}

export default function MarkdownView({ raw, resolver }: { raw: string; resolver?: WikilinkResolver }) {
  const { fm, body } = parseMd(raw);
  const fmEntries = Object.entries(fm);
  const transformed = transformWikilinks(body, resolver);

  return (
    <div>
      {fmEntries.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-4 pb-3 border-b" style={{ borderColor: "var(--line-soft)" }}>
          {fmEntries.map(([k, v]) => (
            <span key={k} className="pill text-[11px]" title={k}>
              <span style={{ color: "var(--cream-mute)" }}>{k}:</span> {v}
            </span>
          ))}
        </div>
      )}
      <div className="markdown-body text-sm leading-relaxed" style={{ color: "var(--cream)" }}>
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[rehypeHighlight]}
          components={{
            a: ({ href, children, ...props }) => {
              if (href?.startsWith("/vault?path=")) {
                return <Link href={href}>{children}</Link>;
              }
              if (href === "#unresolved-wikilink") {
                return <span style={{ color: "var(--cream-mute)", textDecoration: "underline dotted", cursor: "default" }} {...props}>{children}</span>;
              }
              return <a href={href} target="_blank" rel="noopener noreferrer" style={{ color: "var(--gold)" }} {...props}>{children}</a>;
            },
          }}
        >
          {transformed}
        </ReactMarkdown>
      </div>
    </div>
  );
}
