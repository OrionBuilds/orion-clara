// Display-safe owner identity for CLIENT components (Sidebar, TopBar, greetings). Server code
// imports @/lib/clara/owner directly; client bundles cannot (it reads the filesystem), so this
// route exposes exactly the two display fields and nothing else — no emails, no phone, no drives.

import { NextResponse } from "next/server";
import { OWNER_NAME, OWNER_FIRST } from "@/lib/clara/owner";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json({ name: OWNER_NAME, firstName: OWNER_FIRST });
}
