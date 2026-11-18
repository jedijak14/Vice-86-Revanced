// One-piece cast and forged road wheels: what the wheels of the other cars share.
//
// A car's own wheels.js describes its wheel as design.js describes the Lucera's (the same names for the same things,
// so that the tyre, the brake and the barrel are the same code for every car) and draws what is its own: the lip,
// the hub and its fasteners, the cap. This file gives it
//
//   wheelSizes     the rim, tyre and brake dimensions that follow from the car's spec WHEEL entry
//   surfaceOf      a height field over the wheel's plane as a surface with normals
//   rounded        a shape with rounded corners from the limits that bound it
//   buildCells     the centre of the wheel: a ring of `count` equal cells, each a window right through the metal
//                  with drafted walls and filleted edges, optionally sunk in a painted valley, optionally swept
//   buildSmearedFace  the same centre as a short exposure records it while the wheel turns
//   hexagon        a chamfered hexagon for nuts of any size
//   wheelBuilders  buildWheel / buildWheelBlur / buildCaliper for a design, with the signatures every car exports
//
// Shapes are drawn in "cell coordinates": radius r from the axle and angle a from the middle of the cell, with the
// sweep taken out (a wheel with swept slots draws straight ones; everything at radius r is then turned by sweep(r)).
// A shape is a function (r, a) that is negative inside, positive outside and close to the distance in millimetres
// from its edge. Millimetres throughout until written.

import { MeshBuilder } from '../../../core/mesh.js';
import { FAMILY, VEHICLE } from '../../../core/ids.js';
import { skin, MM, TAU } from './skin.js';
import { rimQuality, FINISH } from './rim.js';
import { buildTyre } from './tyre.js';
import { buildDisc, buildCorner } from './brake.js';

const DEG = Math.PI / 180;
const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const polar = (r, a) => [r * Math.cos(a), r * Math.sin(a)];
const unit = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
const mix = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

/**
 * What follows from the car's spec WHEEL entry w (track, tyreWidth, tyreRadius, rim and rimWidth in inches, offset,
 * driven, caliperAngle): the fields of a wheel design that the tyre, brake and barrel builders read, less the ones
 * that are the wheel's own shape. `speed` is the speed letter moulded into the size on the sidewall.
 */
export function wheelSizes(w, speed = 'V') {
  const hw = w.tyreWidth / 2, R = w.tyreRadius, bead = w.rim * 12.7;
  // the outer flange's face stands a little inside the tyre's widest point: more on a narrow rim
  const xo = hw - clamp(hw - ((w.rimWidth ?? 0) * 12.7 + 9), 8, 16);
  const aspect = Math.round((R - bead) / w.tyreWidth * 20) * 5;
  return {
    rear: !!w.driven,                                    // the corner behind a driven wheel has a drive shaft and a strut
    hw, R, xo,
    flange: { top: bead + 10, faceIn: bead, wallFoot: bead - 4 },
    bore: bead - 19,                                     // inside radius of the barrel behind the centre
    offset: w.offset || 0,
    caliperAngle: Math.PI / 2 - (w.caliperAngle ?? (w.driven ? 25 : 155)) * DEG,
    size: `${w.tyreWidth}/${aspect} ${speed}R${w.rim}`,
  };
}

/** A height field x = height(y, z) over the wheel's plane as (y, z) -> [x, nx, ny, nz], the normal looking out of the car. */
export function surfaceOf(height) {
  const h = 0.05;
  return (y, z) => {
    const n = unit([1, -(height(y + h, z) - height(y - h, z)) / (2 * h), -(height(y, z + h) - height(y, z - h)) / (2 * h)]);
    return [height(y, z), n[0], n[1], n[2]];
  };
}

/**
 * A shape bounded by several limits, its corners rounded to radius k. limits: for each limit, how far the point
 * stands outside it once the limit has been drawn in by k (negative: inside).
 */
export function rounded(limits, k) {
  let far = 0, near = -Infinity;
  for (const v of limits) { if (v > 0) far += v * v; near = Math.max(near, v); }
  return (far > 0 ? Math.sqrt(far) : near) - k;
}

/** Smooth step from 0 at t <= 0 to 1 at t >= 1. */
export const ramp = (t) => { const u = clamp(t, 0, 1); return u * u * (3 - 2 * u); };

/** Cell coordinates [r, a] of the point (y, z): a is measured from the middle of the cell the point lies in. */
export function inCell(d, y, z) {
  const r = Math.hypot(y, z), pitch = TAU / d.spoke.count;
  let a = Math.atan2(z, y) - d.spoke.angle0 - (d.sweep ? d.sweep(r) : 0);
  a -= (Math.floor(a / pitch) + 0.5) * pitch;
  return [r, a];
}

