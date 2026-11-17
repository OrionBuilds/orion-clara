// Paid ads/marketing are not offered: one detector, applied the same way by every router.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isPaidAdsOrMarketing } from "./retiredServices";
import { normalizeTriagePlan } from "./clientEmailTriage";
import { classifyRoutingAnswer } from "./portal/routingClarify";


test("isPaidAdsOrMarketing: ads/marketing yes; SEO, bids, ad hoc, social login no", () => {
  for (const t of ["raise the ad budget", "new Google Ads campaign", "run Facebook ads for spring", "monthly newsletter", "social media posts", "marketing plan"]) {
    assert.equal(isPaidAdsOrMarketing(t), true, t);
  }
  for (const t of ["can you run ads for us", "set up Google Ads", "paid ads budget", "launch a Facebook ad campaign", "an email campaign for spring", "write the newsletter"]) {
    assert.equal(isPaidAdsOrMarketing(t), true, t);
  }
  for (const t of ["improve our SEO", "local SEO and Google Business Profile", "send the roof bid to the client", "an ad hoc fix", "add social login", "fix the landing page form",
    "fix the newsletter signup form", "add the campaign field to the CRM export", "fix ads.txt", "update the creatives folder upload", "the ads table query is slow"]) {
    assert.equal(isPaidAdsOrMarketing(t), false, t);
  }
});

test("email triage: a paid-ads ask becomes an owner task, even when the model labels it friday", () => {
  const p = normalizeTriagePlan({
    tasks: [{ agent: "friday", summary: "fix the contact form" }, { agent: "friday", summary: "launch a Google Ads campaign" }],
    reply: "Thanks — Clara",
  });
  assert.deepEqual(p?.tasks.map((t) => t.summary), ["fix the contact form"]);
  assert.equal(p?.ownerAsk, "launch a Google Ads campaign");
  assert.equal(normalizeTriagePlan({ tasks: [], owner_ask: "wants Meta ads run", reply: "Thanks" })?.ownerAsk, "wants Meta ads run");
  assert.equal(normalizeTriagePlan({ tasks: [{ agent: "friday", summary: "SEO audit" }], reply: "Thanks" })?.ownerAsk, undefined);
  assert.equal(normalizeTriagePlan({ tasks: [], reply: "" }), null);
});

test("routing clarification: an SEO answer is FRIDAY's, an ads answer is the owner's, both is ambiguous", () => {
  assert.equal(classifyRoutingAnswer([{ answer: "it's about our SEO" }]), "friday");
  assert.equal(classifyRoutingAnswer([{ answer: "the Facebook ad campaign" }]), "owner");
  assert.equal(classifyRoutingAnswer([{ answer: "SEO and the ad campaign" }]), "ambiguous");
});

