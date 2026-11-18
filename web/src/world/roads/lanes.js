// Lane geometry shared by the lane graph, the bridge builder and the GROUND shader.
// The shader (src/render/families/ground.js, function laneFrame) repeats these rules in GLSL; the constants
// below are interpolated into that source so the two cannot drift apart.

import { GROUND } from '../../core/ids.js';

/** Road surface height of all land and the kerb height above it (ARCHITECTURE.md, conventions). */
export const LAND_Y = 1.2, KERB_HEIGHT = 0.14;

/** Dimensions in metres. Keep in step with README section 1.1. */
export const LANE = Object.freeze({
  GUTTER: 0.45,          // concrete gutter pan against a kerb
  SHY: 0.15,             // gap between the gutter and the travelled way
  SHOULDER_SHY: 0.30,    // inset of the travelled-way limit on roads without a kerb and on decks
  PARKING: 2.30,         // minimum kerbside parking strip
  MIN: 3.00,             // a parking strip is only made if lanes stay at least this wide
  MAX: 3.60,             // widest lane beside a parking strip
  MEDIAN: 3.50,          // lane width on median roads, counted from the outside
  MEDIAN_SHY: 0.60,      // least distance of the inner yellow line from the centre line
  MEDIAN_KERB: 0.35,     // clearance between that line and the face of a raised median
  OPEN: 3.70,            // widest lane on open-shoulder roads and decks
  LINE: 0.12,            // painted line width
  CENTRE_GAP: 0.11,      // offset of each line of the double yellow from the centre
  DASH: 3.0, DASH_PERIOD: 12.0,      // dashed lane line: paint length and repeat
  BAY: 6.7, BAY_TICK: 1.2,           // kerbside parking bay length and the length of its tick mark
});

/**
 * Kerb stone profile, in metres along the unrolled profile from the gutter line (KERB uv.x): the face rises to FACE,
 * a 25 mm chamfer at 45 degrees reaches CHAMFER, the top runs back to BACK. STONE is the length of one stone (uv.y).
 */
export const KERB = Object.freeze({ STONE: 0.9, FACE: 0.115, CHAMFER: 0.15, BACK: 0.30 });

export const LANE_FLAG = Object.freeze({ ONE_WAY: 8, MEDIAN: 16, NO_MARKINGS: 32, OPEN_SHOULDER: 64 });

/** Pack the lane code byte (ASPHALT and DECK p1). */
export function laneCode({ lanesPerDirection = 1, oneWay = false, median = false, noMarkings = false, openShoulder = false } = {}) {
  const n = Math.max(1, Math.min(7, lanesPerDirection | 0));
  return n + (oneWay ? LANE_FLAG.ONE_WAY : 0) + (median ? LANE_FLAG.MEDIAN : 0) + (noMarkings ? LANE_FLAG.NO_MARKINGS : 0) + (openShoulder ? LANE_FLAG.OPEN_SHOULDER : 0);
}

/**
 * Lane layout of a road cross-section.
 * halfWidth: metres from the centre line to the kerb face (or to the edge of paving).
 * deck: true for the DECK material, which always uses the open-shoulder rules.
 * Returns { lanes: [{ offset, dir, width }], laneWidth, edge, inner, gutter, parking, medianHalf, lines }.
 * Offsets are lateral, positive to the right of increasing station. dir = +1 travels towards +station.
 */
export function laneLayout(halfWidth, code, deck = false) {
  const n = Math.max(1, code & 7), oneWay = !!(code & LANE_FLAG.ONE_WAY), median = !!(code & LANE_FLAG.MEDIAN);
  const open = deck || !!(code & LANE_FLAG.OPEN_SHOULDER), marked = !(code & LANE_FLAG.NO_MARKINGS);
  const gutter = open ? 0 : LANE.GUTTER;
  const limit = halfWidth - gutter - (open ? LANE.SHOULDER_SHY : LANE.SHY);   // outermost possible edge of the travelled way
  let width, edge, inner = 0, parking = null;
  const lanes = [], lines = [];

  if (median) {
    width = Math.min(LANE.MEDIAN, (limit - LANE.MEDIAN_SHY) / n); edge = limit; inner = edge - n * width;
    for (let k = 0; k < n; k++) { const o = edge - (k + 0.5) * width; lanes.push({ offset: o, dir: 1, width }, { offset: -o, dir: -1, width }); }
  } else if (oneWay) {
    const across = 2 * limit;
    if (open) { width = Math.min(LANE.OPEN, across / n); edge = n * width / 2; }
    else if ((across - 2 * LANE.PARKING) / n >= LANE.MIN) { width = Math.min(LANE.MAX, (across - 2 * LANE.PARKING) / n); edge = n * width / 2; parking = { inner: edge, outer: limit }; }
    else { width = across / n; edge = limit; }
    inner = -edge;
    for (let k = 0; k < n; k++) lanes.push({ offset: -edge + (k + 0.5) * width, dir: 1, width });
  } else {
    if (open) { width = Math.min(LANE.OPEN, limit / n); edge = n * width; }
    else if ((limit - LANE.PARKING) / n >= LANE.MIN) { width = Math.min(LANE.MAX, (limit - LANE.PARKING) / n); edge = n * width; parking = { inner: edge, outer: limit }; }
    else { width = limit / n; edge = limit; }
    for (let k = 0; k < n; k++) { const o = (k + 0.5) * width; lanes.push({ offset: o, dir: 1, width }, { offset: -o, dir: -1, width }); }
  }

  if (marked) {
    const edgeLine = !!parking || open || median || oneWay || n >= 2;
    if (median) { lines.push({ lateral: inner, kind: 'yellow' }, { lateral: -inner, kind: 'yellow' }); }
    else if (!oneWay) { lines.push({ lateral: LANE.CENTRE_GAP, kind: 'yellow' }, { lateral: -LANE.CENTRE_GAP, kind: 'yellow' }); }
    if (oneWay && !median) {
      for (let k = 1; k < n; k++) lines.push({ lateral: -edge + k * width, kind: 'dashed' });
      lines.push({ lateral: -edge, kind: 'yellow' }, { lateral: edge, kind: 'white' });
    } else {
      const from = median ? inner : 0;
      for (let k = 1; k < n; k++) lines.push({ lateral: from + k * width, kind: 'dashed' }, { lateral: -(from + k * width), kind: 'dashed' });
      if (edgeLine) lines.push({ lateral: edge, kind: 'white' }, { lateral: -edge, kind: 'white' });
    }
  }
  lanes.sort((a, b) => a.offset - b.offset);
  return { lanes, laneWidth: width, edge, inner, gutter, parking, medianHalf: median ? Math.max(0, inner - LANE.MEDIAN_KERB) : 0, lines, open };
}

