// The alloy wheel, a three-piece racing wheel of the period: a mirror-polished outer lip (at the rear a deep barrel),
// a satin cast centre of five broad spokes bolted to it by a circle of small bolts, five nuts round a small cap, the
// unpainted barrel behind, a valve and a balance weight.
//
// The centre is a height field over the wheel's plane (design.js `face`, crowned across each spoke). It is meshed in
// five "cells": the piece of metal between one opening and the outline that encloses it (the middles of the two
// spokes beside it, the hub and the bolt ring). Rays from the middle of the opening to the points of that outline
// carry rings of vertices, so the opening's edge is one smooth curve with a real fillet on the face and on the back,
// the spokes flow into the hub and the ring as a casting does, and neighbouring cells and the turned rings inside
// and outside meet on shared points. Everything is millimetres until written.

import { VEHICLE } from '../../../core/ids.js';
import { frame, planeFrame, region, ringLoft } from '../kit/solids.js';
import { skin, turn, arcSweep, fillet, MM, TAU } from './skin.js';
import { COLOUR, spokeCover } from './design.js';

/** RIM p2: how the metal was finished (ARCHITECTURE 5.4). */
export const FINISH = { CAST: 0, TURNED: 1, SMOOTH: 2, SMEARED: 3 };
// [roughness, metalness] bytes: the satin centre, the mirror lip, the raw barrel, plated fasteners
const SATIN = [105, 120], MIRROR = [24, 255], RAW = [150, 235], PLATED = [40, 255];

const lerp = (a, b, t) => a + (b - a) * t;
const polar = (r, a) => [r * Math.cos(a), r * Math.sin(a)];
const unit = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };

export function rimMetal(mb, colour, [rough, metal], finish, occlusion = 1) {
  mb.material(VEHICLE.RIM, rough, metal, finish); mb.color(colour); mb.occlusion(occlusion);
}

/**
 * The centre's outer face: (y, z) -> [x, nx, ny, nz]. The height follows design `face` by radius, less a crown that
 * lets each spoke fall away from its middle line towards its edges; the crown fades out into the hub and the ring.
 */
export function faceSurface(d) {
  const S = d.spoke, pitch = TAU / S.count, r0 = d.hub.radius, r1 = d.ring.inner;
  const ramp = (t) => { const u = Math.min(1, Math.max(0, t)); return u * u * (3 - 2 * u); };
  const height = (y, z) => {
    const r = Math.hypot(y, z);
    let da = Math.atan2(z, y) - S.angle0; da -= Math.round(da / pitch) * pitch;
    const t = Math.min(2, r * Math.abs(Math.sin(da)) / S.halfWidth(r)), fall = t < 1 ? t * t : 2 - (2 - t) * (2 - t);
    return d.face(r) - S.crown * fall * ramp((r - r0) / 22) * ramp((r1 - r) / 22);
  };
  const h = 0.05;
  return (y, z) => {
    const n = unit([1, -(height(y + h, z) - height(y - h, z)) / (2 * h), -(height(y, z + h) - height(y, z - h)) / (2 * h)]);
    return [height(y, z), n[0], n[1], n[2]];
  };
}

/** Prepared vertex with the rim's uv (radius in metres, turn about the axle counted continuously from `ref`). */
function vert(x, y, z, n, ref, occlusion) {
  let da = Math.atan2(z, y) - ref; while (da > Math.PI) da -= TAU; while (da < -Math.PI) da += TAU;
  return [x, y, z, n[0], n[1], n[2], Math.hypot(y, z) * MM, (ref + da) / TAU, occlusion];
}

/**
 * Outline of the sector of one opening about direction phi, between the hub and the ring, counter-clockwise seen
 * from outside the car: the outer arc, the middle line of the spoke at phi + half a pitch inwards, the inner arc
 * back, the middle line of the other spoke outwards. `per` divisions on each arc, `sides` on each side, so that
 * neighbouring sectors share their points.
 */
