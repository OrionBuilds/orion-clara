import { NextRequest, NextResponse } from "next/server";
import { ensureBootstrapped } from "@/lib/clara/bootstrap";
import { researchTopic } from "@/lib/clara/research";
import { deepResearchDestination } from "@/lib/clara/travel";
import { principalFromHeaders } from "@/lib/clara/session";

export const runtime = "nodejs";
// A full run is create + one call per source + ask. Several minutes is normal, not a hang.
export const maxDuration = 600;

interface Body {
  title?: string;
  sources?: string[];
  question?: string;
  /** When set, routes through travel.ts's destination-shaped prompt instead of a raw question. */
  destination?: string;
}

export async function POST(req: NextRequest) {
  await ensureBootstrapped();
  const principal = principalFromHeaders(req.headers);
  if (!principal) return NextResponse.json({ error: "not authenticated" }, { status: 401 });

  const body = await req.json() as Body;
  const sources = (body.sources ?? []).map((s) => s.trim()).filter(Boolean);
  // Checked before anything spawns — an empty run would otherwise create an empty notebook in
  // The owner's account and then fail at the ask step.
  if (!sources.length) return NextResponse.json({ error: "at least one source URL or file path is required" }, { status: 400 });

  try {
    if (body.destination?.trim()) {
      const res = await deepResearchDestination({
        destination: body.destination.trim(),
        sources,
        question: body.question?.trim() || undefined,
        requestor: principal,
      });
      return NextResponse.json(res);
    }

    if (!body.title?.trim()) return NextResponse.json({ error: "title is required" }, { status: 400 });
    if (!body.question?.trim()) return NextResponse.json({ error: "question is required" }, { status: 400 });

    const res = await researchTopic({
      title: body.title.trim(),
      sources,
      question: body.question.trim(),
      // Always the verified session principal, never a body value — same rule as the travel route.
      requestor: principal,
    });
    return NextResponse.json(res);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