/**
 * Quality switches for the centre at a level of detail (see rimQuality): `per` points on each of a cell's arcs and
 * `segs` = per x count round the whole wheel, which the turned rings that join the cells inside and outside must
 * use, starting at angle0 + sweep(radius), to meet them point for point.
 */
export function cellQuality(d, detail) {
  const q = rimQuality(detail), count = d.spoke.count, per = Math.max(2, Math.round(q.segs / count));
  return { ...q, per, segs: per * count, sides: q.fine ? d.spoke.sides || 5 : 1 };
}

/** Prepared vertex with the rim's uv (radius in metres, turn about the axle counted continuously from `ref`). */
function vert(x, y, z, n, ref, occlusion, colour) {
  let da = Math.atan2(z, y) - ref; while (da > Math.PI) da -= TAU; while (da < -Math.PI) da += TAU;
  const v = [x, y, z, n[0], n[1], n[2], Math.hypot(y, z) * MM, (ref + da) / TAU, occlusion];
  if (colour) v.push(colour[0], colour[1], colour[2]);
  return v;
}

/**
 * One cell: the metal between a window and the outline that encloses it (the middle lines of the spokes either side,
 * the hub's circle inside and the rim's outside). Rays from the middle of the window to the points of the outline
 * carry rings of vertices: the back face, the back fillet, the wall (leaning in by the draft, as a casting must to
 * leave its mould), the fillet on the face, then with a valley its floor and the step up out of it, and the face out
 * to the outline. Neighbouring cells and the turned rings inside and outside share the outline's points.
 */
