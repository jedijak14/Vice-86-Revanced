// Ironwork set into the road: manhole covers, a gutter grate and a kerb inlet (design/ROAD_STANDARD.md point 6).
//
// These are instances laid on top of the road mesh, which cannot be cut open for them. So nothing here is sunk:
// each casting stands 4 to 15 mm proud inside a collar that ramps up to it from the surface, the cover sits 4 mm
// down inside its frame and the relief stands back up to the frame's level. Openings are matt black floors between
// real bars, which is all a slot shows from standing or driving height.
// No visible surface is closer than 4 mm to the road: the depth buffer separates that out to about 110 m, which is
// where the last level of detail ends.
//
// Placement (all: y = 0 is the carriageway level, collider none, they are driven over):
//   manhole_a, manhole_b   origin at the centre of the cover, on flat carriageway outside the gutter pan; any yaw
//   drain_grate            origin on the kerb face line; the grate lies in the gutter pan towards +Z
//   gutter_inlet           origin on the kerb face line, +Z towards the carriageway; the opening stands in front of
//                          the kerb face and the slab with its lid lies over the kerb and the pavement behind
//                          (z < 0), so it needs the standard kerb. A drain_grate at the same origin makes a
//                          combination inlet.
// The kerbside two follow the near-tile kerb section: a gutter pan LANE.GUTTER wide that falls PAN_DISH towards the
// kerb face, and a kerb KERB_HEIGHT high. They therefore dip below y = 0 by up to PAN_DISH at the kerb.

import { KERB_HEIGHT, LANE } from '../roads/lanes.js';
import { hash01 } from '../../core/math.js';
import { C } from './common.js';

const PAN_DISH = 0.015;                               // depth of the gutter pan at the kerb face (the tile mesher's figure)
const pan = (z) => -PAN_DISH * Math.min(1, Math.max(0, 1 - z / LANE.GUTTER));

// cast iron: brown-black and scaly in the recesses, worn to bright metal where tyres and soles polish it
const IRON_LOW = [0.075, 0.062, 0.052], IRON_FACE = [0.2, 0.18, 0.165], IRON_TOP = [0.62, 0.59, 0.55], IRON_FAR = [0.17, 0.155, 0.145];
const ironLow = (k) => k.steel(IRON_LOW, 0.75, 0.7);
const ironFace = (k) => k.steel(IRON_FACE, 0.5, 0.55);
const ironTop = (k, shade = 1) => k.bare(0, 0.4, [IRON_TOP[0] * shade, IRON_TOP[1] * shade, IRON_TOP[2] * shade]);
const PATCH = [0.13, 0.13, 0.135];                    // the newer asphalt a cover is set in
const RISE = 0.004;                                   // relief height, and how far a cover sits below its frame

/**
 * Raised relief with sloping cast sides: a rectangle of half-size (a, b) along the unit direction (ux, uz) and
 * across it, standing from y0 to y1. Sides are the dull casting, the top is the worn metal (no two worn alike).
 */
function stud(k, cx, cz, ux, uz, a, b, y0, y1, draft = 0.004) {
  const at = (s, t, y) => [cx + s * ux - t * uz, y, cz + s * uz + t * ux];
  const ring = (y, d) => [at(-a + d, b - d, y), at(a - d, b - d, y), at(a - d, -b + d, y), at(-a + d, -b + d, y)];
  const low = ring(y0, 0), top = ring(y1, Math.min(draft, a * 0.6, b * 0.6));
  ironLow(k).occ(0.75);
  for (let i = 0; i < 4; i++) k.quad(low[i], low[(i + 1) % 4], top[(i + 1) % 4], top[i]);
  ironTop(k, 0.8 + 0.4 * hash01(Math.round(cx * 997), Math.round(cz * 991))).occ(1); k.quad(top[0], top[1], top[2], top[3]);
}

