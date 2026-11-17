import { test } from "node:test";
import assert from "node:assert/strict";
import { hexGrid, quadSplit, haversineMiles, DEFAULT_CELL_RADIUS_MILES, MIN_CELL_RADIUS_MILES } from "./grid";

test("hexGrid: every cell center is within radius+cellRadius of the origin", () => {
  const cells = hexGrid(27.95, -82.46, 100, 12);
  assert.ok(cells.length > 1);
  for (const c of cells) {
    assert.ok(haversineMiles(27.95, -82.46, c.lat, c.lng) <= 100 + 12 + 1e-6);
  }
});

test("hexGrid: cell ids are unique", () => {
  const cells = hexGrid(27.95, -82.46, 100);
  assert.equal(new Set(cells.map((c) => c.id)).size, cells.length);
});

test("hexGrid: a bigger radius covers more cells, roughly quadratically", () => {
  const small = hexGrid(0, 0, 25);
  const big = hexGrid(0, 0, 100);
  assert.ok(big.length > small.length * 4);
});

test("hexGrid: degenerates to one cell for a zero/negative radius", () => {
  assert.equal(hexGrid(0, 0, 0).length, 1);
  assert.equal(hexGrid(0, 0, -5).length, 1);
});

test("quadSplit: 4 children, each roughly within the parent's footprint", () => {
  const [parent] = hexGrid(27.95, -82.46, 1, DEFAULT_CELL_RADIUS_MILES);
  const kids = quadSplit(parent);
  assert.equal(kids.length, 4);
  assert.equal(new Set(kids.map((k) => k.id)).size, 4);
  for (const k of kids) {
    assert.equal(k.radiusMiles, parent.radiusMiles / 2);
    assert.ok(haversineMiles(parent.lat, parent.lng, k.lat, k.lng) <= parent.radiusMiles);
  }
});

test("quadSplit: stops at the floor radius", () => {
  const cell = { id: "x", lat: 0, lng: 0, radiusMiles: MIN_CELL_RADIUS_MILES };
  const kids = quadSplit(cell);
  assert.equal(kids.length, 1);
  assert.equal(kids[0], cell);
});
