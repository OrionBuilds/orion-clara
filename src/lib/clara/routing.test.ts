// Tests for the routing classifier and the pending-offer logic (pure parts).

import { test } from "node:test";
import assert from "node:assert/strict";
import { proposeRoute, readConfirmation, readAgentChoice, applyOffer, pickOffer, OFFERS_PER_NUMBER, type PendingRoute } from "./routing";

const offer = (from: string, target: PendingRoute["target"], prompt = "x"): PendingRoute => ({ from, target, prompt, why: "w", offeredAt: "2026-09-14T00:00:00Z" });

test("proposeRoute: dev and SEO go to FRIDAY; ads/marketing never route", () => {
  assert.equal((proposeRoute("the staging deploy is failing") as { target: string }).target, "friday");
  assert.equal((proposeRoute("can you improve our SEO for the roofing pages") as { target: string }).target, "friday");
  assert.equal(proposeRoute("raise the bid on the Miller campaign"), null);
  assert.equal(proposeRoute("fix the deploy and raise the ad budget"), null, "mixed ads asks stay with Clara");
  assert.equal(proposeRoute("set up a new Google Ads campaign"), null);
  assert.equal(proposeRoute("can someone look at the webhook"), null);
  assert.equal(proposeRoute("deploy"), null);
});

test("readConfirmation and readAgentChoice", () => {
  assert.equal(readConfirmation("Yes!"), true); assert.equal(readConfirmation("nah"), false); assert.equal(readConfirmation("what about tomorrow"), null);
  assert.equal(readAgentChoice("Friday please"), "friday"); assert.equal(readAgentChoice("marketing"), null); assert.equal(readAgentChoice("yes"), null);
});

test("applyOffer keeps the newest OFFERS_PER_NUMBER per number and leaves other numbers alone", () => {
  let rows: PendingRoute[] = [offer("+1", "friday", "a"), offer("+2", "friday", "z")];
  for (const p of ["b", "c", "d"]) rows = applyOffer(rows, offer("+1", "friday", p));
  assert.deepEqual(rows.filter((r) => r.from === "+1").map((r) => r.prompt), ["b", "c", "d"].slice(-OFFERS_PER_NUMBER));
  assert.equal(rows.filter((r) => r.from === "+2").length, 1);
});

test("pickOffer resolves the newest; an 'ask' offer needs a named bench", () => {
  const rows = [offer("+1", "friday", "old"), offer("+1", "ask", "new")];
  assert.equal(pickOffer(rows, "+1"), null);
  assert.equal(pickOffer(rows, "+1", "friday")?.target, "friday");
  assert.equal(pickOffer([offer("+1", "friday", "only")], "+1")?.prompt, "only");
  assert.equal(pickOffer(rows, "+9"), null);
});
