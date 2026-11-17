import { test } from "node:test";
import assert from "node:assert/strict";
import { withImageMarker, stripImageMarker } from "./imageMarker";

test("an image turn's persisted marker round-trips, so history dedupe matches the live turn", () => {
  assert.equal(withImageMarker("what's this error?", 1), "what's this error? [1 image attached]");
  assert.equal(withImageMarker("", 2), "[2 images attached]");
  assert.equal(withImageMarker("no images", 0), "no images");
  for (const t of ["what's this error?", "", "two lines\nhere"]) {
    assert.equal(stripImageMarker(withImageMarker(t, 3)), t);
  }
  assert.equal(stripImageMarker("a normal [note] in brackets"), "a normal [note] in brackets");
});
