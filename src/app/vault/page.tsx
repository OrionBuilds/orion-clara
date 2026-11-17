"use client";
// Vault — browse and edit the Obsidian-shared vault in-app. Source-mode editing (CodeMirror, not
// Tiptap) deliberately: the vault is a real Obsidian vault on disk, and an HTML-model editor would
// rewrite files in ways that don't round-trip cleanly through Obsidian's own markdown parser.
//
// Everything here goes through /api/vault/* -> lib/clara/vault.ts's safeResolve() — no path is
// ever trusted client-side.

import { useEffect, useState, useCallback, Suspense, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import CodeMirror from "@uiw/react-codemirror";
import { markdown } from "@codemirror/lang-markdown";
import { EditorView } from "@codemirror/view";
import { autocompletion, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { FileText, Folder, FolderOpen, Eye, Pencil, Save, RefreshCw, Link2 } from "lucide-react";
import MarkdownView, { type WikilinkResolver } from "@/components/MarkdownView";

interface EntityCandidate { label: string; relPath: string; kind: "note" | "contact" }
interface LinkOccurrence { raw: string; resolved: string | null; context: string; line: number }
interface Backlink { from: string; context: string; line: number }

// Triggers on "[[partial" (query = text after "[[") or "@partial" (query = text after "@", the "@"
// itself gets consumed on apply). Both insert a real [[Target]] wikilink — the "@" trigger is just
// a faster way to reach the same syntax, matching the plan's "@name inserts [[Resolved Name]]".
function wikilinkCompletionSource(context: CompletionContext): CompletionResult | Promise<CompletionResult | null> | null {
  const wiki = context.matchBefore(/\[\[([^\]\n]*)$/);
  const at = !wiki ? context.matchBefore(/@([\w.\- ]*)$/) : null;
  const match = wiki ?? at;
  if (!match) return null;
  if (!wiki && !context.explicit && match.text === "@") return null; // bare "@" — wait for a char

  const isAt = !!at;
  const query = isAt ? match.text.slice(1) : match.text.slice(2);
  const queryStart = match.from + (isAt ? 1 : 2);

  return fetch(`/api/vault/entities?q=${encodeURIComponent(query)}`)
    .then((r) => r.json())
    .then((j): CompletionResult => ({
      from: queryStart,
      options: ((j.candidates ?? []) as EntityCandidate[]).map((c) => ({
        label: c.label,
        detail: c.kind,
        // "[[" case: the opening brackets are already on the page — just replace the typed query
        // with "Label]]". "@" case: nothing is bracketed yet — consume the "@" too and insert the
        // full "[[Label]]".
        apply: (view, _completion, from, to) => {
          const insert = isAt ? `[[${c.label}]]` : `${c.label}]]`;
          const start = from - (isAt ? 1 : 0);
          view.dispatch({ changes: { from: start, to, insert }, selection: { anchor: start + insert.length } });
        },
      })),
    }))
    .catch(() => null);
}
const wikilinkAutocomplete = autocompletion({ override: [wikilinkCompletionSource] });

interface TreeNode {
  name: string;
  relPath: string;
  type: "dir" | "file";
  ext?: string;
  children?: TreeNode[];
}

const cmTheme = EditorView.theme({
  "&": { fontSize: "13px", backgroundColor: "transparent" },
  ".cm-content": { color: "var(--cream)", fontFamily: "var(--font-mono, ui-monospace, monospace)" },
  ".cm-gutters": { backgroundColor: "transparent", color: "var(--cream-mute)", border: "none" },
  "&.cm-focused": { outline: "none" },
}, { dark: true });

function TreeView({ nodes, selected, onSelect, depth = 0 }: { nodes: TreeNode[]; selected: string | null; onSelect: (relPath: string) => void; depth?: number }) {
  return (
    <>
      {nodes.map((n) => (
        <TreeItem key={n.relPath} node={n} selected={selected} onSelect={onSelect} depth={depth} />
      ))}
    </>
  );
}

function TreeItem({ node, selected, onSelect, depth }: { node: TreeNode; selected: string | null; onSelect: (relPath: string) => void; depth: number }) {
  const [open, setOpen] = useState(depth < 1);
  if (node.type === "dir") {
    return (
      <div>
        <button
          onClick={() => setOpen((o) => !o)}
          className="w-full flex items-center gap-1.5 py-1 px-2 rounded text-left text-[13px] hover:bg-[rgba(255,255,255,0.04)]"
          style={{ paddingLeft: 8 + depth * 14, color: "var(--cream-dim)" }}
        >
          {open ? <FolderOpen size={13} /> : <Folder size={13} />}
          <span className="truncate">{node.name}</span>
        </button>
        {open && node.children && <TreeView nodes={node.children} selected={selected} onSelect={onSelect} depth={depth + 1} />}
      </div>
    );
  }
  const isMd = node.ext === ".md";
  const active = selected === node.relPath;
  return (
    <button
      onClick={() => isMd && onSelect(node.relPath)}
      disabled={!isMd}
      className="w-full flex items-center gap-1.5 py-1 px-2 rounded text-left text-[13px] truncate"
      style={{
        paddingLeft: 8 + depth * 14,
        color: active ? "var(--gold)" : isMd ? "var(--cream)" : "var(--cream-mute)",
        background: active ? "rgba(8,145,178,0.1)" : "transparent",
        opacity: isMd ? 1 : 0.5,
        cursor: isMd ? "pointer" : "default",
      }}
      title={isMd ? node.relPath : `${node.relPath} (not editable here)`}
    >
      <FileText size={13} className="shrink-0" />
      <span className="truncate">{node.name}</span>
    </button>
  );
}

function VaultPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const pathParam = searchParams.get("path");

  const [tree, setTree] = useState<TreeNode[] | null>(null);
  const [selected, setSelected] = useState<string | null>(pathParam);
  const [content, setContent] = useState("");
  const [mtimeMs, setMtimeMs] = useState<number | null>(null);
  const [dirty, setDirty] = useState(false);
  const [mode, setMode] = useState<"edit" | "preview">("preview");
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [loading, setLoading] = useState(false);
  const [backlinks, setBacklinks] = useState<Backlink[]>([]);
  const [forwardLinks, setForwardLinks] = useState<LinkOccurrence[]>([]);
  const contentRef = useRef(content);
  contentRef.current = content;

  const loadTree = useCallback(async () => {
    const r = await fetch("/api/vault/tree");
    const j = await r.json();
    setTree(j.tree ?? []);
  }, []);
  useEffect(() => { loadTree(); }, [loadTree]);

  const loadLinks = useCallback(async (relPath: string) => {
    try {
      const j = await fetch(`/api/vault/links?path=${encodeURIComponent(relPath)}`).then((r) => r.json());
      setBacklinks(j.backlinks ?? []);
      setForwardLinks(j.forward ?? []);
    } catch { setBacklinks([]); setForwardLinks([]); }
  }, []);

  const openFile = useCallback(async (relPath: string, opts: { skipDirtyCheck?: boolean } = {}) => {
    if (!opts.skipDirtyCheck && dirty && !confirm("Discard unsaved changes?")) return;
    setLoading(true);
    setConflict(false);
    try {
      const r = await fetch(`/api/vault/file?path=${encodeURIComponent(relPath)}`);
      if (!r.ok) { alert("Couldn't open that file."); setLoading(false); return; }
      const j = await r.json();
      setSelected(relPath);
      setContent(j.content);
      setMtimeMs(j.mtimeMs);
      setDirty(false);
      setMode("preview");
      router.replace(`/vault?path=${encodeURIComponent(relPath)}`, { scroll: false });
      void loadLinks(relPath);
    } finally { setLoading(false); }
  }, [dirty, router, loadLinks]);

  useEffect(() => {
    if (pathParam && pathParam !== selected) openFile(pathParam, { skipDirtyCheck: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathParam]);

  const save = useCallback(async () => {
    if (!selected) return;
    setSaving(true);
    setConflict(false);
    try {
      const r = await fetch("/api/vault/file", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: selected, content: contentRef.current, expectedMtime: mtimeMs }),
      });
      if (r.status === 409) { setConflict(true); return; }
      if (!r.ok) { alert("Save failed."); return; }
      const j = await r.json();
      setMtimeMs(j.mtimeMs);
      setDirty(false);
      void loadLinks(selected); // the save just updated the incremental link index
    } finally { setSaving(false); }
  }, [selected, mtimeMs, loadLinks]);

  // Ctrl/Cmd+S saves; warn on tab-close with unsaved changes.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "s" && mode === "edit") { e.preventDefault(); save(); }
    }
    function onBeforeUnload(e: BeforeUnloadEvent) {
      if (dirty) { e.preventDefault(); e.returnValue = ""; }
    }
    window.addEventListener("keydown", onKey);
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("beforeunload", onBeforeUnload);
    };
  }, [mode, save, dirty]);

  // Resolver for MarkdownView's wikilink pre-transform, built from THIS file's own already-
  // resolved forward links (computed at index time) rather than a live per-link lookup.
  const resolver: WikilinkResolver = {
    resolve: (target: string) => {
      const hit = forwardLinks.find((l) => l.raw.toLowerCase() === target.toLowerCase());
      return hit?.resolved ?? null;
    },
  };

  return (
    <div className="flex gap-5 h-[calc(100vh-11rem)]">
      <aside className="w-64 shrink-0 panel p-2 overflow-y-auto">
        {tree === null ? (
          <p className="text-[12px] p-2" style={{ color: "var(--cream-mute)" }}>Loading…</p>
        ) : (
          <TreeView nodes={tree} selected={selected} onSelect={openFile} />
        )}
      </aside>

      <section className="flex-1 min-w-0 flex flex-col panel p-4">
        {!selected ? (
          <p className="m-auto text-[13px]" style={{ color: "var(--cream-mute)" }}>Select a note from the tree.</p>
        ) : (
          <>
            <div className="flex items-center gap-2 pb-3 mb-3 border-b" style={{ borderColor: "var(--line-soft)" }}>
              <span className="text-[13px] mono truncate flex-1" style={{ color: "var(--cream-dim)" }}>
                {selected}{dirty && <span style={{ color: "var(--rust)" }}> ·unsaved</span>}
              </span>
              <button onClick={() => setMode((m) => (m === "edit" ? "preview" : "edit"))}
                className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[12px]"
                style={{ background: "rgba(255,255,255,0.04)", color: "var(--cream-dim)" }}>
                {mode === "edit" ? <><Eye size={13} /> Preview</> : <><Pencil size={13} /> Edit</>}
              </button>
              {mode === "edit" && (
                <button onClick={save} disabled={saving || !dirty}
                  className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[12px]"
                  style={{ background: "var(--gold)", color: "white", opacity: saving || !dirty ? 0.5 : 1 }}>
                  <Save size={13} /> {saving ? "Saving…" : "Save"}
                </button>
              )}
            </div>

            {conflict && (
              <div className="mb-3 p-3 rounded-lg text-[12px] flex items-center justify-between gap-3"
                   style={{ background: "rgba(245,158,11,0.08)", border: "1px solid rgba(245,158,11,0.2)", color: "var(--rust)" }}>
                <span>This file changed on disk since you opened it — your edit was NOT saved.</span>
                <button onClick={() => openFile(selected, { skipDirtyCheck: true })} className="flex items-center gap-1 shrink-0" style={{ color: "var(--rust)" }}>
                  <RefreshCw size={12} /> Reload
                </button>
              </div>
            )}

            <div className="flex-1 min-h-0 overflow-y-auto">
              {loading ? (
                <p className="text-[13px]" style={{ color: "var(--cream-mute)" }}>Loading…</p>
              ) : mode === "preview" ? (
                <MarkdownView raw={content} resolver={resolver} />
              ) : (
                <CodeMirror
                  value={content}
                  height="100%"
                  theme={cmTheme}
                  extensions={[markdown(), wikilinkAutocomplete]}
                  onChange={(v) => { setContent(v); setDirty(true); }}
                  basicSetup={{ lineNumbers: false, foldGutter: false }}
                />
              )}
            </div>
          </>
        )}
      </section>

      <aside className="w-64 shrink-0 panel p-3 overflow-y-auto">
        <h2 className="flex items-center gap-1.5 text-[11px] uppercase tracking-[0.15em] mb-3" style={{ color: "var(--cream-dim)" }}>
          <Link2 size={12} /> Backlinks
        </h2>
        {!selected ? (
          <p className="text-[12px]" style={{ color: "var(--cream-mute)" }}>Open a note to see what links to it.</p>
        ) : backlinks.length === 0 ? (
          <p className="text-[12px]" style={{ color: "var(--cream-mute)" }}>Nothing links here yet.</p>
        ) : (
          <ul className="space-y-2">
            {backlinks.map((b, i) => (
              <li key={`${b.from}:${b.line}:${i}`}>
                <button onClick={() => openFile(b.from)} className="block w-full text-left rounded-lg p-2 hover:bg-[rgba(255,255,255,0.04)]">
                  <div className="text-[12px] mono truncate" style={{ color: "var(--gold)" }}>{b.from}</div>
                  <div className="text-[11px] leading-snug mt-0.5" style={{ color: "var(--cream-dim)" }}>…{b.context}…</div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </aside>
    </div>
  );
}

export default function VaultPage() {
  return (
    <Suspense fallback={<p style={{ color: "var(--cream-dim)" }}>Loading…</p>}>
      <VaultPageInner />
    </Suspense>
  );
}
