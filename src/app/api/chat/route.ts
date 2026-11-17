import { NextRequest, NextResponse } from "next/server";
import { verifyInteragentSecret, sanitizeImages, type ImageInput } from "@autom8ionlab/agent-core";
import { ensureBootstrapped } from "@/lib/clara/bootstrap";
import { classify, pickEngine, assertLocalIfSensitive } from "@/lib/clara/sensitivity";
import { completeWithMeta } from "@/lib/clara/engines";
import { appendMessage, recentMessages } from "@/lib/clara/messages";
import { osEnabled } from "@/lib/clara/osClient";
import { retrieveForChat } from "@/lib/clara/rag";
import { OWNER_FIRST } from "@/lib/clara/owner";
import { withImageMarker, stripImageMarker } from "@/lib/clara/imageMarker";
// inboxSweep's command helpers are gone from here — the intent router covers the sweep along with
// everything else. They remain exported for the SMS route's own layering and for direct callers.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 180;

// The chat page loads this on mount so a reload doesn't lose the conversation.
export async function GET(req: NextRequest) {
  await ensureBootstrapped();
  const limit = Math.min(Number(req.nextUrl.searchParams.get("limit") ?? 40), 200);
  return NextResponse.json({ messages: await recentMessages(limit) });
}

// Routes through the same engine roster (src/lib/clara/engines.ts) FRIDAY's own chat uses — Claude
// CLI as the default brain with LM Studio failover, same contract as FRIDAY's api/friday/chat.
// One reply payload, shared by both response modes below.
interface ChatReply {
  text: string;
  engine: string;
  calls?: { name: string; ok: boolean }[];
  citations?: unknown[];
  error?: string;
}

/**
 * The whole conversational brain, factored out of POST so the streaming mode (P2.7) and the plain
 * JSON mode run EXACTLY the same logic — router first, then sensitivity gate, then the engine.
 * `onToken` (streaming only) receives the router's provisional text deltas; the returned reply is
 * always the authoritative composed text.
 */