function sector(phi, half, per, sides, inner, outer) {
  const pts = [], aL = phi + half, aR = phi - half;
  for (let j = 0; j <= per; j++) pts.push(polar(outer, aR + 2 * half * j / per));
  for (let j = 1; j < sides; j++) pts.push(polar(lerp(outer, inner, j / sides), aL));
  for (let j = per; j >= 0; j--) pts.push(polar(inner, aR + 2 * half * j / per));
  for (let j = sides - 1; j >= 1; j--) pts.push(polar(lerp(outer, inner, j / sides), aR));
  return pts;
}

/**
 * The edge of the opening about direction phi where each ray from its middle c to a point of `outline` crosses it:
 * [y, z, ny, nz] with n the unit normal in the wheel's plane pointing into the metal. The opening is the set of
 * points further than its corner radius from none of four limits (the hub side, the ring side and the flanks of
 * the two spokes), which rounds its four corners.
 */
function openingEdge(d, phi, c, outline) {
  const S = d.spoke, O = d.opening, half = Math.PI / S.count;
  // how far outside the opening a point is (negative inside): the limits are drawn in by the corner radius, and
  // the distance to what is left is compared with that radius
  const outside = (y, z) => {
    const r = Math.hypot(y, z), a = Math.atan2(z, y) - phi, k = O.corner(r), w = S.halfWidth(r) + k;
    const lim = [O.inner + k - r, r - (O.outer - k), w - r * Math.sin(half - a), w - r * Math.sin(half + a)];
    let far = 0, near = -Infinity;
    for (const v of lim) { if (v > 0) far += v * v; near = Math.max(near, v); }
    return (far > 0 ? Math.sqrt(far) : near) - k;
  };
  return outline.map(([py, pz]) => {
    const dy = py - c[0], dz = pz - c[1];
    let lo = 0, hi = 1;
    for (let k = 0; k < 40; k++) { const m = (lo + hi) / 2; if (outside(c[0] + dy * m, c[1] + dz * m) < 0) lo = m; else hi = m; }
    const y = c[0] + dy * lo, z = c[1] + dz * lo, h = 0.02;
    const gy = outside(y + h, z) - outside(y - h, z), gz = outside(y, z + h) - outside(y, z - h), l = Math.hypot(gy, gz) || 1;
    return [y, z, gy / l, gz / l];
  });
}

/** One of the five openings with the metal round it: back face, wall, filleted edge and face out to the cell's outline. */
function openingCell(mb, d, q, k, S) {
  const P = d.spoke, half = Math.PI / P.count, phi = P.angle0 + half + k * TAU / P.count, c = polar(d.opening.centre, phi);
  const outline = sector(phi, half, q.per, q.sides, d.hub.radius, d.ring.inner), edge = openingEdge(d, phi, c, outline);
  const rf = P.edge, rb = P.backEdge, rows = [];
  // a point of the cell at (y, z); side +1 on the face, -1 on the back; alpha runs from 0 on the face to 90 degrees
  // in the wall of the opening; `step` is how far the fillet has sunk below the face there
  const point = (i, [y, z], side, alpha, step, occlusion) => {
    const s = S(y, z), e = edge[i], ca = Math.cos(alpha), sa = Math.sin(alpha);
    const x = side > 0 ? s[0] - step : s[0] - P.thickness(Math.hypot(y, z)) + step;
    return vert(x, y, z, unit([side * ca * s[1], side * ca * s[2] - sa * e[2], side * ca * s[3] - sa * e[3]]), phi, occlusion);
  };
  const into = (i, t) => [edge[i][0] + edge[i][2] * t, edge[i][1] + edge[i][3] * t];             // t mm into the metal from the edge
  const row = (fn) => outline.map((_, i) => fn(i));
  rows.push(row((i) => point(i, outline[i], -1, 0, 0, 0.45)));
  rows.push(row((i) => point(i, into(i, rb), -1, 0, 0, 0.45)));
  for (let j = 1; j <= q.backFillet; j++) { const a = j / q.backFillet * Math.PI / 2; rows.push(row((i) => point(i, into(i, rb * (1 - Math.sin(a))), -1, a, rb * (1 - Math.cos(a)), 0.55))); }
  for (let j = q.fillet; j >= 0; j--) { const a = j / q.fillet * Math.PI / 2; rows.push(row((i) => point(i, into(i, rf * (1 - Math.sin(a))), 1, a, rf * (1 - Math.cos(a)), lerp(1, 0.88, j / q.fillet)))); }
  for (let j = 1; j <= q.rings; j++) {
    const t = Math.pow(j / q.rings, 1.25);
    rows.push(row((i) => { const p = into(i, rf); return point(i, [lerp(p[0], outline[i][0], t), lerp(p[1], outline[i][1], t)], 1, 0, 0, 1); }));
  }
  skin(mb, rows, { closed: true, flip: true });
}

