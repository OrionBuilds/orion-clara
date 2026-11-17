// Clara — travel research skill.
//
// Clara has no purchase power: she researches and builds a plausible itinerary, then emails the
// options to whoever asked (+ a short SMS heads-up) — she never books or pays for anything.
//
// Real flight/hotel APIs (Amadeus, Duffel, Booking.com) can plug in later for sharper estimates;
// without keys, the LLM builds a plausible itinerary shell for the owner to act on themselves.

import { deliverToPrincipal } from "./deliver";
import { append as ledgerAppend } from "./ledger";
import type { PrincipalId } from "./types";
import { CLARA_IDENTITY } from "./persona";
import { classify } from "./sensitivity";
import { researchTopic } from "./research";
import { lmStudioBaseUrl, lmStudioChatModel } from "./lmstudio";
import { recordLMStudioCall } from "./usage";
import { OWNER_FIRST } from "./owner";

export interface TravelRequest {
  requestor: PrincipalId;
  destination: string;         // "Austin, TX"
  origin?: string;             // "DTW" — default: pulled from prefs later
  depart: string;              // ISO or natural — "next Tuesday"
  nights: number;
  purpose?: string;            // "board meeting"
  preferences?: string;        // freeform — "aisle seat, no red-eyes, Marriott if possible"
}

export interface Itinerary {
  outbound: { carrier: string; flightNo?: string; from: string; to: string; depart: string; arrive: string; price: number; note?: string };
  return:   { carrier: string; flightNo?: string; from: string; to: string; depart: string; arrive: string; price: number; note?: string };
  hotel:    { name: string; address?: string; checkIn: string; checkOut: string; ratePerNight: number; nights: number; note?: string };
  ground?:  { type: "rental" | "rideshare" | "shuttle"; provider?: string; est: number };
  totalEst: number;
  notes: string;
}

