// The tyre: a low-profile radial of the period with a square shoulder, a rim-protector rib, mould rings, raised
// sidewall lettering and a block tread cut by circumferential grooves and raked slots.
//
// The carcass is one turned skin: both sidewalls, and across the tread the floor of the grooves. Every tread block
// then stands on that floor as its own small solid, so grooves and slots have real walls and real depth; the
// shoulder blocks wrap over the shoulder and their slots run out on to the sidewall. The pattern reads the same
// when the wheel is turned round to the other side of the car. Millimetres until written.

import { VEHICLE } from '../../../core/ids.js';
import { turn, fillet, facet, MM, TAU } from './skin.js';
import { COLOUR } from './design.js';
import { strokes, textWidth } from './lettering.js';

const DEG = Math.PI / 180;
const lerp = (a, b, t) => a + (b - a) * t;
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/**
 * The tyre's section. Returns:
 *   tread(s)   point of the tread surface at distance s across from the middle (signed, following the shoulder
 *              round): { x, r, nx, nr, depth } where depth is how deep grooves are cut there
 *   edge       |s| where the tread ends on the shoulder
 *   wall       polyline [[x, r]...] of the outer sidewall from the end of the shoulder down to the bead
 *   side(r)    the outer sidewall at a radius: { x, nx, nr }
 *   v(x, r)    the tyre material's second uv coordinate
 */
export function tyreSection(d) {
  const T = d.tyre, R = d.R, hw = d.hw, sh = T.shoulder, top = d.flange.top, xo = d.xo;
  const tx = hw - sh - 1, slope = 2 * T.crown / tx, l0 = Math.hypot(slope, 1), n0 = [slope / l0, 1 / l0];
  const c = [tx - sh * n0[0], R - T.crown - sh * n0[1]], b0 = Math.atan2(n0[0], n0[1]);     // centre of the shoulder arc
  const bEdge = 60 * DEG, bWall = 84 * DEG, bDeep = 28 * DEG, edge = tx + sh * (bEdge - b0), end = tx + sh * (bWall - b0);
  const tread = (s) => {
    const a = Math.abs(s), g = s < 0 ? -1 : 1;
    if (a <= tx) { const m = 2 * T.crown * a / (tx * tx), l = Math.hypot(m, 1); return { x: s, r: R - T.crown * (a / tx) ** 2, nx: g * m / l, nr: 1 / l, depth: T.depth }; }
    const b = b0 + (a - tx) / sh, depth = T.depth * Math.min(1, Math.max(0, (bEdge - b) / (bEdge - bDeep)));
    return { x: g * (c[0] + sh * Math.sin(b)), r: c[1] + sh * Math.cos(b), nx: g * Math.sin(b), nr: Math.cos(b), depth };
  };
  const E = tread(end), rMid = top + 0.5 * (R - top);
  const wall = fillet([[E.x, E.r], [hw, rMid], [xo + 7, top + 18], [xo + 10.5, top + 12.5], [xo + 10, top + 6], [xo + 0.5, top + 1.5], [xo - 5, top - 2.5]], [0, 70, 5, 2.5, 2.5, 1.5, 0], 3);
  const side = (r) => {
    let i = 0; while (i < wall.length - 2 && wall[i + 1][1] > r) i++;
    const p = wall[i], q = wall[i + 1], t = (r - p[1]) / (q[1] - p[1]), dx = q[0] - p[0], dr = q[1] - p[1], l = Math.hypot(dx, dr);
    return { x: lerp(p[0], q[0], t), nx: -dr / l, nr: dx / l };
  };
  const v = (x, r, s = null) => {
    if (s !== null && Math.abs(s) <= edge) return s / edge;
    const E0 = tread(edge); return (x < 0 ? -1 : 1) * (1 + Math.min(1, Math.max(0, (E0.r - r) / (E0.r - top))));
  };
  return { tread, edge, end, tx, wall, side, v, rMid };
}