/**
 * A flanged hexagon nut with its chamfered crown, standing on the local origin along +X, and the end of the stud in
 * it. af: across the flats; h: height.
 */
export function nut(mb, m, af = 19, h = 15) {
  const a = af / 2, top = a * 0.93, slope = Math.tan(30 * Math.PI / 180), flange = 2.2, per = 4;
  rimMetal(mb, COLOUR.steel, PLATED, FINISH.SMOOTH, 0.85);
  turn(mb, fillet([[0, a + 3.2], [flange, a + 3.2], [flange, a - 0.5]], [0, 0.8, 0], 2), { segs: 18, m });
  for (let f = 0; f < 6; f++) {
    const mid = f * TAU / 6, ny = Math.cos(mid), nz = Math.sin(mid), foot = [], crown = [], edge = [], lid = [], bore = [];
    for (let s = 0; s <= per; s++) {
      const t = (s / per - 0.5) * TAU / 6, ang = mid + t, rho = a / Math.cos(t), ht = h - (rho - top) * slope, c = Math.cos(ang), sn = Math.sin(ang);
      foot.push([flange, rho * c, rho * sn, 0, ny, nz]); crown.push([ht, rho * c, rho * sn, 0, ny, nz]);
      edge.push([ht, rho * c, rho * sn, 0.866, 0.5 * c, 0.5 * sn]); lid.push([h, top * c, top * sn, 0.866, 0.5 * c, 0.5 * sn]);
      bore.push([h, 6.2 * c, 6.2 * sn, 1, 0, 0]);
    }
    skin(mb, [foot, crown], { m }); skin(mb, [edge, lid], { m });
    skin(mb, [lid.map((p) => [p[0], p[1], p[2], 1, 0, 0]), bore], { m });
  }
  // the stud: a turned end with a centre dimple, just proud of the nut
  turn(mb, [[h, 6.2], [h + 1.4, 6.2], [h + 2.4, 5.2], [h + 2.4, 2], [h + 1.6, 0]], { segs: 12, m, crease: 30 });
}

/** One of the small bolts that clamp the centre to the lip: a hexagon head on a washer, standing on the local origin along +X. */
function ringBolt(mb, m, across, height) {
  const rr = across / Math.sqrt(3);
  turn(mb, [[0, rr + 2], [0.8, rr + 2], [0.8, rr - 0.4]], { segs: 10, m });
  turn(mb, [[0.8, rr], [height - 0.8, rr], [height, rr - 1.2], [height, 0]], { segs: 6, m, crease: 25 });
}

/** The Lucera's emblem, a rising chevron over a bar: loops in millimetres on a cap seated at radius 30, [up, across]. */
const EMBLEM = (() => {
  const w = 2.6;
  const chevron = [[2, -11], [10.5, 0], [2, 11], [2 - w * 1.2, 11 - w * 0.2], [10.5 - w * 1.5, 0], [2 - w * 1.2, -11 + w * 0.2]].map(([u, v]) => [u - 1.5, v]);
  const bar = [[-6, -9.5], [-6 + w, -9.5], [-6 + w, 9.5], [-6, 9.5]].map(([u, v]) => [u - 1.5, v]);
  return [chevron, bar];
})();