// ---------------------------------------------------------------- pattern headings and blends

/** Heading byte for the pattern rotation of SIDEWALK, KERB, PAVERS, MEDIAN, GRASS and LOT (p2). yaw in radians. */
export const headingByte = (yaw) => ((Math.round(yaw / Math.PI * 256) % 256) + 256) % 256;

/**
 * World (x, z) to pattern coordinates for a heading byte: out[1] runs along the heading, out[0] across it.
 * The GROUND shader applies the same rotation (function headingFrame).
 */
export function patternCoords(x, z, byte, out = [0, 0]) {
  const a = byte * Math.PI / 256, c = Math.cos(a), s = Math.sin(a);
  out[0] = x * c - z * s; out[1] = x * s + z * c; return out;
}

/** Secondary-material byte for ground blends (p1 of the primary). variant is the secondary's own p0, 0..15. */
export function blendCode(secondaryId, variant = 0) {
  if (secondaryId === GROUND.MARKING || secondaryId === GROUND.DECK || secondaryId === GROUND.TARMAC || secondaryId === GROUND.KERB) {
    throw new Error('blendCode: material ' + secondaryId + ' cannot be a blend secondary');
  }
  return (secondaryId + 1) + 16 * (variant & 15);
}
/** Distance in metres over which a blend completes; write uv.x = distance to the secondary (README 1.3). */
export const BLEND_REACH = 2.5;

// ---------------------------------------------------------------- parking lots

/** LOT bay pattern: across the heading, a row module is bay, aisle, bay. */
export const LOT = Object.freeze({ BAY_DEPTH: 5.0, AISLE: 6.6, MODULE: 16.6 });

/**
 * Parking bays of a LOT surface, matching the lines the shader paints.
 * bounds: [minX, minZ, maxX, maxZ] in world metres; contains(x, z) -> boolean says whether a point is on the lot.
 * heading: the lot's heading byte (LOT p2); spacingDm: bay spacing byte (LOT p1).
 * Returns [{ x, z, yaw }] at bay centres, nose towards the aisle. A bay is kept only if its four corners are on the lot.
 */
export function lotBays(bounds, contains, heading, spacingDm) {
  const bays = [], spacing = spacingDm / 10; if (!(spacing > 0)) return bays;
  const a = heading * Math.PI / 256, c = Math.cos(a), s = Math.sin(a);
  // pattern-space bounding box of the world rectangle
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity; const q = [0, 0];
  for (const [x, z] of [[bounds[0], bounds[1]], [bounds[2], bounds[1]], [bounds[2], bounds[3]], [bounds[0], bounds[3]]]) {
    patternCoords(x, z, heading, q); u0 = Math.min(u0, q[0]); u1 = Math.max(u1, q[0]); v0 = Math.min(v0, q[1]); v1 = Math.max(v1, q[1]);
  }
  const toWorld = (u, v) => [u * c + v * s, -u * s + v * c];
  const half = LOT.BAY_DEPTH / 2, hw = spacing / 2 - 0.12;
  for (let m = Math.floor(u0 / LOT.MODULE) - 1; m <= Math.ceil(u1 / LOT.MODULE); m++) {
    for (let k = Math.floor(v0 / spacing) - 1; k <= Math.ceil(v1 / spacing); k++) {
      for (const row of [0, 1]) {
        const u = m * LOT.MODULE + (row ? LOT.MODULE - half : half), v = (k + 0.5) * spacing;
        let inside = true;
        for (const [du, dv] of [[-half, -hw], [half, -hw], [half, hw], [-half, hw]]) { const w = toWorld(u + du, v + dv); if (!contains(w[0], w[1])) { inside = false; break; } }
        if (!inside) continue;
        const w = toWorld(u, v);
        // nose towards the aisle: +u for the first row of a module, -u for the second. Forward (sin yaw, cos yaw) = +-(c, -s).
        bays.push({ x: w[0], z: w[1], yaw: row ? Math.atan2(-c, s) : Math.atan2(c, -s) });
      }
    }
  }
  return bays;
}
