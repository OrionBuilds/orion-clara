import { NextResponse } from "next/server";
import { deepMerge } from "@/lib/clara/config";
import { normalizeEmail, EXCLUDED_PERSONAL_EMAIL } from "@/lib/clara/ms-auth";
import { twilioSignatureValid } from "@/lib/clara/channels";
import { classifyVerdict } from "@/lib/clara/triage";
import { decide } from "@/lib/clara/screening";
import { can } from "@/lib/clara/tiers";
import { OWNER_PERSONAL_GMAIL, OWNER_WORK_EMAIL } from "@/lib/clara/owner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Eval harness (parity with FRIDAY's /api/friday/eval — same pattern:
// named case-builder functions composed in GET(), which scales better than one flat array).
// Golden cases that lock in Clara's deterministic safety guarantees. Run: GET /api/eval →
// 200 all-pass, else 500. 500 means a safety guarantee regressed — do not deploy.

type Case = { name: string; got: boolean | string | number | undefined; want: boolean | string | number | undefined };

// deepMerge() — the fix for the shallow-merge bug where a partial nested on-disk override
// silently zeroed sibling default keys (see config.ts's own header comment on the finding).
function deepMergeCases(): Case[] {
  const c: Case[] = [];
  const base = { spend: { perTxnUsd: 100, perDayUsd: 500 }, name: "default" };
  const merged = deepMerge(base, { spend: { perTxnUsd: 250 } } as Partial<typeof base>);
  c.push({ name: "deepMerge: partial nested override applies", got: merged.spend.perTxnUsd, want: 250 });
  c.push({ name: "deepMerge: sibling nested key NOT wiped by partial override", got: merged.spend.perDayUsd, want: 500 });
  c.push({ name: "deepMerge: top-level key untouched by nested override", got: merged.name, want: "default" });
  const arrayBase = { list: [1, 2, 3] };
  const arrayMerged = deepMerge(arrayBase, { list: [9] });
  c.push({ name: "deepMerge: arrays replaced wholesale, not merged element-wise", got: arrayMerged.list.length, want: 1 });
  return c;
}

// twilioSignatureValid() — both prod-fail-closed escape hatches (the fix backported from CLARA
// into FRIDAY in this same pass — see FRIDAY's src/lib/friday/channels.ts). isProdOverride lets this run without
// mutating process.env.NODE_ENV on a live server.
function twilioCases(): Case[] {
  const c: Case[] = [];
  const req = new Request("https://clara.example/api/x", { headers: { "x-twilio-signature": "whatever" } });
  const savedEnforce = process.env.TWILIO_ENFORCE_SIGNATURE;
  const savedToken = process.env.CLARA_TWILIO_AUTH_TOKEN;
  try {
    process.env.TWILIO_ENFORCE_SIGNATURE = "false";
    delete process.env.CLARA_TWILIO_AUTH_TOKEN;
    let threw = false;
    try { twilioSignatureValid(req, req.url, {}, true); } catch { threw = true; }
    c.push({ name: "twilio: ENFORCE_SIGNATURE=false in prod throws (must not silently allow)", got: threw, want: true });
    c.push({ name: "twilio: ENFORCE_SIGNATURE=false in dev is allowed (debugging escape hatch)", got: twilioSignatureValid(req, req.url, {}, false), want: true });

    process.env.TWILIO_ENFORCE_SIGNATURE = "true";
    delete process.env.CLARA_TWILIO_AUTH_TOKEN;
    c.push({ name: "twilio: missing token in prod fails closed", got: twilioSignatureValid(req, req.url, {}, true), want: false });
    c.push({ name: "twilio: missing token in dev fails open (local convenience)", got: twilioSignatureValid(req, req.url, {}, false), want: true });
  } finally {
    if (savedEnforce === undefined) delete process.env.TWILIO_ENFORCE_SIGNATURE; else process.env.TWILIO_ENFORCE_SIGNATURE = savedEnforce;
    if (savedToken === undefined) delete process.env.CLARA_TWILIO_AUTH_TOKEN; else process.env.CLARA_TWILIO_AUTH_TOKEN = savedToken;
  }
  return c;
}