/** A raised mould ring on a sidewall polyline at radius r: a small trapezoid rib standing `h` proud. */
function ridge(wall, r, h = 0.9, w = 1.1) {
  let i = 0; while (i < wall.length - 2 && wall[i + 1][1] > r) i++;
  const p = wall[i], q = wall[i + 1], dx = q[0] - p[0], dr = q[1] - p[1], l = Math.hypot(dx, dr), t = [dx / l, dr / l], n = [-t[1], t[0]];
  const k = (r - p[1]) / (q[1] - p[1]), m = [lerp(p[0], q[0], k), r];
  const at = (along, out) => [m[0] + t[0] * along + n[0] * out, m[1] + t[1] * along + n[1] * out];
  return [...wall.slice(0, i + 1), at(-w - 0.5, 0), at(-w * 0.5, h), at(w * 0.5, h), at(w + 0.5, 0), ...wall.slice(i + 1)];
}

/** Quality switches: blocks and lettering are modelled from detail 0.75 up; below that the shader draws them. */
export function tyreQuality(detail) {
  const relief = detail >= 0.75;
  return { relief, segs: Math.max(20, Math.round(80 * detail / 4) * 4), arc: relief ? 3 : 1 };
}

/**
 * One tread block: the strip of tread between the distances across in `stations` (two or more, running outwards
 * from the middle of the tread), spanning `half` either side of angle `centre` at the first station and raked by
 * `rake` radians per millimetre across. Its walls go down into the groove floor with a little draft, as a mould
 * must have; `inner` / `outer` say whether the first / last station stands beside a circumferential groove.
 */
function block(mb, S, stations, centre, half, rake, inner, outer) {
  const s0 = stations[0], draft = 0.9, sink = 0.5, last = stations.length - 1, full = S.tread(0).depth + sink;
  const rows = stations.map((s, k) => {
    const p = S.tread(s), lo = centre - half + rake * (s - s0), hi = centre + half + rake * (s - s0), depth = p.depth > 0 ? p.depth + sink : 0;
    const spread = draft / p.r * depth / full;                                                    // draft of the slot walls, as an angle
    const lean = ((k === 0 && inner ? -1 : 0) + (k === last && outer ? 1 : 0)) * (p.x < 0 ? -1 : 1) * draft * depth / full;
    const at = (a, down, da, dx) => { const x = p.x - p.nx * down + dx, r = p.r - p.nr * down, t = a + da; return [x, r * Math.cos(t), r * Math.sin(t), t / TAU, S.v(x, r, s)]; };
    return { p, lo, hi, depth, top: [at(lo, 0, 0, 0), at(hi, 0, 0, 0)], foot: [at(lo, depth, -spread, lean), at(hi, depth, spread, lean)], normal: (a) => [p.nx, p.nr * Math.cos(a), p.nr * Math.sin(a)] };
  });
  const shade = (j, corners) => { for (let k = 0; k < corners.length; k++) mb.setOcclusion(j + k, corners[k].low ? 0.3 : 0.85); };
  const low = (q) => Object.assign(q.slice(), { low: true });
  for (let k = 0; k < last; k++) {
    const A = rows[k], B = rows[k + 1];
    // top, with the carcass normal at each corner so the block's face follows the crown and the shoulder
    mb.occlusion(1);
    const corners = [[A.top[0], A.normal(A.lo)], [A.top[1], A.normal(A.hi)], [B.top[1], B.normal(B.hi)], [B.top[0], B.normal(B.lo)]];
    const i = mb.count; for (const [q, n] of corners) mb.vertex(q[0] * MM, q[1] * MM, q[2] * MM, n[0], n[1], n[2], q[3], q[4]);
    const g = cross(sub(corners[1][0], corners[0][0]), sub(corners[3][0], corners[0][0])), n = corners[0][1];
    if (g[0] * n[0] + g[1] * n[1] + g[2] * n[2] < 0) mb.quad(i, i + 3, i + 2, i + 1); else mb.quad(i, i + 1, i + 2, i + 3);
    // the two slot walls, running out to nothing where the slot does
    for (const [e, sign] of [[0, -1], [1, 1]]) {
      if (A.depth === 0 && B.depth === 0) continue;
      const a = e ? A.hi : A.lo, wall = [A.top[e], B.top[e]];
      if (B.depth > 0) wall.push(low(B.foot[e])); if (A.depth > 0) wall.push(low(A.foot[e]));
      shade(facet(mb, wall, [0, -Math.sin(a) * sign, Math.cos(a) * sign]), wall);
    }
  }
  // walls on the circumferential grooves
  for (const [row, on, sign] of [[rows[0], inner, -1], [rows[last], outer, 1]]) {
    if (!on || row.depth === 0) continue;
    const wall = [row.top[0], row.top[1], low(row.foot[1]), low(row.foot[0])];
    shade(facet(mb, wall, [sign * (row.p.x < 0 ? -1 : 1), 0, 0]), wall);
  }
}