/**
 * Round cast-iron cover in its frame at `c` (centre, on the surface it is set into). r: radius of the cover itself.
 * pattern: 'radial' (sewer cover: outer band, spokes, a waffle in the middle) or 'waffle' (utility cover: square
 * studs all over). collar: width of the asphalt patch ramping up to the frame (0 when set in a slab).
 */
function ironCover(k, c, r, pattern, collar) {
  // in the road the frame stands on its collar; in a slab, which is ours to shape, it only needs to clear the concrete
  const [cx, y, cz] = c, n = k.n(collar > 0 ? 36 : 28, 12), up = [0, 1, 0], h = collar > 0 ? 0.011 : 0.005, top = h + RISE, frame = r * 1.26;
  if (collar > 0) {
    // the patch was cut by hand: its edge wanders. A hair proud at the rim so it never fights the road, with a skirt down.
    k.concrete(PATCH, 0, 0.75);
    const edge = [], rim = [], seat = [];
    for (let j = 0; j < n; j++) {
      const a = -j / n * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a), wobble = 0.55 + 0.9 * hash01(j >> 1, 71) * hash01(j >> 2, 13);
      const ro = frame + collar * wobble;
      edge.push([cx + ca * ro, y, cz + sa * ro]); rim.push([cx + ca * ro, y + RISE, cz + sa * ro]); seat.push([cx + ca * frame, y + h, cz + sa * frame]);
    }
    k.loft([edge, rim, seat], { closed: true, crease: 50 });
  }
  if (!k.near) {
    // one tone for frame and cover, a darker seam between them
    k.steel(IRON_FAR, 0.6, 0.45); k.lathe(c, up, [[collar > 0 ? h : 0, frame], [top, frame - 0.01], [top, r * 1.03]], n);
    k.occ(0.4); k.lathe(c, up, [[top, r * 1.03], [h, r * 0.99]], n);
    k.occ(0.85); k.lathe(c, up, [[h + 0.002, r * 0.99], [h + 0.002, 0]], n);
    return;
  }
  // frame: bevelled outside, a seat worn bright along its inner edge, then the groove the cover drops into
  ironLow(k); k.lathe(c, up, [[collar > 0 ? h : 0, frame], [top, frame - 0.01]], n);
  ironFace(k); k.lathe(c, up, [[top, frame - 0.01], [top, r * 1.09]], n);
  ironTop(k); k.lathe(c, up, [[top, r * 1.09], [top, r * 1.035]], n);
  ironLow(k).occ(0.25); k.lathe(c, up, [[top, r * 1.035], [h - 0.004, r * 1.015], [h - 0.004, r * 1.0], [h, r * 0.985]], n, { crease: 20 });
  ironLow(k).occ(0.7); k.lathe(c, up, [[h, r * 0.985], [h, 0]], n);

  const ring = (ra, rb) => {                          // a raised band between two radii
    ironLow(k).occ(0.75); k.lathe(c, up, [[h, rb], [top, rb - 0.004]], n);
    ironTop(k).occ(1); k.lathe(c, up, [[top, rb - 0.004], [top, ra + 0.004]], n);
    ironLow(k).occ(0.75); k.lathe(c, up, [[top, ra + 0.004], [h, ra]], n);
  };
  const grid = (count, pitch, size, within) => {
    for (let i = 0; i < count; i++) for (let j = 0; j < count; j++) {
      const x = (i - (count - 1) / 2) * pitch, z = (j - (count - 1) / 2) * pitch;
      if (Math.hypot(Math.abs(x) + size / 2, Math.abs(z) + size / 2) < within) stud(k, cx + x, cz + z, 1, 0, size / 2, size / 2, y + h, y + top);
    }
  };
  if (pattern === 'radial') {
    ring(r * 0.85, r * 0.94);
    const spokes = 16;
    for (let i = 0; i < spokes; i++) { const a = (i + 0.5) / spokes * Math.PI * 2, ux = Math.cos(a), uz = Math.sin(a), m = r * 0.615; stud(k, cx + ux * m, cz + uz * m, ux, uz, r * 0.165, r * 0.04, y + h, y + top); }
    grid(3, r * 0.2, r * 0.14, r);
  } else {
    ring(r * 0.88, r * 0.95);
    const pitch = r * 0.235; grid(7, pitch, pitch * 0.68, r * 0.86);
  }
  // two pick holes: slots a hook goes into
  k.paint(C.black, 0.95, 0).occ(0.05);
  for (const s of [-1, 1]) { const x = cx + s * r * (pattern === 'radial' ? 0.3 : 0.235 * 1.5), z = cz, a = 0.016, b = 0.006, yy = y + h + 0.0006; k.quad([x - a, yy, z + b], [x + a, yy, z + b], [x + a, yy, z - b], [x - a, yy, z - b]); }
}