function cell(mb, d, q, k, S) {
  const P = d.spoke, O = d.opening, V = d.valley || null, pitch = TAU / P.count, half = pitch / 2, phi = P.angle0 + half + k * pitch;
  const sw = d.sweep || (() => 0), at = (r, a) => polar(r, phi + a + sw(r)), r0 = d.hub.radius, r1 = d.ring.inner;
  const wrap = (a) => a - Math.round(a / TAU) * TAU;
  const local = (y, z) => { const r = Math.hypot(y, z); return [r, wrap(Math.atan2(z, y) - phi - sw(r))]; };
  // the outline, counter-clockwise seen from outside the car: outer arc, down one side, inner arc back, up the other
  const around = [];
  // (the points down the sides are evenly spaced, or at d.spoke.stations: fractions of the way in from the rim)
  const down = q.fine && P.stations ? P.stations : Array.from({ length: q.sides - 1 }, (_, j) => (j + 1) / q.sides);
  for (let j = 0; j <= q.per; j++) around.push([r1, -half + pitch * j / q.per]);
  for (const t of down) around.push([lerp(r1, r0, t), half]);
  for (let j = q.per; j >= 0; j--) around.push([r0, -half + pitch * j / q.per]);
  for (const t of down.slice().reverse()) around.push([lerp(r1, r0, t), -half]);
  const outline = around.map(([r, a]) => at(r, a));
  // where each ray from the middle of the window to the outline crosses the edge of a shape: [y, z, ny, nz, t] with
  // n the unit normal in the plane pointing out of the shape and t the place along the ray; the search starts from
  // `from` (inside the shape). The rays are straight before the sweep, so that a swept window is cut as cleanly as
  // a straight one.
  const c = polar(O.centre, phi);
  const contour = (shape, from) => around.map(([ro, ao], i) => {
    const [py, pz] = polar(ro, phi + ao), dy = py - c[0], dz = pz - c[1];
    let lo = from ? from[i][4] : 0, hi = 1;
    for (let n = 0; n < 40; n++) { const m = (lo + hi) / 2, y = c[0] + dy * m, z = c[1] + dz * m; if (shape(Math.hypot(y, z), wrap(Math.atan2(z, y) - phi)) < 0) lo = m; else hi = m; }
    const fy = c[0] + dy * lo, fz = c[1] + dz * lo, [y, z] = at(Math.hypot(fy, fz), Math.atan2(fz, fy) - phi), h = 0.02, f = (u, v) => shape(...local(u, v));
    const gy = f(y + h, z) - f(y - h, z), gz = f(y, z + h) - f(y, z - h), l = Math.hypot(gy, gz) || 1;
    return [y, z, gy / l, gz / l, lo];
  });
  // a valley that is its window grown by `grow` all round has its bank straight out from the window's edge
  const edge = contour(O.outside, null), grown = V && V.grow ? edge.map((e) => [e[0] + e[2] * V.grow, e[1] + e[3] * V.grow, e[2], e[3], e[4]]) : null;
  const bank = V ? grown || contour(V.outside, edge) : null;
  const rf = P.edge, rb = P.backEdge, draft = P.draft || 0, face = V ? d.colour : null, rows = [];
  // a point of the cell at (y, z); side +1 on the face, -1 on the back; alpha runs from 0 on the face towards the
  // wall of the window; `step` is how far the fillet has sunk below the face there
  const point = (i, [y, z], side, alpha, step, occlusion, colour = face) => {
    const s = S(y, z), e = edge[i], ca = Math.cos(alpha), sa = Math.sin(alpha);
    const x = side > 0 ? s[0] - step : s[0] - P.thickness(Math.hypot(y, z)) + step;
    return vert(x, y, z, unit([side * ca * s[1], side * ca * s[2] - sa * e[2], side * ca * s[3] - sa * e[3]]), phi, occlusion, colour);
  };
  const into = (i, t) => [edge[i][0] + edge[i][2] * t, edge[i][1] + edge[i][3] * t];             // t mm into the metal from the edge
  const row = (fn) => outline.map((_, i) => fn(i));
  // the wall's foot stands into the window by the draft over the wall's height (the distant model's walls are square)
  const lean = edge.map(([y, z]) => (q.fine ? Math.max(0, P.thickness(Math.hypot(y, z)) - rf - rb) * Math.tan(draft) : 0));
  rows.push(row((i) => point(i, outline[i], -1, 0, 0, 0.45)));
  rows.push(row((i) => point(i, into(i, rb - lean[i]), -1, 0, 0, 0.45)));
  for (let j = 1; j <= q.backFillet; j++) { const a = j / q.backFillet * Math.PI / 2; rows.push(row((i) => point(i, into(i, rb * (1 - Math.sin(a)) - lean[i]), -1, a, rb * (1 - Math.cos(a)), 0.55))); }
  const floor = V ? V.colour : face;
  for (let j = q.fillet; j >= 0; j--) { const a = j / q.fillet * (Math.PI / 2 - draft); rows.push(row((i) => point(i, into(i, rf * (1 - Math.sin(a))), 1, a, rf * (1 - Math.cos(a)), lerp(1, 0.88, j / q.fillet), floor))); }
  let start = (i) => into(i, rf);
  if (V) {
    // the valley's floor out to the foot of its bank, then up the bank; the paint ends half way up
    const w = V.width, across = (i, t) => [bank[i][0] + bank[i][2] * w * (t - 0.5), bank[i][1] + bank[i][3] * w * (t - 0.5)];
    const nf = q.fine ? 2 : 1, ns = q.fine ? 4 : 1;
    for (let j = 1; j <= nf; j++) rows.push(row((i) => { const a = into(i, rf), b = across(i, 0); return point(i, [lerp(a[0], b[0], j / nf), lerp(a[1], b[1], j / nf)], 1, 0, 0, 0.9, floor); }));
    for (let j = 1; j <= ns; j++) rows.push(row((i) => point(i, across(i, j / ns), 1, 0, 0, 1, j / ns <= 0.5 ? floor : face)));
    start = (i) => across(i, 1);
  }
  // out to the outline along lines that are straight before the sweep, as the rays were
  const turned = ([y, z], sign) => { const g = sign * sw(Math.hypot(y, z)), cs = Math.cos(g), sn = Math.sin(g); return [y * cs - z * sn, y * sn + z * cs]; };
  for (let j = 1; j <= q.rings; j++) {
    const t = Math.pow(j / q.rings, 1.25);
    rows.push(row((i) => { const p = turned(start(i), -1), o = turned(outline[i], -1); return point(i, turned([lerp(p[0], o[0], t), lerp(p[1], o[1], t)], 1), 1, 0, 0, 1); }));
  }
  skin(mb, rows, { closed: true, flip: true });
}

/**
 * The centre of the wheel between d.hub.radius and d.ring.inner, in the builder's current material. S: the face
 * (see surfaceOf); it must not vary with the angle at those two radii. q: cellQuality.
 * Reads d.spoke { count, angle0, thickness(r), edge, backEdge, draft, sides or stations }, d.opening { centre, outside(r, a) },
 * d.sweep(r) and, for a painted valley round each window, d.valley { outside(r, a), width (of its bank), colour,
 * grow (set when the valley is the window grown by so much all round) } with d.colour the colour of the face (the
 * valley's depth is part of S).
 */
export function buildCells(mb, d, q, S) {
  for (let k = 0; k < d.spoke.count; k++) cell(mb, d, q, k, S);
}

/**
 * The centre as it looks turning fast: one surface of revolution whose colour at each point is what an exposure
 * lasting `blur` radians of the wheel's turn records there (metal, the paint of the valleys, the dark seen through
 * the windows), so that a few broad spokes still go round as soft lobes and many small windows run into a ring.
 * How much of each point is not window goes into the vertex occlusion for the shader. finish: [roughness,
 * metalness] bytes of the metal.
 */
