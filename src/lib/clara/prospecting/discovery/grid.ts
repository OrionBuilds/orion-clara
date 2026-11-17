// §9/§31 — hex grid over a search radius, quad-split when a cell is too dense.
//
// Flat-top hexagons, circumradius `cellRadiusMiles` (12 by default), tiled to cover a disc of
// `radiusMiles` around a center point. Pure geometry — no network, no provider knowledge. The
// estimator uses the cell COUNT; discovery uses the cell CENTERS to bias each Places/Brave query.

export interface GridCell {
  id: string;
  lat: number;
  lng: number;
  radiusMiles: number;
}

export const DEFAULT_CELL_RADIUS_MILES = 12;
export const MIN_CELL_RADIUS_MILES = 3;

const EARTH_RADIUS_MILES = 3958.8;
const toRad = (d: number) => (d * Math.PI) / 180;
const toDeg = (r: number) => (r * 180) / Math.PI;

function milesToLatDeg(mi: number): number {
  return toDeg(mi / EARTH_RADIUS_MILES);
}
function milesToLngDeg(mi: number, atLatDeg: number): number {
  const cos = Math.cos(toRad(atLatDeg));
  const safeCos = Math.abs(cos) > 1e-6 ? cos : 1e-6;
  return toDeg(mi / (EARTH_RADIUS_MILES * safeCos));
}

export function haversineMiles(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_MILES * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Flat-top hex grid centers covering a disc of `radiusMiles` around (lat,lng). Degenerates to a
 * single cell when either radius isn't positive (a bad/zeroed location still gets ONE search area
 * rather than throwing or returning nothing).
 */
export function hexGrid(lat: number, lng: number, radiusMiles: number, cellRadiusMiles: number = DEFAULT_CELL_RADIUS_MILES): GridCell[] {
  if (!(radiusMiles > 0) || !(cellRadiusMiles > 0)) {
    return [{ id: "0:0", lat, lng, radiusMiles: cellRadiusMiles > 0 ? cellRadiusMiles : Math.max(radiusMiles, 1) }];
  }
  const vertSpacing = cellRadiusMiles * 1.5;
  const horizSpacing = cellRadiusMiles * Math.sqrt(3);
  const span = radiusMiles + cellRadiusMiles;
  const rows = Math.ceil(span / vertSpacing) + 1;
  const cols = Math.ceil(span / horizSpacing) + 1;
  const cells: GridCell[] = [];
  for (let row = -rows; row <= rows; row++) {
    const rowOffset = Math.abs(row % 2) === 1 ? horizSpacing / 2 : 0;
    for (let col = -cols; col <= cols; col++) {
      const dy = row * vertSpacing;
      const dx = col * horizSpacing + rowOffset;
      const cLat = lat + milesToLatDeg(dy);
      const cLng = lng + milesToLngDeg(dx, cLat);
      if (haversineMiles(lat, lng, cLat, cLng) <= span) {
        cells.push({ id: `${row}:${col}`, lat: cLat, lng: cLng, radiusMiles: cellRadiusMiles });
      }
    }
  }
  return cells;
}

/**
 * Split one cell into 4 quadrant children at half the radius, floored at `minRadiusMiles` — used
 * when a cell's discovery page cap was hit so dense areas get finer coverage instead of losing
 * candidates past a provider's page limit. Returns the cell unchanged once at the floor.
 */
export function quadSplit(cell: GridCell, minRadiusMiles: number = MIN_CELL_RADIUS_MILES): GridCell[] {
  const r = cell.radiusMiles / 2;
  if (r < minRadiusMiles) return [cell];
  const offsetLat = milesToLatDeg(r);
  const dirs: Array<[1 | -1, 1 | -1]> = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
  return dirs.map(([sy, sx]) => {
    const cLat = cell.lat + sy * offsetLat;
    const cLng = cell.lng + sx * milesToLngDeg(r, cLat);
    return { id: `${cell.id}.${sy > 0 ? "n" : "s"}${sx > 0 ? "e" : "w"}`, lat: cLat, lng: cLng, radiusMiles: r };
  });
}