/**
 * Centre cap: a bright retaining ring round a black dome that carries an emblem in bright relief. It stands on the
 * plane d.hub.face inside the radius d.hub.seat; the emblem's loops are scaled with the dome.
 */
export function centreCap(mb, d, q, emblem = EMBLEM) {
  const xb = d.hub.face, s = d.hub.seat, segs = q.segs;
  const ring = fillet([[xb, s], [xb + 4.5, s - 0.5], [xb + 6.5, s - 4], [xb + 6.5, s - 6.5], [xb + 5.2, s - 7.2]], [0, 1.6, 1.2, 0.6, 0], q.fine ? 3 : 1);
  rimMetal(mb, COLOUR.steel, [28, 255], FINISH.SMOOTH);
  turn(mb, ring, { segs: segs / 2 });
  const r0 = s - 7.2, dome = [[xb + 5.2, r0]], steps = q.fine ? 6 : 3;
  for (let i = 1; i <= steps; i++) { const t = i / steps; dome.push([xb + 5.2 + 3.4 * Math.sin(t * Math.PI / 2), r0 * Math.cos(t * Math.PI / 2)]); }
  mb.material(VEHICLE.TRIM_BLACK, 60, 0); mb.color(COLOUR.black); mb.occlusion(1);
  turn(mb, dome, { segs: Math.max(10, segs / 4) });
  if (!q.fine) return;
  // the emblem on the crown: u is "up" on the cap, v across it
  const plane = planeFrame([(xb + 8.5) * MM, 0, 0], [0, MM, 0], [0, 0, MM]), k = r0 / 22.8;
  rimMetal(mb, COLOUR.steel, [25, 255], FINISH.SMOOTH);
  for (const loop of emblem.map((l) => l.map(([u, v]) => [u * k, v * k]))) {
    region(mb, plane, loop, [], { w: 0.7 });
    ringLoft(mb, plane, loop, [[0.3, -2.2], [0.25, 0.45], [0, 0.7]], { crease: 50 });
  }
}

/**
 * Tyre valve through the rim's barrel at angle a and distance x along the axle: rubber foot, brass stem, knurled
 * black cap, leaning out towards the open side.
 */
export function valve(mb, d, a = d.nutAngle0 + TAU / 5, x = d.xo - 24) {
  const r = d.lip.radiusAt(x), lean = 0.42;
  const radial = [0, Math.cos(a), Math.sin(a)], axis = [Math.sin(lean), -Math.cos(lean) * radial[1], -Math.cos(lean) * radial[2]];
  const m = frame([x * MM, radial[1] * r * MM, radial[2] * r * MM], axis, [1, 0, 0]);
  mb.material(VEHICLE.TRIM_BLACK, 170, 0); mb.color(COLOUR.black); mb.occlusion(0.9);
  turn(mb, fillet([[-1, 7.5], [1.5, 7.5], [3, 5.2], [7, 4.2]], [0, 1, 1.5, 0], 2), { segs: 12, m });
  rimMetal(mb, [0.72, 0.6, 0.36], [70, 255], FINISH.SMOOTH, 0.95);
  turn(mb, [[7, 3.1], [17, 3.1]], { segs: 10, m });
  mb.material(VEHICLE.TRIM_BLACK, 120, 0); mb.color(COLOUR.black); mb.occlusion(1);
  turn(mb, fillet([[16, 4.3], [26, 4.3], [26.5, 0]], [0, 1.6, 0], 3), { segs: 12, m });
}

