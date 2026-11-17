import { NextResponse } from "next/server";
import { twilioConfig } from "@/lib/clara/channels";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Phone (Twilio) status + webhook wiring. Port of FRIDAY's api/friday/phone/route.ts — inbound
// SMS/calls only reach Clara if the number's webhooks point at a PUBLIC url (the Cloudflare
// tunnel) that reaches this localhost server.
function mask(n?: string | null): string | null {
  return n ? n.replace(/.(?=.{4})/g, "•") : null;
}

async function lookupNumber(sid: string, from: string, auth: string): Promise<{ numSid?: string; voiceUrl?: string; smsUrl?: string; error?: string }> {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${sid}/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(from)}`;
  const r = await fetch(url, { headers: { Authorization: `Basic ${auth}` } });
  if (!r.ok) return { error: `Twilio ${r.status}: ${(await r.text().catch(() => "")).slice(0, 160)}` };
  const j = await r.json().catch(() => ({}));
  const rec = (j.incoming_phone_numbers ?? [])[0];
  if (!rec) return { error: `Number ${from} isn't on this Twilio account` };
  return { numSid: rec.sid, voiceUrl: rec.voice_url, smsUrl: rec.sms_url };
}

// GET → is Twilio configured, is the owner's number set, and where do the webhooks currently point?
export async function GET() {
  const cfg = twilioConfig();
  if (!cfg) return NextResponse.json({ configured: false });
  const auth = Buffer.from(`${cfg.sid}:${cfg.token}`).toString("base64");
  const num = await lookupNumber(cfg.sid, cfg.from, auth);
  const pathWired = Boolean(num.smsUrl?.includes("/api/channels/twilio/sms") && num.voiceUrl?.includes("/api/channels/twilio/voice"));

  // Probe the actual webhook host so a dead/ephemeral tunnel doesn't read as "Live".
  let reachable = false;
  const probeBase = (num.smsUrl || num.voiceUrl || "").replace(/\/api\/channels\/twilio\/.*$/, "");
  if (pathWired && probeBase) {
    try {
      // Any HTTP response means the tunnel is up — even a redirect from Cloudflare Access
      // counts. Only a thrown network error (dead tunnel) means "not reachable".
      await fetch(probeBase || "/", { signal: AbortSignal.timeout(4000) });
      reachable = true;
    } catch { reachable = false; }
  }

  // Boolean only, never the value — same posture as ownerNumberSet below.
  //
  // This is the readiness check for moving SmsUrl to the OS rail. With inbound SMS on the OS, the owner's
  // own commands come back through /api/channels/os-sms-relay, which is fail-closed: no secret
  // configured means it 401s everything. Repointing SmsUrl while this is false would silently take
  // their entire text control surface offline, and the symptom would be indistinguishable from
  // "Clara is ignoring me".
  const relaySecretSet = Boolean(
    (process.env.OS_SMS_RELAY_SECRET || process.env.INTERAGENT_SHARED_SECRET || "").trim(),
  );

  return NextResponse.json({
    configured: true,
    from: mask(cfg.from),
    ownerNumberSet: Boolean(cfg.ownerNumber),
    relaySecretSet,
    ownerNumber: mask(cfg.ownerNumber),
    numberSid: num.numSid,
    voiceUrl: num.voiceUrl ?? null,
    smsUrl: num.smsUrl ?? null,
    pathWired,
    reachable,
    wired: pathWired && reachable, // "Live" only when the tunnel actually answers
    error: num.error,
  });
}

