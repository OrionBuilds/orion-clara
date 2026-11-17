// B3 — manually triggered (the owner-only) import of orion's clara_memories into Clara's own vault.
// Not on any schedule: memory volume there is low and this is meant to be re-run occasionally, not
// polled. See src/lib/clara/osMemoryImport.ts for the actual migration.

import { NextRequest, NextResponse } from "next/server";
import { ensureBootstrapped } from "@/lib/clara/bootstrap";
import { principalFromHeaders } from "@/lib/clara/session";
import { importOsMemories } from "@/lib/clara/osMemoryImport";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST(req: NextRequest) {
  await ensureBootstrapped();
  if (principalFromHeaders(req.headers) !== "owner") {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }
  const result = await importOsMemories();
  return NextResponse.json(result, { status: result.ok ? 200 : 400 });
}