/** The tread: a continuous centre rib, raked blocks on the ribs beside it, and shoulder blocks that wrap over the shoulder. */
function buildTread(mb, d, S) {
  const T = d.tyre, gw = T.grooveWidth / 2, pitch = TAU / T.pitches, R = d.R, slot = T.slot / R / 2, g = T.grooves, sink = 0.5;
  // centre rib
  const b = g[0] - gw, P = S.tread(b), floor = P.r - T.depth - sink;
  const rib = [[-b - 0.9, floor], [-b, P.r], [0, R], [b, P.r], [b + 0.9, floor]];
  turn(mb, rib, { segs: 96, crease: 50, uv: (x, r, t) => [t, x / S.edge], style: (i) => { mb.occlusion(i === 0 || i === rib.length - 2 ? 0.55 : 1); } });
  // ribs of blocks: [first station, last station, rake in degrees, phase in pitches]
  const ribs = [];
  for (let k = 0; k < g.length - 1; k++) ribs.push({ from: g[k] + gw, to: g[k + 1] - gw, rake: k % 2 ? -30 : 30, phase: k % 2 ? 0.5 : 0, outer: true });
  const last = g[g.length - 1] + gw, bend = [last, S.tx];
  for (let k = 1; k <= 4; k++) bend.push(lerp(S.tx, S.edge, k / 4));
  for (const side of [1, -1]) {
    for (const rib of ribs) {
      const rake = Math.tan(rib.rake * DEG) / R;
      for (let p = 0; p < T.pitches; p++) block(mb, S, [side * rib.from, side * rib.to], (p + rib.phase) * pitch * side, pitch / 2 - slot, rake, true, true);
    }
    const rake = Math.tan(-12 * DEG) / R, phase = g.length % 2 ? 0.5 : 0;
    for (let p = 0; p < T.pitches; p++) block(mb, S, bend.map((s) => side * s), (p + phase) * pitch * side, pitch / 2 - slot * 1.25, rake, true, false);
  }
}

/** Raised lettering on the outer sidewall: the maker's name twice, the size and the construction between. */
function buildLettering(mb, d, S, rc) {
  const T = d.tyre, H = T.capHeight, lift = 1.0;
  const place = (text, at, height) => {
    const width = textWidth(text) * height, k = height, sw = 0.18 * k, tw = 0.105 * k;     // stroke width at its foot and on top
    // glyph space (u to the right, v up, in cap heights) -> the sidewall: up is outwards, reading runs towards -Z at the top
    const map = (u, v, out) => {
      const r = rc + (v - 0.5) * k, a = at - (u * k - width / 2) / rc, s = S.side(r), x = s.x + s.nx * out, rr = r + s.nr * out;
      return [x, rr * Math.cos(a), rr * Math.sin(a), a / TAU, S.v(x, rr)];
    };
    const normal = (u, v) => { const r = rc + (v - 0.5) * k, a = at - (u * k - width / 2) / rc, s = S.side(r); return [s.nx, s.nr * Math.cos(a), s.nr * Math.sin(a)]; };
    for (const line of strokes(text, 5 / k)) {
      // offset lines of the stroke: base and top on both sides
      const n = line.length, off = (dist) => line.map((p, i) => {
        const a = line[Math.max(0, i - 1)], b = line[Math.min(n - 1, i + 1)], tx = b[0] - a[0], ty = b[1] - a[1], l = Math.hypot(tx, ty) || 1;
        const end = i === 0 ? -1 : i === n - 1 ? 1 : 0, along = end * (Math.abs(dist) > tw / 2 ? sw / 2 : tw / 2) / k;
        return [p[0] - ty / l * dist / k + tx / l * along, p[1] + tx / l * dist / k + ty / l * along];
      });
      const lines = [[off(sw / 2), -0.25], [off(tw / 2), lift], [off(-tw / 2), lift], [off(-sw / 2), -0.25]];
      for (let i = 0; i < n - 1; i++) {
        const mid = [(line[i][0] + line[i + 1][0]) / 2, (line[i][1] + line[i + 1][1]) / 2], up = normal(mid[0], mid[1]);
        for (let e = 0; e < 3; e++) {
          const [A, ha] = lines[e], [B, hb] = lines[e + 1];
          const sideways = e === 1 ? up : sub(map(A[i][0], A[i][1], 0), map(B[i][0], B[i][1], 0)).map((x, q) => x * (e === 0 ? 1 : -1) + up[q] * 2);
          facet(mb, [map(A[i][0], A[i][1], ha), map(A[i + 1][0], A[i + 1][1], ha), map(B[i + 1][0], B[i + 1][1], hb), map(B[i][0], B[i][1], hb)], sideways);
        }
      }
      // sloped ends
      for (const i of [0, n - 1]) {
        const j = i ? n - 2 : 1, away = sub(map(line[i][0], line[i][1], 0), map(line[j][0], line[j][1], 0)), up = normal(line[i][0], line[i][1]);
        facet(mb, [0, 1, 2, 3].map((e) => map(lines[e][0][i][0], lines[e][0][i][1], lines[e][1])), [away[0] + up[0] * 4, away[1] + up[1] * 4, away[2] + up[2] * 4]);
      }
    }
  };
  mb.occlusion(1);
  place(T.brand, 0, H); place(T.brand, Math.PI, H);
  place(T.size, Math.PI / 2, H * 0.62); place(T.line, -Math.PI / 2, H * 0.62);
}

