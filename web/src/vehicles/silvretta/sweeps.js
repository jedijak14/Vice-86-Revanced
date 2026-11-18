// Sweeps: parts whose one section runs along a line in plan (bumpers, the valances under them, the lamp band).
// The line is a C2 curve, so a reflection crosses a bumper's corner without a break; the section is authored in
// (o, y): o the distance outward from the line, y the height, both in drawing millimetres.

import { patch, polygon } from '../hero/kit/solids.js';
import { toCar } from './spec.js';

/**
 * A plan curve from a control polygon [[x, z]...] that starts on the centre line (z = 0) and runs outward: a uniform
 * cubic B-spline, mirrored at the start so that it crosses the centre line square, ending on the last point.
 * side: +1 when outward is to the left of the direction of travel (the nose), -1 to the right (the tail).
 * Returns { stations(spacing, turn, cuts), atX(x) }: stations are { q: [x, z], n: outward normal, s: distance along };
 * a station is placed every `spacing` mm or `turn` degrees, whichever comes first, and a pair 0.5 mm apart at every
 * distance in `cuts` (where a section may jump).
 */
export function planCurve(ctrl, side = 1) {
  const P = [[ctrl[1][0], -ctrl[1][1]], ...ctrl, [2 * ctrl[ctrl.length - 1][0] - ctrl[ctrl.length - 2][0], 2 * ctrl[ctrl.length - 1][1] - ctrl[ctrl.length - 2][1]]];
  const fine = [], STEPS = 24;
  for (let i = 0; i + 3 < P.length; i++) for (let k = 0; k < (i + 4 === P.length ? STEPS + 1 : STEPS); k++) {
    const t = k / STEPS, t2 = t * t, t3 = t2 * t, w = [(1 - 3 * t + 3 * t2 - t3) / 6, (4 - 6 * t2 + 3 * t3) / 6, (1 + 3 * t + 3 * t2 - 3 * t3) / 6, t3 / 6];
    const d = [(-1 + 2 * t - t2) / 2, (-4 * t + 3 * t2) / 2, (1 + 2 * t - 3 * t2) / 2, t2 / 2];
    let x = 0, z = 0, dx = 0, dz = 0;
    for (let j = 0; j < 4; j++) { x += w[j] * P[i + j][0]; z += w[j] * P[i + j][1]; dx += d[j] * P[i + j][0]; dz += d[j] * P[i + j][1]; }
    const l = Math.hypot(dx, dz) || 1;
    fine.push({ q: [x, z], n: [-dz / l * side, dx / l * side], s: 0 });
  }
  fine[0].q[1] = 0; fine[0].n = [fine[0].n[0] < 0 ? -1 : 1, 0];
  for (let i = 1; i < fine.length; i++) fine[i].s = fine[i - 1].s + Math.hypot(fine[i].q[0] - fine[i - 1].q[0], fine[i].q[1] - fine[i - 1].q[1]);
  const length = fine[fine.length - 1].s;
  const mix = (a, b, t, s) => {
    const n = [a.n[0] + (b.n[0] - a.n[0]) * t, a.n[1] + (b.n[1] - a.n[1]) * t], l = Math.hypot(n[0], n[1]);
    return { q: [a.q[0] + (b.q[0] - a.q[0]) * t, a.q[1] + (b.q[1] - a.q[1]) * t], n: [n[0] / l, n[1] / l], s };
  };
  const atS = (s) => {
    let lo = 0, hi = fine.length - 1; while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (fine[mid].s <= s) lo = mid; else hi = mid; }
    return mix(fine[lo], fine[hi], Math.max(0, Math.min(1, (s - fine[lo].s) / (fine[hi].s - fine[lo].s))), s);
  };
  return {
    length, atS,
    /** The station at drawing x on the part of the line that runs along the car's side. */
    atX(x) {
      const end = fine[fine.length - 1];
      if ((end.q[0] - x) * (end.q[0] - fine[fine.length - 2].q[0]) <= 0) return { ...end };
      let i = fine.length - 1; while (i > 1 && (fine[i - 1].q[0] - x) * (fine[i].q[0] - x) > 0) i--;
      const a = fine[i - 1], b = fine[i], t = Math.max(0, Math.min(1, (x - a.q[0]) / (b.q[0] - a.q[0] || 1)));
      return mix(a, b, t, a.s + (b.s - a.s) * t);
    },
    /** Distance along the line at which it reaches lateral position z (on the part that runs across the car). */
    sAtZ(z) { let i = 1; while (i < fine.length - 1 && fine[i].q[1] < z) i++; const a = fine[i - 1], b = fine[i]; return a.s + (b.s - a.s) * Math.max(0, Math.min(1, (z - a.q[1]) / (b.q[1] - a.q[1] || 1))); },
    stations(spacing, turn = 6, cuts = [], s0 = 0, s1 = length) {
      const out = [atS(s0)]; let last = fine[0], heading = Math.atan2(last.n[1], last.n[0]);
      for (const f of fine) {
        if (f.s <= s0 + 1e-6 || f.s >= s1 - 1e-6) continue;
        const h = Math.atan2(f.n[1], f.n[0]);
        if (f.s - out[out.length - 1].s >= spacing || Math.abs(h - heading) * 180 / Math.PI >= turn) { out.push(f); heading = h; }
      }
      out.push(atS(s1));
      const sharp = cuts.filter((c) => c > s0 + 1 && c < s1 - 1), min = Math.min(6, spacing / 3);
      const kept = out.filter((st, i) => i === 0 || i === out.length - 1 || !sharp.some((c) => Math.abs(st.s - c) < min));
      for (const c of sharp) kept.push(atS(c - 0.25), atS(c + 0.25));
      return kept.sort((a, b) => a.s - b.s);
    },
  };
}