export function buildSmearedFace(mb, d, S, { blur, segs, finish, rows = 30, samples = 12, through = [0.1, 0.1, 0.105] }) {
  const P = d.spoke, O = d.opening, V = d.valley || null, sw = d.sweep || (() => 0), grid = [];
  const middle = (r) => S(...polar(r, P.angle0 + sw(r)))[0];                // the face along the middle of a spoke
  for (let k = 0; k <= rows; k++) {
    const r = lerp(d.ring.inner, d.hub.radius, k / rows), x = middle(r), slope = (middle(r + 0.05) - middle(r - 0.05)) / 0.1, l = Math.hypot(1, slope), row = [];
    for (let j = 0; j <= segs; j++) {
      const a = P.angle0 + sw(r) + j / segs * TAU, c = Math.cos(a), s = Math.sin(a);
      let open = 0, painted = 0;
      for (let n = 0; n < samples; n++) {
        const p = inCell(d, ...polar(r, a + blur * ((n + 0.5) / samples - 0.5)));
        if (O.outside(...p) < 0) open++; else if (V && V.outside(...p) < 0) painted++;
      }
      const cover = 1 - open / samples, colour = mix(mix(d.colour, V ? V.colour : d.colour, painted / Math.max(1, samples - open)), through, 1 - cover);
      row.push([x, r * c, r * s, 1 / l, -slope / l * c, -slope / l * s, r * MM, j / segs, cover, colour[0], colour[1], colour[2]]);
    }
    grid.push(row);
  }
  mb.material(VEHICLE.RIM, finish[0], finish[1], FINISH.SMEARED);
  skin(mb, grid);
}

/**
 * A hexagon nut body standing on the local origin along +X: flats up to a chamfered crown, and a flat top in to
 * the radius `bore`. af: across the flats; h: height; from: where the flats start. In the builder's current material.
 */
export function hexagon(mb, m, af, h, bore, from = 0) {
  const a = af / 2, top = a * 0.93, slope = Math.tan(30 * DEG), per = 4;
  for (let f = 0; f < 6; f++) {
    const mid = f * TAU / 6, ny = Math.cos(mid), nz = Math.sin(mid), foot = [], crown = [], edge = [], lid = [], inner = [];
    for (let s = 0; s <= per; s++) {
      const t = (s / per - 0.5) * TAU / 6, ang = mid + t, rho = a / Math.cos(t), ht = h - (rho - top) * slope, c = Math.cos(ang), sn = Math.sin(ang);
      foot.push([from, rho * c, rho * sn, 0, ny, nz]); crown.push([ht, rho * c, rho * sn, 0, ny, nz]);
      edge.push([ht, rho * c, rho * sn, 0.866, 0.5 * c, 0.5 * sn]); lid.push([h, top * c, top * sn, 0.866, 0.5 * c, 0.5 * sn]);
      inner.push([h, bore * c, bore * sn, 1, 0, 0]);
    }
    skin(mb, [foot, crown], { m }); skin(mb, [edge, lid], { m });
    skin(mb, [lid.map((p) => [p[0], p[1], p[2], 1, 0, 0]), inner], { m });
  }
}

/**
 * The three builders every car exports from its wheels.js, for a wheel given by
 *   design(w, hand)        the wheel's design for spec WHEEL entry w; hand -1 asks for the mirror image of a
 *                          directional wheel, for the right-hand side of the car
 *   rim(mb, d, detail)     everything of the wheel that is metal and turns
 *   smeared(mb, d)         the same as it looks turning fast
 * All are modelled as the car's LEFT wheel in the hub's frame, as hero/wheels.js explains.
 */
export function wheelBuilders({ design, rim, smeared }) {
  const start = () => { const mb = new MeshBuilder(); mb.family(FAMILY.VEHICLE); mb.occlusion(1); return mb; };
  const placed = (mb, d) => (d.offset ? mb.transform([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, d.offset * MM, 0, 0, 1]) : mb).finish();
  return {
    buildWheel(w, detail = 1, hand = 1) {
      const mb = start(), d = design(w, hand);
      rim(mb, d, detail); buildTyre(mb, d, detail); buildDisc(mb, d, detail);
      return placed(mb, d);
    },
    buildWheelBlur(w, hand = 1) {
      const mb = start(), d = design(w, hand);
      smeared(mb, d); buildTyre(mb, d, 0.75, true); buildDisc(mb, d, 0.4);
      return placed(mb, d);
    },
    buildCaliper(w) {
      const mb = start(), d = design(w, 1);
      buildCorner(mb, d);
      return placed(mb, d);
    },
  };
}
