// The OS MCP client answers with MCP `content` blocks; the useful payload is JSON inside the first
// text block. Shared by every CLARA module that reads the OS (triage, portal, watcher).
export function unwrap(content: unknown): unknown {
  if (Array.isArray(content)) {
    const first = content.find((c) => c && typeof c === "object" && "text" in (c as object));
    if (first && typeof (first as { text?: unknown }).text === "string") {
      try { return JSON.parse((first as { text: string }).text); } catch { return (first as { text: string }).text; }
    }
  }
  return content;
}

/** Rows out of an unwrapped tool result that may be an array or `{ data: [...] }`/`{ rows: [...] }`. */
export function rowsOf<T = Record<string, unknown>>(v: unknown): T[] {
  if (Array.isArray(v)) return v as T[];
  if (v && typeof v === "object") {
    const o = v as { data?: unknown; rows?: unknown; items?: unknown };
    for (const k of [o.data, o.rows, o.items]) if (Array.isArray(k)) return k as T[];
  }
  return [];
}