async function llmResearch(req: TravelRequest): Promise<Itinerary> {
  const prompt = `Build a plausible itinerary for this trip. Return JSON matching this shape exactly:
{
  "outbound": { "carrier": "", "flightNo": "", "from": "", "to": "", "depart": "ISO", "arrive": "ISO", "price": number, "note": "" },
  "return":   { "carrier": "", "flightNo": "", "from": "", "to": "", "depart": "ISO", "arrive": "ISO", "price": number, "note": "" },
  "hotel":    { "name": "", "address": "", "checkIn": "YYYY-MM-DD", "checkOut": "YYYY-MM-DD", "ratePerNight": number, "nights": number, "note": "" },
  "ground":   { "type": "rideshare", "provider": "Uber", "est": number },
  "totalEst": number,
  "notes": ""
}

Request:
Destination: ${req.destination}
Origin: ${req.origin ?? `TBD (${OWNER_FIRST}'s home airport)`}
Depart: ${req.depart}
Nights: ${req.nights}
Purpose: ${req.purpose ?? "unstated"}
Preferences: ${req.preferences ?? "none stated"}

Rules:
- These are ESTIMATES to draft — mark clearly in notes that the owner should verify before booking.
- Use realistic prices for the route/dates given.
- Add relevant notes (weather, event proximity, notable choice tradeoffs).
- Return ONLY the JSON, no prose.`;

  // Sensitivity gate — checked BEFORE any engine is tried. Trip purpose/preferences are
  // free-text and can carry medical/legal/privileged context (e.g. "attorney-client mediation
  // prep"); if flagged sensitive, the cloud fallback below must never run, regardless of
  // whether LM Studio happens to be reachable.
  const hint = classify({ text: `${req.purpose ?? ""} ${req.preferences ?? ""}` });

  try {
    const base = await lmStudioBaseUrl();
    const model = await lmStudioChatModel();
    const r = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [{ role: "system", content: CLARA_IDENTITY }, { role: "user", content: prompt }],
        temperature: 0.2,
        response_format: { type: "json_object" },
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (r.ok) {
      const j = await r.json() as { choices: { message: { content: string } }[] };
      void recordLMStudioCall(j, { purpose: "travel" });
      const raw = j.choices?.[0]?.message?.content ?? "{}";
      const parsed = JSON.parse(extractJson(raw)) as Itinerary;
      return parsed;
    }
  } catch { /* fall to Anthropic below, unless sensitive */ }

  if (hint.sensitive) {
    throw new Error("This trip request looks sensitive and LM Studio (local-only) isn't reachable — start LM Studio and retry. Refusing to send it to a cloud model.");
  }

  // OS model setting (agentSettings.ts) → its fallback → this site's built-in model.
  const { callModelText } = await import("./modelCall");
  const out = await callModelText({ site: "travel", purpose: "travel", defaultModel: "claude-opus-4-8", system: CLARA_IDENTITY, prompt, maxTokens: 1200, json: true });
  if (out) return JSON.parse(extractJson(out.text || "{}")) as Itinerary;
  throw new Error("No LLM available for travel research");
}

function extractJson(s: string): string {
  const m = s.match(/\{[\s\S]*\}/);
  return m ? m[0] : "{}";
}

// Entry point — the owner asks for a trip, Clara researches and emails the options. No
// booking, no approval queue — there's nothing for Clara to execute here, so the itinerary just
// needs to land in front of whoever asked.
export async function planTrip(req: TravelRequest): Promise<{ delivered: boolean; itinerary: Itinerary }> {
  const it = await llmResearch(req);

  // Validate LLM-produced dollar amounts before they go out in an email — a malformed or
  // adversarial model response could otherwise put NaN/negative/absurd numbers in front of the owner.
  for (const [label, price] of [["outbound", it.outbound?.price], ["return", it.return?.price], ["hotel rate", it.hotel?.ratePerNight], ["total", it.totalEst]] as const) {
    if (!Number.isFinite(price) || (price as number) < 0) {
      throw new Error(`Itinerary research returned an invalid ${label} amount (${price}) — try again`);
    }
  }
  if (it.totalEst > 100_000) {
    throw new Error(`Itinerary total ($${it.totalEst}) is implausibly high — refusing to send; try again or narrow the request`);
  }

  const summary = [
    `**Outbound**: ${it.outbound.carrier} ${it.outbound.flightNo ?? ""} ${it.outbound.from}→${it.outbound.to}, ${it.outbound.depart} — $${it.outbound.price}`,
    `**Return**:   ${it.return.carrier} ${it.return.flightNo ?? ""} ${it.return.from}→${it.return.to}, ${it.return.depart} — $${it.return.price}`,
    `**Hotel**:    ${it.hotel.name} — ${it.hotel.checkIn}→${it.hotel.checkOut}, ${it.hotel.nights} nights × $${it.hotel.ratePerNight}`,
    it.ground ? `**Ground**:  ${it.ground.type}${it.ground.provider ? ` (${it.ground.provider})` : ""} — ~$${it.ground.est}` : "",
    ``,
    `**Total est: $${it.totalEst}**`,
    ``,
    it.notes ? `_${it.notes}_` : "",
    ``,
    `Clara can't book this herself — she has no purchase authority. Book directly, or ask her to call a specific hotel/vendor to confirm availability.`,
  ].filter(Boolean).join("\n");

  const { ok } = await deliverToPrincipal(
    req.requestor,
    `Travel options — ${req.destination}`,
    summary,
    `Clara here — I put together travel options for ${req.destination} (${req.nights} nights). Check your email for the full write-up.`,
  );
  await ledgerAppend({
    kind: "action",
    actor: "clara",
    what: `researched travel options for ${req.destination}, delivered to ${req.requestor}`,
    meta: { destination: req.destination, totalEst: it.totalEst, delivered: ok },
  }).catch(() => {});

  return { delivered: ok, itinerary: it };
}

// Deeper, multi-source research option alongside the single-prompt llmResearch()
// above — the owner supplies the links/docs they want synthesized (a neighborhood guide, an event page,
// a hotel listing) instead of Clara guessing at plausible details.
// (the owner's own one-time Google sign-in) — see research.ts.
export interface DeepResearchRequest {
  destination: string;
  sources: string[]; // URLs or file paths to synthesize
  question?: string;
  requestor?: PrincipalId;
}
export interface DeepResearchResult { ok: boolean; notebookId?: string; findings?: string; error?: string }

export async function deepResearchDestination(req: DeepResearchRequest): Promise<DeepResearchResult> {
  if (!req.sources.length) return { ok: false, error: "at least one source URL/file is required" };
  const question = req.question ?? `Summarize what ${OWNER_FIRST} should know before this trip to ${req.destination}: safety, logistics, weather, and anything notable happening during the visit. Be concrete and cite the sources.`;
  const res = await researchTopic({ title: `Travel research — ${req.destination}`, sources: req.sources, question, requestor: req.requestor });
  if (!res.ok) return { ok: false, error: res.error };
  return { ok: true, findings: res.answer };
}
