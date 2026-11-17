// PUT /api/prospects/sequences/[id]/steps — replace the whole ordered step list
// (sequence_steps_set: positions must be 1..n, no gaps — the OS tool itself enforces this and
// rejects anything else before touching the table). Body: { steps: SequenceStep[] }.
import { NextRequest, NextResponse } from "next/server";
import { requireInteragent, callOrUnavailable } from "@/lib/clara/prospecting/httpAuth";
import { sequenceStepsSet, type SequenceStep } from "@/lib/clara/prospecting/osBridge";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isValidStep(s: unknown): s is SequenceStep {
  if (!s || typeof s !== "object") return false;
  const o = s as Record<string, unknown>;
  return (
    typeof o.position === "number" &&
    typeof o.channel === "string" &&
    ["email", "sms", "call", "task"].includes(o.channel) &&
    !!o.template &&
    typeof (o.template as Record<string, unknown>).body === "string"
  );
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = requireInteragent(req);
  if (denied) return denied;
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as { steps?: unknown };
  if (!Array.isArray(body.steps) || !body.steps.length) {
    return NextResponse.json({ ok: false, error: "steps (non-empty array) is required" }, { status: 400 });
  }
  if (!body.steps.every(isValidStep)) {
    return NextResponse.json({ ok: false, error: "every step needs a numeric position, a valid channel (email|sms|call|task), and a template.body" }, { status: 400 });
  }
  const result = await callOrUnavailable(() => sequenceStepsSet(id, body.steps as SequenceStep[]));
  if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: result.status });
  return NextResponse.json({ ok: true, steps: result.data.steps });
}