const manhole = (pattern) => (k) => ironCover(k, [0, 0, 0], 0.3, pattern, 0.085);

/** Rectangular frame (a hollow, bevelled casting) from y0 to y1 around the hole [x0, x1] x [z0, z1], bar width w. */
function ironFrame(k, x0, z0, x1, z1, w, y0, y1, floorY, bevel = 0.012) {
  const ring = (d, y) => [[x0 - d, y, z1 + d], [x1 + d, y, z1 + d], [x1 + d, y, z0 - d], [x0 - d, y, z0 - d]];
  const foot = ring(w + bevel, y0), outer = ring(w, y1), inner = ring(0.004, y1), floor = ring(0, floorY);
  const band = (a, b) => { for (let i = 0; i < 4; i++) k.quad(a[i], a[(i + 1) % 4], b[(i + 1) % 4], b[i]); };
  ironLow(k); band(foot, outer);
  (k.near ? ironFace(k) : k.steel(IRON_FAR, 0.6, 0.45)); band(outer, inner);
  ironLow(k).occ(0.3); band(inner, floor);
  k.paint(C.black, 1, 0).occ(0.04); k.quad(floor[0], floor[1], floor[2], floor[3]);
}

/** Gutter grate: bars along the kerb, as American grates of the time had them, tied by two cross bars. */
function grate(k) {
  const x0 = -0.42, x1 = 0.42, z0 = 0.056, z1 = z0 + 0.335, floorY = 0.004, top = 0.014, m = k.mark();
  ironFrame(k, x0, z0, x1, z1, 0.035, 0, top, floorY, 0.008);
  const bars = 7, bar = 0.02, slot = (z1 - z0 - bars * bar) / (bars + 1);
  if (k.near) {
    for (let i = 0; i < bars; i++) stud(k, 0, z0 + slot + bar / 2 + i * (slot + bar), 1, 0, (x1 - x0) / 2, bar / 2, floorY, top - 0.001, 0.003);
    for (const x of [-0.14, 0.14]) stud(k, x, (z0 + z1) / 2, 0, 1, (z1 - z0) / 2, 0.013, floorY, top - 0.003, 0.003);
  } else {
    // from a distance the bars and slots average to dark iron stripes: three wide bars keep the grate legible
    k.steel(IRON_FAR, 0.6, 0.45);
    for (let i = 0; i < 3; i++) { const z = z0 + (i + 0.5) * (z1 - z0) / 3, b = 0.034; k.quad([x0, top - 0.001, z + b], [x1, top - 0.001, z + b], [x1, top - 0.001, z - b], [x0, top - 0.001, z - b]); }
  }
  k.settle(m, (x, z) => pan(z));
}

