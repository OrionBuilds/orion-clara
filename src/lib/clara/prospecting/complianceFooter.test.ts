import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildUnsubscribeUrl, buildFooterText, appendComplianceFooter, buildComplianceHeaders,
  mintUnsubscribeLink, loadPhysicalAddress, REPLY_TO_ADDRESS,
  type MintUnsubscribeLinkDeps, type PhysicalAddressDeps,
} from "./complianceFooter";

test("buildUnsubscribeUrl: joins the supabase functions base with the slug, tolerant of a trailing slash", () => {
  assert.equal(buildUnsubscribeUrl("abc123", "https://proj.supabase.co"), "https://proj.supabase.co/functions/v1/email-unsubscribe/abc123");
  assert.equal(buildUnsubscribeUrl("abc123", "https://proj.supabase.co/"), "https://proj.supabase.co/functions/v1/email-unsubscribe/abc123");
});

test("buildFooterText / appendComplianceFooter: physical address + unsubscribe link, appended cleanly", () => {
  const footer = buildFooterText({ physicalAddress: "123 Main St, Tampa, FL 33602", unsubscribeUrl: "https://x/u/abc" });
  assert.match(footer, /123 Main St, Tampa, FL 33602/);
  assert.match(footer, /https:\/\/x\/u\/abc/);
  const body = appendComplianceFooter("Hi Jane,\n\nFollowing up.   ", { physicalAddress: "123 Main St", unsubscribeUrl: "https://x/u/abc" });
  assert.ok(body.startsWith("Hi Jane,\n\nFollowing up."));
  assert.match(body, /123 Main St/);
});

test("buildComplianceHeaders: List-Unsubscribe carries both mailto and https forms, one-click post, Clara's own Reply-To", () => {
  const headers = buildComplianceHeaders({ unsubscribeUrl: "https://x/u/abc", senderDomain: "mail.acmeleads.com" });
  assert.equal(headers["List-Unsubscribe"], "<mailto:unsub@mail.acmeleads.com?subject=unsubscribe>, <https://x/u/abc>");
  assert.equal(headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
  assert.equal(headers["Reply-To"], REPLY_TO_ADDRESS);
  assert.equal(headers["Reply-To"], "clara@example.com");
});

test("mintUnsubscribeLink: mints a tracked_links row with the email/company/enrollment in metadata, returns the public URL", async () => {
  let createArgs: unknown;
  const deps: MintUnsubscribeLinkDeps = {
    trackedLinksCreate: async (args) => { createArgs = args; return { link: { id: "l1" }, slug: "deadbeef1234" }; },
    supabaseUrl: "https://proj.supabase.co",
  };
  const url = await mintUnsubscribeLink({ email: "Jane@Acme.com", companyId: "co_1", contactId: "ct_1", enrollmentId: "en_1" }, deps);
  assert.equal(url, "https://proj.supabase.co/functions/v1/email-unsubscribe/deadbeef1234");
  assert.equal((createArgs as { contact_id: string }).contact_id, "ct_1");
  assert.deepEqual((createArgs as { metadata: Record<string, unknown> }).metadata, {
    kind: "unsubscribe", email: "jane@acme.com", company_id: "co_1", enrollment_id: "en_1",
  });
});

test("loadPhysicalAddress: trims and returns the configured address", async () => {
  const deps: PhysicalAddressDeps = { prospectSettingsGet: async () => ({ physical_address: "  123 Main St  " } as never) };
  assert.equal(await loadPhysicalAddress(deps), "123 Main St");
});
test("loadPhysicalAddress: a blank/missing address returns undefined — never a blank footer line", async () => {
  const deps: PhysicalAddressDeps = { prospectSettingsGet: async () => ({ physical_address: "   " } as never) };
  assert.equal(await loadPhysicalAddress(deps), undefined);
  const deps2: PhysicalAddressDeps = { prospectSettingsGet: async () => undefined };
  assert.equal(await loadPhysicalAddress(deps2), undefined);
});