/** Points of an arc in the (o, y) plane, angles in degrees. */
export const arcOY = (co, cy, r, a0, a1, n = 3) => { const out = []; for (let i = 0; i <= n; i++) { const a = (a0 + (a1 - a0) * i / n) * Math.PI / 180; out.push([co + Math.cos(a) * r, cy + Math.sin(a) * r]); } return out; };

/** Collects a section: add(points, kind, kindOfLast) appends nodes [o, y, kind]; kind names the strip that starts at the node. */
export function sectionWriter() {
  const nodes = [];
  const add = (pts, kind, last = kind) => { pts.forEach((p, i) => nodes.push([p[0], p[1], i === pts.length - 1 ? last : kind])); return add; };
  add.nodes = nodes;
  return add;
}

/**
 * Sweep a section along stations. sectionAt(station) -> nodes [o, y, kind] (the same number at every station, from
 * the top of the part down its outer face); styles: { kind: () => set the builder's state }, listed from the lightest
 * to the darkest: a strip between two stations takes the darker of their kinds, so a pocket is dark right up to its
 * side walls. side as for planCurve. place(station, o, y) may override where a node goes (drawing mm [x, y, z]).
 * caps: close the first and/or last section with a flat face ('start', 'end'). Returns the grid of points (vehicle metres).
 */
export function sweepSection(mb, stations, sectionAt, styles, { side = 1, crease = 40, caps = ['end'], place = null, capStyle = null } = {}) {
  const kinds = [], rank = Object.fromEntries(Object.keys(styles).map((k, i) => [k, i]));
  const grid = stations.map((st) => {
    const nodes = sectionAt(st); kinds.push(nodes.map((nd) => nd[2]));
    return nodes.map(([o, y]) => { const d = place ? place(st, o, y) : [st.q[0] + st.n[0] * o, y, st.q[1] + st.n[1] * o]; return toCar(d[0], d[1], d[2]); });
  });
  patch(mb, grid, { flip: side > 0, crease, style: (i, j) => { const a = kinds[i][j], b = kinds[i + 1][j]; if (a === 'none' || b === 'none') return false; styles[rank[a] >= rank[b] ? a : b](); return true; } });
  for (const cap of caps) {
    const row = cap === 'start' ? grid[0] : grid[grid.length - 1];
    (capStyle || styles[Object.keys(styles)[0]])();
    // the section runs clockwise seen from outside the end of the part at the nose, counter-clockwise at the tail
    const loop = ((cap === 'end') === (side > 0)) ? row.slice() : row.slice().reverse();
    polygon(mb, loop.filter((p, i, a) => i === 0 || Math.hypot(p[0] - a[i - 1][0], p[1] - a[i - 1][1], p[2] - a[i - 1][2]) > 1e-5));
  }
  return grid;
}

/** A flat polygon wound so that it faces `dir`, whichever way its points run. */
export function facingPolygon(mb, pts, dir) {
  let nx = 0, ny = 0, nz = 0;
  for (let i = 0; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length]; nx += (p[1] - q[1]) * (p[2] + q[2]); ny += (p[2] - q[2]) * (p[0] + q[0]); nz += (p[0] - q[0]) * (p[1] + q[1]); }
  polygon(mb, nx * dir[0] + ny * dir[1] + nz * dir[2] < 0 ? pts.slice().reverse() : pts);
}
