import { redirect } from "next/navigation";

// Superseded by the Office's /brief-full — same underlying /api/brief/morning. Kept as a
// redirect so an old bookmark still lands somewhere useful.
export default function BriefPage() {
  const base = (process.env.OFFICE_PUBLIC_URL ?? "https://office.example.com").replace(/\/$/, "");
  redirect(`${base}/brief-full`);
}