/** Kerb-opening inlet: a concrete top slab with a round lid, the dark throat under its steel-edged lip, a stained apron. */
function inlet(k) {
  const half = 0.6, pier = 0.2, wide = half + pier, lip = 0.035, slabTop = KERB_HEIGHT + 0.01, soffit = KERB_HEIGHT - 0.035, back = -0.62;
  // apron on the gutter pan: silt and oil collect where the water turns in. Split along the kerb and across, so the
  // stain can be dark at the throat and gone by the lane.
  const m = k.mark(), ax = wide + 0.08, az = LANE.GUTTER - 0.012;
  k.concrete([0.6, 0.6, 0.59], 0, 0.55);
  const xs = [-ax, -half, -half * 0.45, half * 0.45, half, ax], zs = [0.004, az * 0.45, az];
  for (let i = 0; i < xs.length - 1; i++) for (let j = 0; j < zs.length - 1; j++) k.quad([xs[i], 0.005, zs[j + 1]], [xs[i + 1], 0.005, zs[j + 1]], [xs[i + 1], 0.005, zs[j]], [xs[i], 0.005, zs[j]]);
  k.quad([-ax - 0.02, 0, az + 0.02], [ax + 0.02, 0, az + 0.02], [ax, 0.005, az], [-ax, 0.005, az]);
  for (const s of [-1, 1]) { const a = [s * (ax + 0.02), 0, az + 0.02], b = [s * (ax + 0.02), 0, 0.004], c = [s * ax, 0.005, 0.004], d = [s * ax, 0.005, az]; if (s > 0) k.quad(a, b, c, d); else k.quad(b, a, d, c); }
  k.grime(m, (x, y, z) => Math.min(0.9, 1.3 * Math.max(0, 1 - Math.abs(x) / (half + 0.25)) * Math.max(0, 1 - z / 0.42)), [0.06, 0.055, 0.045]);
  k.settle(m, (x, z) => pan(z));

  // throat: black, standing just in front of the kerb face it replaces
  k.paint(C.black, 1, 0).occ(0.03);
  k.box(-half, 0.004 - PAN_DISH, 0.001, half, soffit, 0.006, { r: 0 });      // a slab, not a sheet: nothing behind it under the lid
  // piers either side and the slab over them; the lip overhangs the throat and shades it
  const s = k.mark();
  k.concrete([0.7, 0.7, 0.69], 0, 0.45);
  for (const sx of [-1, 1]) k.box(Math.min(sx * half, sx * (wide - 0.006)), -PAN_DISH - 0.005, -0.03, Math.max(sx * half, sx * (wide - 0.006)), soffit + 0.012, lip - 0.004, { capA: false, capB: false });   // ends inside the slab
  k.box(-wide, soffit, back, wide, slabTop, lip, { r: k.near ? 0.008 : 0, axis: 'x' });
  k.shade(s, (x, y, z) => (z > 0.001 && y < soffit + 0.002 && Math.abs(x) < half ? 0.4 : 1)).grime(s, (x, y, z) => (z > 0 ? 0.45 * Math.max(0, 1 - (y + PAN_DISH) / 0.09) : 0), [0.1, 0.09, 0.08]);
  if (k.near) {
    // steel angle that armours the lip against wheels, rusting through its paint
    k.steel([0.25, 0.23, 0.2], 0.55, 0.75);
    k.box(-wide + 0.01, soffit + 0.006, lip - 0.002, wide - 0.01, slabTop + 0.002, lip + 0.005, { axis: 'x' });
    k.box(-wide + 0.01, slabTop - 0.004, lip - 0.045, wide - 0.01, slabTop + 0.002, lip - 0.002, { axis: 'x' });
    // the bar across the opening that keeps a wheel or a foot out
    k.steel(IRON_LOW, 0.6, 0.7).occ(0.7); k.cyl([-half - 0.01, soffit * 0.5 - PAN_DISH / 2, lip - 0.012], [half + 0.01, soffit * 0.5 - PAN_DISH / 2, lip - 0.012], 0.011, 0.011, 6);
  }
  // access lid in the slab
  ironCover(k, [0, slabTop, back * 0.5 - 0.02], 0.2, 'waffle', 0);
}

const road = (name, build, footprint) => ({ name, build, footprint, collider: null, tags: ['road', 'small'], far: [30, 110] });

export const ROADKIT = [
  road('manhole_a', manhole('radial'), 0.5),
  road('manhole_b', manhole('waffle'), 0.5),
  road('drain_grate', (k) => grate(k), 0.55),
  road('gutter_inlet', inlet, 1.0),
];