/** Balance weight: a strip of lead segments stuck inside the barrel behind the centre, glimpsed through the openings. */
export function weights(mb, d) {
  const x = d.xr - d.spoke.thickness(d.ring.inner) - 30, r = d.bore - 0.2, section = [[x, r - 3.6], [x + 14, r - 3.6], [x + 14, r], [x, r]];
  mb.material(VEHICLE.RIM, 150, 200, FINISH.SMOOTH); mb.color(COLOUR.lead); mb.occlusion(0.8);
  const pieces = d.rear ? 5 : 3, each = 15 / r, at = d.rear ? 4.05 : 3.52;
  for (let k = 0; k < pieces; k++) arcSweep(mb, section, at + k * each, at + (k + 0.94) * each, { steps: 2, bevel: 0.8, crease: 30 });
}

/** Quality switches for a level of detail: detail 1 is the showroom wheel, 0.2 the distant one. */
export function rimQuality(detail) {
  const fine = detail >= 0.5, segs = Math.max(20, Math.round(100 * detail / 20) * 20);
  return { fine, segs, per: segs / 5, sides: fine ? 5 : 1, rings: fine ? 3 : 1, fillet: fine ? 3 : 1, backFillet: fine ? 2 : 1, arc: fine ? 3 : 1 };
}

/**
 * The polished lip: the rolled outer flange, the barrel running in to the plane where the centre is bolted on, and
 * the fillet into that plane. Then, in satin, the edge of the centre's ring standing proud of it.
 */
function lipAndRingEdge(mb, d, q) {
  const F = d.flange, L = d.lip, xo = d.xo, xe = xo - 0.7, mid = (t) => { const x = lerp(L.seat, xe, t); return [x, L.radiusAt(x)]; };
  const far = [[xo - 9, F.top - 6], [xo - 8, F.top], [xo, F.top], [xe, L.top], mid(0.5), [L.seat, L.foot], [L.seat, d.ring.outer - 12]];
  const lip = q.fine ? fillet([far[0], far[1], far[2], far[3], mid(0.75), mid(0.5), mid(0.25), far[5], far[6]], [0, 2, 3.6, 3.2, 60, 60, 60, 6, 0], q.arc) : far;
  rimMetal(mb, COLOUR.polished, MIRROR, FINISH.SMOOTH);
  turn(mb, lip, { segs: q.segs });
  rimMetal(mb, COLOUR.alloy, SATIN, FINISH.CAST);
  turn(mb, fillet([[L.seat, d.ring.outer], [d.xr, d.ring.outer], [d.xr, d.ring.outer - 4]], [0, 1.4, 0], q.fine ? 2 : 1).slice(0, -1), { segs: q.segs });
}

/** The flat face of the centre's ring with its circle of bolts. */
function ringFace(mb, d, q) {
  const G = d.ring;
  rimMetal(mb, COLOUR.alloy, SATIN, FINISH.CAST);
  turn(mb, [[d.xr, G.outer - 1.4], [d.xr, G.inner]], { segs: q.segs });
  if (!q.fine) return;
  rimMetal(mb, COLOUR.steel, PLATED, FINISH.SMOOTH, 0.95);
  for (let k = 0; k < G.bolts; k++) {
    const [y, z] = polar(G.pitch, (k + 0.5) / G.bolts * TAU);
    ringBolt(mb, frame([d.xr * MM, y * MM, z * MM], [1, 0, 0], [0, y, z]), G.across, G.height);
  }
}

/** The hub's face between the spokes' roots and the cap, and the five nuts on it. */
function hubFace(mb, d, q) {
  const H = d.hub;
  rimMetal(mb, COLOUR.alloy, SATIN, FINISH.CAST);
  turn(mb, [[H.face, H.radius], [H.face, H.seat - 1]], { segs: q.segs });
  if (!q.fine) return;
  for (let k = 0; k < 5; k++) {
    const [y, z] = polar(H.nutPitch, d.nutAngle0 + k * TAU / 5);
    nut(mb, frame([H.face * MM, y * MM, z * MM], [1, 0, 0], [0, y, z]));
  }
}

