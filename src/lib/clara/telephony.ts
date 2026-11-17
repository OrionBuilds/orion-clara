// Clara — telephony brain (LLM turn logic on top of Twilio conversations).
//
// Two conversation contexts:
//   inbound-to-clara   — someone calls Clara's Twilio number directly (vendor callback, scheduling).
//   screen-for-owner    — call came to the owner's line during focus mode; Clara answers on their behalf.

import { identityFor, CLARA_CRM_CUSTOMER_LENS } from "./persona";
import { companyKnowledgeBlockSync } from "./knowledge";
import { resolveByPhone } from "./principals";
import { classify as classifySensitive, pickEngine } from "./sensitivity";
import { detectPromptInjection } from "./injection";
import { notifyOwner } from "./notify";
import { append as ledgerAppend } from "./ledger";
import { lmStudioBaseUrl, lmStudioChatModel } from "./lmstudio";
import { recordLMStudioCall } from "./usage";
import { OWNER_NAME, OWNER_FIRST } from "./owner";

export type Conversation = "inbound-to-clara" | "screen-for-owner";

async function llmReply(system: string, transcript: string): Promise<string> {
  // Route: sensitive → local; else prefer LM Studio then Anthropic (chat/route.ts already picks).
  const hint = classifySensitive({ text: transcript });
  const preferred = pickEngine(hint, "lmstudio");

  const messages = [
    { role: "system" as const, content: system },
    { role: "user" as const, content: transcript },
  ];

  if (preferred === "lmstudio" || preferred === "ollama") {
    try {
      const base = await lmStudioBaseUrl();
      const model = await lmStudioChatModel();
      const r = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, messages, temperature: 0.4, max_tokens: 240 }),
        signal: AbortSignal.timeout(10_000),
      });
      if (r.ok) {
        const j = await r.json() as { choices: { message: { content: string } }[] };
        void recordLMStudioCall(j, { purpose: "telephony" });
        return (j.choices?.[0]?.message?.content ?? "").trim() || "Let me get back to you on that.";
      }
    } catch { /* fall through */ }
  }

  // OS model setting (agentSettings.ts) → its fallback → this site's built-in model.
  const { callModelText } = await import("./modelCall");
  const out = await callModelText({ site: "telephony", purpose: "telephony", defaultModel: "claude-opus-4-8", system, prompt: transcript, maxTokens: 240 });
  if (out) return out.text || "Let me get back to you on that.";

  return "I'll pass this along and someone will follow up.";
}

// The persona system prompt for spoken turns — short, warm, non-committal on things she
// doesn't have authority over.
export function systemFor(context: Conversation, callerLabel: string, isPrincipal: boolean): string {
  const lens = context === "screen-for-owner"
    ? `You are answering ${OWNER_NAME}'s phone because they are currently in focus mode / a meeting. You represent ${OWNER_FIRST}. Take a clear message, offer to schedule a callback, and don't commit ${OWNER_FIRST} to anything you can't confirm. Keep replies under 3 sentences.`
    : `You are on your own line — a vendor, contact, or scheduling caller has reached YOU. Handle what you can under Clara's usual authority. Keep replies under 3 sentences.`;
  // Anyone not a recognized principal (the owner) is a CRM contact/customer by default post-merge —
  // same lens applied to SMS (persona.ts), extended here since voice now shares the same live
  // customer-facing number.
  //
  // The identity itself now switches on the caller, not just the lens. This number is published on
  // example.com, so the default caller is a stranger, and the principal persona is not
  // something a stranger may hear — see the audience boundary note in persona.ts.
  const crmLens = isPrincipal ? "" : `\n\n${CLARA_CRM_CUSTOMER_LENS}${companyKnowledgeBlockSync()}`;
  return `${identityFor(isPrincipal ? "principal" : "business")}

${lens}

Speaking to: ${callerLabel}. This is a live phone call — no markdown, no bullet lists, natural speech only.${crmLens}`;
}

// Untrusted-caller content never becomes an instruction — see injection.ts and the
// "Speaking to" framing in systemFor() above, which already tells the model this is a caller's
// own words, not a directive aimed at it.
async function checkInjection(transcript: string, fromE164: string, context: Conversation): Promise<{ hardBlock: boolean }> {
  const verdict = detectPromptInjection(transcript);
  if (!verdict.triggered) return { hardBlock: false };

  await ledgerAppend({
    kind: "action",
    actor: "clara",
    what: `injection heuristic hit on ${context} from ${fromE164}: ${verdict.reasons.join(", ")}`,
    meta: { reasons: verdict.reasons, canaryLeak: verdict.canaryLeak, hardBlock: verdict.hardBlock },
  }).catch(() => {});
  await notifyOwner({
    kind: "injection.detected",
    priority: "critical",
    text: `Possible prompt injection on a call from ${fromE164} (${context}): ${verdict.reasons.join(", ")}.`,
    dedupeKey: `injection:${context}:${fromE164}:${new Date().toISOString().slice(0, 10)}`,
  }).catch(() => {});

  return { hardBlock: verdict.hardBlock };
}

export async function respond(
  context: Conversation,
  transcript: string,
  fromE164: string,
  history?: { role: "user" | "assistant"; content: string }[],
): Promise<string> {
  const { hardBlock } = await checkInjection(transcript, fromE164, context);
  if (hardBlock) return "I'll pass this along and someone will follow up.";

  const principal = await resolveByPhone(fromE164).catch(() => null);
  const label = principal ? principal.displayName : `unknown caller (${fromE164})`;
  // Prior turns (principals only — the caller passes the cross-channel owner thread) ride in the
  // system prompt the same way the SMS fallback carries its history block.
  const historyBlock = principal && history?.length
    ? `\n\nRecent conversation with ${label} (any channel, last 24h; "[sms 14:05]" marks where and when):\n${history.map((t) => `${t.role === "user" ? label : "Clara"}: ${t.content}`).join("\n")}`
    : "";
  return llmReply(`${systemFor(context, label, Boolean(principal))}${historyBlock}`, transcript);
}
