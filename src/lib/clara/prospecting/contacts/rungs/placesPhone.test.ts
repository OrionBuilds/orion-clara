import { test } from "node:test";
import assert from "node:assert/strict";
import { callPlacesPhone } from "./placesPhone";
import type { RungContext } from "../waterfall";

function ctx(overrides: Partial<RungContext> = {}): RungContext {
  return { companyId: "co_1", companyName: "Acme Roofing", fitScore: 80, allowLive: true, ...overrides };
}

test("a company with an office phone on the row is a free, instant hit, kind=phone", () => {
  const r = callPlacesPhone(ctx({ officePhone: "+18135550100" }));
  assert.equal(r.hit, true);
  if (r.hit) { assert.equal(r.kind, "phone"); assert.equal(r.value, "+18135550100"); assert.equal(r.provider, "places"); assert.equal(r.costUsd, 0); }
});

test("no office phone on the row is a clean miss", () => {
  const r = callPlacesPhone(ctx({ officePhone: undefined }));
  assert.equal(r.hit, false);
});
