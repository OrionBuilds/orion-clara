import { NextRequest, NextResponse } from "next/server";
import { ensureBootstrapped } from "@/lib/clara/bootstrap";
import { reviewScannedContract } from "@/lib/clara/legal-tax";

export const runtime = "nodejs";

// Multipart upload: a scanned/photographed contract PDF, OCR'd locally (Stirling-PDF, 127.0.0.1)
// before the same sensitivity-gated review reviewContract() already does.
export async function POST(req: NextRequest) {
  await ensureBootstrapped();
  const form = await req.formData();
  const file = form.get("file");
  const context = String(form.get("context") ?? "");
  if (!(file instanceof File)) return NextResponse.json({ error: "file required" }, { status: 400 });
  const pdfBuf = Buffer.from(await file.arrayBuffer());
  try {
    const res = await reviewScannedContract({ pdfBuf, filename: file.name, context: context || undefined });
    return NextResponse.json(res);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
