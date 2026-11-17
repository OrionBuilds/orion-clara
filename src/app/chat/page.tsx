import { redirect } from "next/navigation";

// Superseded by the Office's /desk/clara (same /api/web-chat thread, richer voice — wake word,
// War Room). Kept as a redirect rather than a 404 so an old bookmark or muscle-memory click still
// lands somewhere useful. The API this page used to call directly (/api/chat, /api/web-chat) is
// untouched — the Office reads it too, over loopback.
export default function ChatPage() {
  const base = (process.env.OFFICE_PUBLIC_URL ?? "https://office.example.com").replace(/\/$/, "");
  redirect(`${base}/desk/clara`);
}