// POST → point this number's webhooks. Voice and SMS are set INDEPENDENTLY, because since
// 2026-08-03 they legitimately live on different hosts: voice on Clara's tunnel (she needs the
// per-call turn state), SMS on the OS edge rail (the CRM path, with DNC/quiet-hours/reply-cap).
// This used to set both from one baseUrl, so wiring voice silently re-pointed SMS as a side effect.
//
//   { baseUrl }                     → voice only (default). SMS untouched.
//   { baseUrl, voice: false }       → voice untouched.
//   { baseUrl, smsUrl: "https://…"} → also re-point SMS at that exact URL.
//
// SMS defaults to untouched on purpose: the destructive direction is re-pointing a working rail by
// accident, and a caller who wants it changed can say so.
export async function POST(req: Request) {
  const cfg = twilioConfig();
  if (!cfg) return NextResponse.json({ error: "Twilio not configured — set CLARA_TWILIO_ACCOUNT_SID/AUTH_TOKEN/NUMBER in .env.local" }, { status: 400 });
  const body = await req.json().catch(() => ({})) as {
    baseUrl?: string; voice?: boolean; smsUrl?: string; voiceFallbackUrl?: string;
  };
  const base = String(body.baseUrl ?? "").trim().replace(/\/+$/, "");
  const setVoice = body.voice !== false;
  const smsUrl = String(body.smsUrl ?? "").trim().replace(/\/+$/, "");
  // Explicit param first: ORION_SUPABASE_URL is not guaranteed to be in this app's env, and a
  // silently-empty fallback is exactly the "control that looks configured and isn't" shape — the
  // caller would see ok:true and have no fallback at all.
  const fallbackUrl = String(
    body.voiceFallbackUrl
      ?? (process.env.ORION_SUPABASE_URL
        ? `${process.env.ORION_SUPABASE_URL.replace(/\/+$/, "")}/functions/v1/twilio-voice-fallback`
        : ""),
  ).trim();

  if (setVoice && !/^https:\/\/.+/.test(base)) {
    return NextResponse.json({ error: "baseUrl must be a public https URL that tunnels to this server (:3939)" }, { status: 400 });
  }
  if (smsUrl && !/^https:\/\/.+/.test(smsUrl)) {
    return NextResponse.json({ error: "smsUrl must be a public https URL" }, { status: 400 });
  }
  if (fallbackUrl && !/^https:\/\/.+/.test(fallbackUrl)) {
    return NextResponse.json({ error: "voiceFallbackUrl must be a public https URL" }, { status: 400 });
  }
  if (!setVoice && !smsUrl) {
    return NextResponse.json({ error: "nothing to do — pass a baseUrl for voice, an smsUrl for SMS, or both" }, { status: 400 });
  }

  const auth = Buffer.from(`${cfg.sid}:${cfg.token}`).toString("base64");
  const num = await lookupNumber(cfg.sid, cfg.from, auth);
  if (!num.numSid) return NextResponse.json({ error: num.error ?? "number not found" }, { status: 502 });

  const form = new URLSearchParams();
  if (setVoice) {
    form.set("VoiceUrl", `${base}/api/channels/twilio/voice`);
    form.set("VoiceMethod", "POST");
    // Terminal-state callback. This is what files a lead when the caller simply HANGS UP, which is
    // the normal way a call ends — without it, everything Clara qualified up to that moment is
    // discarded, because the session lives only in memory keyed by CallSid.
    form.set("StatusCallback", `${base}/api/channels/twilio/voice/status`);
    form.set("StatusCallbackMethod", "POST");
    // Hosted on Supabase, NOT on this tunnel. The most likely reason the primary fails is that this
    // box is down, and a fallback on the failed host is not a fallback.
    if (fallbackUrl) {
      form.set("VoiceFallbackUrl", fallbackUrl);
      form.set("VoiceFallbackMethod", "POST");
    }
  }
  if (smsUrl) {
    form.set("SmsUrl", smsUrl);
    form.set("SmsMethod", "POST");
  }
  const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${cfg.sid}/IncomingPhoneNumbers/${num.numSid}.json`, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  if (!r.ok) return NextResponse.json({ error: `Twilio ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}` }, { status: 502 });
  const j = await r.json().catch(() => ({}));

  // If the number belongs to a Messaging Service, that service's inbound handling OVERRIDES the
  // number's SmsUrl — with UseInboundWebhookOnNumber=false + no inbound_request_url, Twilio
  // receives texts but calls no webhook (received-but-silent). Flip the flag so inbound defers
  // to the number's webhook we just set. (A2P 10DLC registration commonly creates this service.)
  //
  // Only relevant when SMS was actually re-pointed. Flipping a Messaging Service's inbound handling
  // while touching voice alone would change SMS routing as a side effect — the exact class of
  // surprise this endpoint was just split up to stop.
  const fixedServices: string[] = [];
  try {
    if (!smsUrl) throw new Error("sms untouched");
    const svcR = await fetch(`https://messaging.twilio.com/v1/Services?PageSize=50`, { headers: { Authorization: `Basic ${auth}` } });
    if (svcR.ok) {
      for (const s of (await svcR.json()).services ?? []) {
        const pnR = await fetch(`https://messaging.twilio.com/v1/Services/${s.sid}/PhoneNumbers?PageSize=100`, { headers: { Authorization: `Basic ${auth}` } });
        if (!pnR.ok) continue;
        const nums = ((await pnR.json()).phone_numbers ?? []).map((p: Record<string, unknown>) => p.phone_number);
        if (nums.includes(cfg.from) && !s.use_inbound_webhook_on_number) {
          const up = await fetch(`https://messaging.twilio.com/v1/Services/${s.sid}`, {
            method: "POST",
            headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ UseInboundWebhookOnNumber: "true" }).toString(),
          });
          if (up.ok) fixedServices.push(String(s.sid));
        }
      }
    }
  } catch { /* best-effort */ }

  return NextResponse.json({
    ok: true,
    voiceUrl: j.voice_url,
    smsUrl: j.sms_url,
    statusCallback: j.status_callback,
    voiceFallbackUrl: j.voice_fallback_url,
    changed: [setVoice ? "voice" : null, smsUrl ? "sms" : null].filter(Boolean),
    fixedServices,
  });
}
