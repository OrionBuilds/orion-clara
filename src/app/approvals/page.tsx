import { redirect } from "next/navigation";

// Superseded by the Office's /approvals — actually a superset (merges CLARA + FRIDAY
// into one queue). Kept as a redirect so an old bookmark still lands somewhere useful. The
// underlying /api/approvals[/[id]] routes are untouched — the Office reads/writes them over
// loopback.
export default function ApprovalsPage() {
  const base = (process.env.OFFICE_PUBLIC_URL ?? "https://office.example.com").replace(/\/$/, "");
  redirect(`${base}/approvals`);
}
