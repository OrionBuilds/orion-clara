import { test } from "node:test";
import assert from "node:assert/strict";
import { placesForCell } from "./placesGrid";
import type { JobSpec } from "../types";

test("placesForCell asks Places for websites and a full page, and maps websiteUri to website_url", async (t) => {
  process.env.CLARA_GOOGLE_MAPS_API_KEY = "test-key";
  const seen: { mask?: string; body?: Record<string, unknown> } = {};
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    seen.mask = (init.headers as Record<string, string>)["X-Goog-FieldMask"];
    seen.body = JSON.parse(String(init.body));
    return new Response(JSON.stringify({
      places: [{ id: "p1", displayName: { text: "Acme Wealth" }, businessStatus: "OPERATIONAL", websiteUri: "https://acmewealth.example/" }],
    }));
  });
  const spec = { queries: ["financial advisor Tampa FL"], industry: [] } as unknown as JobSpec;
  const r = await placesForCell({ lat: 27.95, lng: -82.46, radiusMiles: 10 }, spec);
  assert.match(seen.mask ?? "", /places\.websiteUri/);
  assert.equal(seen.body?.maxResultCount, 20);
  assert.equal(r.candidates[0]?.website_url, "https://acmewealth.example/");
});