// normalizeEmail() — the personal-email exclusion must catch plus-addressed aliases, not just
// the exact address.
function msAuthCases(): Case[] {
  const c: Case[] = [];
  c.push({ name: "email: exact personal address matches", got: normalizeEmail(OWNER_PERSONAL_GMAIL) === EXCLUDED_PERSONAL_EMAIL, want: true });
  c.push({ name: "email: plus-addressed alias still matches", got: normalizeEmail(OWNER_PERSONAL_GMAIL.replace("@", "+work@")) === EXCLUDED_PERSONAL_EMAIL, want: true });
  c.push({ name: "email: mixed case still matches", got: normalizeEmail(OWNER_PERSONAL_GMAIL.toUpperCase()) === EXCLUDED_PERSONAL_EMAIL, want: true });
  c.push({ name: "email: unrelated address does not match", got: normalizeEmail(OWNER_WORK_EMAIL) === EXCLUDED_PERSONAL_EMAIL, want: false });
  return c;
}

// classifyVerdict() — VIP/newsletter/routine/escalate boundary cases.
function triageCases(): Case[] {
  const c: Case[] = [];
  const vip = ["boss@bigco.com"];
  c.push({ name: "triage: vip address -> vip", got: classifyVerdict("boss@bigco.com", "hi", "", vip), want: "vip" });
  c.push({ name: "triage: newsletter sender -> newsletter", got: classifyVerdict("noreply@shop.com", "Sale this week", "", vip), want: "newsletter" });
  c.push({ name: "triage: scheduling subject -> routine", got: classifyVerdict("client@x.com", "Can we reschedule our call?", "", vip), want: "routine" });
  c.push({ name: "triage: nothing matches -> escalate", got: classifyVerdict("stranger@x.com", "Question about your services", "just checking in", vip), want: "escalate" });
  return c;
}

// decide() — whitelist match and focus-mode routing.
function screeningCases(): Case[] {
  const c: Case[] = [];
  c.push({
    name: "screening: whitelisted caller routes to the owner even in focus mode",
    got: decide({ fromE164: "+1", toE164: "+2", ownerFocusMode: true, isWhitelisted: true }).route,
    want: "owner",
  });
  c.push({
    name: "screening: not in focus mode -> the owner takes the call",
    got: decide({ fromE164: "+1", toE164: "+2", ownerFocusMode: false, isWhitelisted: false }).route,
    want: "owner",
  });
  c.push({
    name: "screening: focus mode + unknown caller -> Clara screens",
    got: decide({ fromE164: "+1", toE164: "+2", ownerFocusMode: true, isWhitelisted: false }).route,
    want: "clara",
  });
  return c;
}

// can() — tier table posture lookups.
async function tierCases(): Promise<Case[]> {
  const c: Case[] = [];
  const ownerCal = await can("owner", "calendar.external");
  c.push({ name: "tiers: owner auto-allowed on calendar.external", got: ownerCal.allow, want: true });
  const personalGmail = await can("owner", "email.personal");
  c.push({ name: "tiers: email.personal always blocked regardless of requestor", got: personalGmail.posture, want: "blocked" });
  return c;
}

export async function GET() {
  const cases: Case[] = [
    ...deepMergeCases(),
    ...twilioCases(),
    ...msAuthCases(),
    ...triageCases(),
    ...screeningCases(),
    ...(await tierCases()),
  ];
  const failures = cases.filter((c) => c.got !== c.want);
  return NextResponse.json(
    { passed: cases.length - failures.length, failed: failures.length, total: cases.length, failures },
    { status: failures.length ? 500 : 200 },
  );
}
