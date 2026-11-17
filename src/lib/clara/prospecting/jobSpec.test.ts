import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeJobSpec, describeSpec, queriesFor, normalizeState, DEFAULT_RADIUS_MILES, MAX_RADIUS_MILES } from "./jobSpec";

test("normalizeJobSpec: requires industry and location", () => {
  const r = normalizeJobSpec({});
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes("industry")));
  assert.ok(r.errors.some((e) => e.includes("location")));
});

test("normalizeJobSpec: a minimal roofing/Tampa request gets sane defaults", () => {
  const r = normalizeJobSpec({ industry: ["roofing"], location: { label: "Tampa, FL" } });
  assert.equal(r.ok, true);
  const spec = r.spec!;
  assert.equal(spec.location.radius_miles, DEFAULT_RADIUS_MILES);
  assert.deepEqual(spec.queries, queriesFor(["roofing"]));
  assert.ok(spec.enrichments.includes("website"));
  assert.deepEqual(spec.sources, ["places", "brave"]);
  assert.equal(spec.gates.deep_research_min, 60);
});

test("normalizeJobSpec: radius above the ceiling is capped with a warning", () => {
  const r = normalizeJobSpec({ industry: ["roofing"], location: { label: "Tampa", radius_miles: 1000 } });
  assert.equal(r.ok, true);
  assert.equal(r.spec!.location.radius_miles, MAX_RADIUS_MILES);
  assert.ok(r.warnings.some((w) => w.includes("capped")));
});

test("normalizeJobSpec: email implies owner, mobile implies email", () => {
  const r = normalizeJobSpec({ industry: ["roofing"], location: { label: "Tampa" }, enrichments: ["mobile"] });
  assert.equal(r.ok, true);
  assert.ok(r.spec!.enrichments.includes("email"));
  assert.ok(r.spec!.enrichments.includes("owner"));
  assert.ok(r.spec!.enrichments.includes("mobile"));
});

test("normalizeJobSpec: a gate below the floor is raised, never lowered", () => {
  const r = normalizeJobSpec({ industry: ["roofing"], location: { label: "Tampa" }, gates: { deep_research_min: 10 } });
  assert.equal(r.ok, true);
  assert.equal(r.spec!.gates.deep_research_min, 60);
  assert.ok(r.warnings.some((w) => w.includes("floor")));
});

test("normalizeJobSpec: a reversed revenue range is swapped", () => {
  const r = normalizeJobSpec({ industry: ["roofing"], location: { label: "Tampa" }, requirements: { estimated_revenue_min: 5_000_000, estimated_revenue_max: 1_000_000 } });
  assert.equal(r.ok, true);
  assert.equal(r.spec!.requirements.estimated_revenue_min, 1_000_000);
  assert.equal(r.spec!.requirements.estimated_revenue_max, 5_000_000);
});

test("normalizeState resolves full names and validates abbreviations", () => {
  assert.equal(normalizeState("florida"), "FL");
  assert.equal(normalizeState("fl"), "FL");
  assert.equal(normalizeState("Neverland"), undefined);
});

test("describeSpec reads as a plain-English sentence", () => {
  const r = normalizeJobSpec({ industry: ["roofing"], location: { label: "Tampa", radius_miles: 50 }, requirements: { min_rating: 4 } });
  const line = describeSpec(r.spec!);
  assert.match(line, /roofing/);
  assert.match(line, /50 miles of Tampa/);
  assert.match(line, /4\+ Google rating/);
});
