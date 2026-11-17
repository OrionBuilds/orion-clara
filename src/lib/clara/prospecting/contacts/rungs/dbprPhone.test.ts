import { test } from "node:test";
import assert from "node:assert/strict";
import { callDbprPhone } from "./dbprPhone";
import type { RungContext } from "../waterfall";

test("always a documented miss — DbprRecord carries no phone field yet", () => {
  const ctx: RungContext = { companyId: "co_1", companyName: "Acme Roofing", fitScore: 80, allowLive: true };
  const r = callDbprPhone(ctx);
  assert.equal(r.hit, false);
  if (!r.hit) assert.match(r.reason, /no phone field/);
});