/**
 * The whole tyre into `mb`. `smeared` builds the tyre as it looks turning fast: the circumferential grooves and the
 * mould rings stay, the slots and the lettering have run together.
 */
export function buildTyre(mb, d, detail = 1, smeared = false) {
  const q = tyreQuality(detail), S = tyreSection(d), T = d.tyre, segs = q.segs;
  mb.material(VEHICLE.TYRE, q.relief ? 1 : 0, 0, 0); mb.color(COLOUR.rubber); mb.occlusion(1);
  // lettering band on the outer sidewall, between two mould rings
  const E = S.tread(S.end), rc = lerp(d.flange.top + 20, E.r, 0.5), half = T.capHeight / 2 + 4.5;
  let outer = S.wall;
  if (q.relief) { outer = ridge(outer, rc + half); outer = ridge(outer, rc - half); outer = ridge(outer, d.flange.top + 15.5, 0.6, 0.8); }
  const inner = S.wall.filter((p, i) => i % 3 === 0 || i === S.wall.length - 1).map(([x, r]) => [-x, r]).reverse();
  // across the tread: the groove floor where blocks will stand on it, otherwise the tread surface itself, which the
  // smeared tyre cuts with its grooves and the distant tyre leaves to the shader
  const across = [], stations = [];
  if (smeared) {
    const gw = T.grooveWidth / 2, cut = (s, deep) => { const p = S.tread(s), down = deep ? T.depth : 0; return [p.x - p.nx * down, p.r - p.nr * down, s, deep ? 0.3 : 0.86]; };
    const halfTread = [cut(0, false)];
    for (const g of T.grooves) halfTread.push(cut(g - gw, false), cut(g - gw + 0.9, true), cut(g + gw - 0.9, true), cut(g + gw, false));
    for (let k = 0; k <= 8; k++) halfTread.push(cut(lerp(S.tx, S.end, k / 8), false));
    across.push(...halfTread.slice(1).reverse().map(([x, r, s, o]) => [-x, r, -s, o]), ...halfTread);
  } else {
    stations.push(0, S.tx / 2, S.tx);
    const arcSteps = q.relief ? 6 : 4; for (let k = 1; k <= arcSteps; k++) stations.push(lerp(S.tx, S.end, k / arcSteps));
    for (const s of [...stations.slice(1).reverse().map((x) => -x), ...stations]) { const p = S.tread(s), depth = q.relief ? p.depth : 0; across.push([p.x - p.nx * depth, p.r - p.nr * depth, s, q.relief && Math.abs(s) < S.edge ? 0.3 : 1]); }
  }
  const profile = [...inner.slice(0, -1).map(([x, r]) => [x, r, null, 1]), ...across, ...outer.slice(1).map(([x, r]) => [x, r, null, 1])];
  turn(mb, profile, {
    segs, crease: 42,
    uv: (x, r, t, i) => [t, S.v(x, r, profile[i][2])],
    style: (i) => { mb.occlusion(Math.min(profile[i][3], profile[i + 1][3])); },
  });
  if (!q.relief || smeared) return;
  buildTread(mb, d, S);
  buildLettering(mb, d, S, rc);
}