/** Behind the centre: the mounting pad, then the bore of the inner barrel out to the inner flange. */
export function barrel(mb, d, q) {
  const F = d.flange, xo = d.xo, back = d.xr - d.spoke.thickness(d.ring.inner);
  rimMetal(mb, COLOUR.barrel, RAW, FINISH.CAST, 0.45);
  turn(mb, [[d.pad, d.hub.seat], [d.pad, d.hub.radius]], { segs: q.segs });
  const bore = fillet([[back, d.ring.inner], [back, d.bore], [-xo + 46, d.bore], [-xo + 30, d.bore + 4], [-xo + 7, d.bore + 4], [-xo + 2.5, F.wallFoot - 2], [-xo, F.wallFoot + 1], [-xo, F.top], [-xo + 8, F.top], [-xo + 9, F.top - 6]], [0, 5, 8, 8, 3, 2.5, 2, 3.4, 2, 0], 1);
  turn(mb, bore, { segs: q.segs / 2, style: (i) => { mb.occlusion(bore[i][0] > -xo + 4 ? 0.5 : 0.75); } });
}

/** The whole alloy wheel (everything of the wheel that is metal and turns), into `mb`. */
export function buildRim(mb, d, detail = 1) {
  const q = rimQuality(detail), S = faceSurface(d);
  lipAndRingEdge(mb, d, q);
  ringFace(mb, d, q);
  rimMetal(mb, COLOUR.alloy, SATIN, FINISH.CAST);
  for (let k = 0; k < d.spoke.count; k++) openingCell(mb, d, q, k, S);
  hubFace(mb, d, q);
  if (q.fine) { valve(mb, d); weights(mb, d); }
  centreCap(mb, d, q);
  barrel(mb, d, q);
}

/**
 * The wheel as it looks turning fast. The lip is a turned surface and does not change. The centre becomes one
 * dished surface whose colour at each point is what a short exposure would record there: on the ring and the hub
 * the metal (with the bolts and nuts run together into bright rings), between them the spokes spread through
 * `BLUR` of a turn, so that five soft lobes still go round with the wheel, over the dark seen through the
 * openings. How much of each point is metal goes into the vertex occlusion for the shader.
 */
const BLUR = 36 * Math.PI / 180;
export function buildRimSmeared(mb, d) {
  const q = { ...rimQuality(0.5), fine: false }, G = d.ring, H = d.hub, segs = q.segs;
  lipAndRingEdge(mb, d, q);
  const through = [0.1, 0.1, 0.105], mix = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
  const band = (r, centre, halfWidth) => Math.max(0, 1 - Math.abs(r - centre) / halfWidth);      // a ring of fasteners, run together
  const radii = [];
  for (let k = 0; k <= 4; k++) radii.push(lerp(G.outer - 1.4, G.inner, k / 4));
  for (let k = 1; k <= 22; k++) radii.push(lerp(G.inner, H.radius, k / 22));
  for (let k = 1; k <= 8; k++) radii.push(lerp(H.radius, H.seat - 1, k / 8));
  const rows = radii.map((r) => {
    const x = d.face(r), slope = (d.face(r + 0.05) - d.face(r - 0.05)) / 0.1, l = Math.hypot(1, slope), n = [1 / l, -slope / l];
    const metal = mix(mix(COLOUR.alloy, COLOUR.steel, 0.45 * band(r, G.pitch, 5)), COLOUR.steel, 0.5 * band(r, H.nutPitch, 12)), row = [];
    for (let j = 0; j <= segs; j++) {
      const a = j / segs * TAU, c = Math.cos(a), sn = Math.sin(a), cover = spokeCover(d, r, a, BLUR), colour = mix(through, metal, cover);
      row.push([x, r * c, r * sn, n[0], n[1] * c, n[1] * sn, r * MM, j / segs, cover, colour[0], colour[1], colour[2]]);
    }
    return row;
  });
  mb.material(VEHICLE.RIM, SATIN[0], SATIN[1], FINISH.SMEARED);
  skin(mb, rows);
  centreCap(mb, d, q);
  barrel(mb, d, q);
}
