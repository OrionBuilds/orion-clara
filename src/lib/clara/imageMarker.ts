// How an owner chat turn with images is persisted: its text plus "[N images attached]" (the image
// data itself is never stored). The chat route strips it again when matching persisted history
// against the live request, so the current turn is never fed back to the router as history.

export function withImageMarker(text: string, count: number): string {
  if (!count) return text;
  return `${text}${text ? " " : ""}[${count} image${count === 1 ? "" : "s"} attached]`;
}

export function stripImageMarker(text: string): string {
  return text.replace(/\s*\[\d+ images? attached\]$/, "");
}