async function respond(
  messages: { role: string; content: string }[],
  onToken?: (text: string) => void,
  images: ImageInput[] = [],
): Promise<ChatReply> {
  const lastUser = messages[messages.length - 1];

  // Intent router — replaces the single isInboxSweepCommand keyword hook that used to sit here.
  //
  // That hook was one capability behind one regex; everything else the UI could do, it could only
  // TALK about. The router covers every tool and, more importantly, cannot claim work it didn't do
  // (see intent.ts). The chat page is the owner's own local surface, so the sender IS the principal.
  //
  // Everything runs inline here — unlike voice, a browser can wait, and the UI shows a spinner.
  // Cross-channel memory (ownerTurn.ts): what the owner said by SMS, on the phone or by email in the
  // last day rides along on BOTH paths below — the router and the conversational fallback — so
  // "what word did I text you earlier" works from the desk whichever way the turn goes. The
  // browser transcript wins on ordering; stored turns it already contains are dropped (by text,
  // ignoring the "[channel hh:mm]" prefix the stored form carries). Recalled rows are already
  // sensitivity-gated by loadOwnerHistory; the fallback gate below re-checks the combined text.
  const { loadOwnerHistory } = await import("@/lib/clara/ownerTurn");
  // The persisted copy of THIS turn carries an image marker (POST below); strip it too, or the live
  // request would come back as a "historical" turn and the router would see it twice.
  const strip = (c: string) => stripImageMarker(c.replace(/^\[(?:web|sms|voice|email)(?: \d\d:\d\d)?\] /, "")).trim();
  const browserTexts = new Set(messages.map((m) => (typeof m.content === "string" ? m.content.trim() : "")));
  const recalled = (await loadOwnerHistory()).filter((t) => !browserTexts.has(strip(t.content)));

  if (lastUser?.role === "user" && (lastUser.content.trim() || images.length)) {
    // Answers to something Clara asked resolve before the router (decisionReply.ts): "yes to the
    // Acme report, hold the budget bump" is two decisions, not a conversation starter.
    const { tryHandleDecisionReply } = await import("@/lib/clara/decisionReply");
    const decided = await tryHandleDecisionReply(lastUser.content, { channel: "chat" }).catch(() => null);
    if (decided !== null) {
      return { text: decided, engine: "decision", calls: [{ name: "decide", ok: !/^(Approved|Held|Noted), but /.test(decided) }] };
    }
    const { runIntent } = await import("@/lib/clara/intent");
    // P2.7: the turns BEFORE the live one ride along as router context, so "move that one to
    // Friday" resolves against what was just discussed. The engine path below already got the full
    // transcript; the router was the only path still treating every message as turn one.
    const browserTurns = messages.slice(0, -1)
      .filter((m): m is { role: "user" | "assistant"; content: string } =>
        (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim().length > 0)
      .slice(-10);
    const { memorySeed, joinSeed, recordOwnerRequest } = await import("@/lib/clara/ownerTurn");
    const priorTurns = joinSeed(await memorySeed(lastUser.content), [...recalled, ...browserTurns].slice(-20));
    const outcome = await runIntent(lastUser.content, { principal: "owner", source: "chat", history: priorTurns, onToken, images });
    await recordOwnerRequest("chat", lastUser.content, outcome);

    // Images only reach the router (the engine fall-through below is text-only), so on an image
    // turn the router's answer stands.
    if (outcome.calls.length || outcome.failed || outcome.clarifying || images.length) {
      await appendMessage("clara", outcome.reply, undefined, { channel: "web", principal: true }, { tools: outcome.calls.map((c) => `${c.name}${c.ok ? "" : "!"}`) }).catch(() => {});
      return {
        text: outcome.reply,
        engine: outcome.failed ? "router-failed" : "router",
        // Surfaced so the UI can show what actually ran. A reply with an empty `calls` changed
        // nothing, however it reads.
        calls: outcome.calls.map((c) => ({ name: c.name, ok: c.ok })),
      };
    }
    // No tool, no question — ordinary conversation. Falls through to the engine below, which
    // carries memory-RAG and the sensitivity gate the router deliberately doesn't.
  }

  // Sensitivity gate — checked BEFORE any engine runs, on the whole conversation.
  const combinedText = [...recalled.map((t) => t.content), ...messages.map((m) => m.content)].join("\n");
  const hint = classify({ text: combinedText });
  const engine = pickEngine(hint, "claude");
  try {
    assertLocalIfSensitive(hint, engine);
  } catch {
    const text = "This looks like it touches something sensitive. I won't send that to a cloud model — start LM Studio and try again.";
    await appendMessage("clara", text).catch(() => {});
    return { text, engine: "blocked-sensitive" };
  }

  // engines.ts's CompleteOpts takes a single prompt (it drives CLI subprocesses / one-shot HTTP
  // completions, the same contract FRIDAY's engines.ts uses) — render the conversation as a
  // transcript block so multi-turn context survives the single-prompt boundary.
  const transcript = [
    ...recalled.map((t) => `${t.role === "user" ? OWNER_FIRST : "Clara"}: ${t.content}`),
    ...messages.map((m) => `${m.role === "user" ? OWNER_FIRST : "Clara"}: ${m.content}`),
  ].join("\n");

  // Memory-RAG: `engine` is always passed explicitly below, which bypasses completeWithMeta's own
  // claude->lmstudio failover chain — so `engine` IS the worst case this prompt can reach. Only
  // when it resolves local (the sensitive-conversation branch) is it safe to inject sensitive-
  // tagged vault hits; a non-sensitive conversation still goes to claude (cloud), so retrieval for
  // it must exclude sensitive hits even though the conversation itself wasn't flagged.
  const allowSensitive = engine === "lmstudio" || engine === "ollama";
  const rag = await retrieveForChat(lastUser?.content ?? combinedText, { allowSensitive }).catch(() => null);
  // Soul-prefixed identity (constitution + the owner's authored persona) — this is the principal's own
  // chat surface, so it always gets the soul; the business channel never routes through here.
  const { principalIdentityWithSoul } = await import("@/lib/clara/persona");
  const identity = await principalIdentityWithSoul();
  const system = rag ? `${identity}\n\n${rag.block}` : identity;

  try {
    // Pass `engine` explicitly — completeWithMeta() only skips its claude->lmstudio failover chain
    // for an EXPLICIT non-default pick, so this is what actually keeps sensitive content from ever
    // reaching the claude engine (even as a "try claude first, fall back" attempt).
    //
    // os:true (B2) gives a claude-engine turn access to the orion CRM via MCP, so the owner can ask
    // Clara to look up a contact, check a calendar, or draft a proposal note from chat. It's a
    // no-op on the lmstudio branch (osWiring only runs inside completeClaude). The CLI's
    // --allowedTools is the SAFE tier (CLARA_OS_CLI_TOOLS, see osClient.ts) — reads and reversible
    // writes only; anything the tier table would mark draft-then-approve (sends, deletes,
    // signatures) simply isn't in that list, so a chat turn can describe the action but can't fire
    // it unilaterally. write stays false — a chat reply should never edit Clara's own source files.
    const { text, served } = await completeWithMeta({ system, prompt: transcript, engine, timeoutMs: 60_000, os: osEnabled() });
    await appendMessage("clara", text, rag?.citations).catch(() => {});
    return { text, engine: served.engine, citations: rag?.citations ?? [] };
  } catch (e) {
    const text = `I'm not connected to an engine yet, ${OWNER_FIRST}. Make sure \`claude\` is logged in or LM Studio is running, then try again.`;
    await appendMessage("clara", text).catch(() => {});
    return { text, engine: "none", error: String(e).slice(0, 200) };
  }
}

export async function POST(req: NextRequest) {
  // Admission gate — same one FRIDAY's /api/friday/chat has had all along (this route never did,
  // an asymmetry the Phase-0 bus work closes). The owner's own traffic clears isAlreadyTrusted()
  // (loopback, or Cloudflare Access JWT via the tunnel) without needing the shared secret; the
  // secret is for sibling agents delegating over the bus. See agent-core interagent/index.ts for
  // the 2026-08-04 incident that shaped this exact check.
  if (!verifyInteragentSecret(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  await ensureBootstrapped();
  const body = await req.json() as { messages: { role: string; content: string }[]; images?: unknown };
  const { messages } = body;
  // Screenshots/photos for the live turn (Office desk upload): validated, capped, never thrown on.
  const images = sanitizeImages(body.images);
  // Nothing to answer: no text, and no image survived validation. Rejected here so an empty turn
  // never reaches the engine fall-through.
  const lastTurn = messages?.[messages.length - 1];
  if (lastTurn?.role === "user" && !String(lastTurn.content ?? "").trim() && !images.length) {
    return NextResponse.json({ error: "empty message" }, { status: 400 });
  }

  // Persist the user's turn immediately — before any engine call — so a mid-request reload (or a
  // crashed engine call) never silently drops what the owner actually typed.
  const lastUser = messages[messages.length - 1];
  // Tagged explicitly as the web channel of the owner thread so the cross-channel history can
  // label it (an untagged row still reads as web, for every pre-existing line).
  if (lastUser?.role === "user") {
    const stored = withImageMarker(lastUser.content, images.length);
    await appendMessage("user", stored, undefined, { channel: "web", principal: true }).catch(() => {});
  }

  // P2.7 streaming mode (?stream=1): NDJSON frames — {t:"typing"} immediately, {t:"token",text}
  // for the router's provisional deltas, one authoritative {t:"msg",...} (same payload the JSON
  // mode returns), {t:"done"}. Same protocol family as FRIDAY's /api/room. The engine fall-through
  // path emits no tokens (it's a buffered CLI/HTTP completion) — the client just holds "typing"
  // until the msg frame, so old and new paths share one client contract.
  if (req.nextUrl.searchParams.get("stream") === "1") {
    const enc = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const frame = (o: unknown) => { try { controller.enqueue(enc.encode(JSON.stringify(o) + "\n")); } catch { /* client went away */ } };
        frame({ t: "typing" });
        try {
          const out = await respond(messages, (text) => frame({ t: "token", text }), images);
          frame({ t: "msg", ...out });
        } catch (e) {
          frame({ t: "msg", text: "Something broke mid-reply — nothing was changed. Try again.", engine: "none", error: String(e).slice(0, 200) });
        }
        frame({ t: "done" });
        controller.close();
      },
    });
    return new Response(stream, {
      headers: { "content-type": "application/x-ndjson", "cache-control": "no-store", "x-accel-buffering": "no" },
    });
  }

  return NextResponse.json(await respond(messages, undefined, images));
}
