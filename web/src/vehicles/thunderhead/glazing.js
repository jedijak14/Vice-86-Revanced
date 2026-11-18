// Glazing: what every pane of the car needs besides the opening cut for it. The pane itself, sunk under the skin
// with an outer and an inner face; the black border printed on its inside; the lining behind the frame; the return
// that joins the two, so the frame is closed from every side; and the rubber seal round it on the outside.
// All of it is laid out on the sheet the opening was cut from, along the opening's own prepared edge.

import { VEHICLE, GLASS } from '../../core/ids.js';
import { walk } from '../hero/kit/sheet.js';
import { patch } from '../hero/kit/solids.js';

/** Depth of the cabin lining under the skin, how far it reaches behind the frame, and the width of a pane's black border. Metres. */
export const LINING_DEPTH = 0.016, LINING_WIDTH = 0.042, FRIT_WIDTH = 0.028;
/** The lining's colour: a dark grey cloth. */
export const LINING = [0.035, 0.033, 0.03];
/** Glass tints: the laminated screen is lighter than the toughened side and hatch glass. */
export const TINT = { screen: [0.62, 0.74, 0.70], side: [0.50, 0.60, 0.58] };
/** Black trim: the printed border under the glass (gloss) and the rubber of the seals. */
const FRIT = { colour: [0.2, 0.2, 0.205], roughness: 90 }, RUBBER = { colour: [0.21, 0.21, 0.215], roughness: 165 };

/** Edge points closer together than this are taken as one. Metres. */
const MIN_STEP = 0.0004;

/** Point of a sheet at chart (a, b), pushed `depth` metres under the skin. */
export function sunk(sheet, a, b, depth) {
  const p = sheet.pos(a, b, [0, 0, 0]), n = sheet.normal(a, b, [0, 0, 0]);
  return [p[0] - n[0] * depth, p[1] - n[1] * depth, p[2] - n[2] * depth];
}

/** Stations from x0 to x1 about `step` apart, with the listed ones among them. */
export function stations(x0, x1, step, extra = []) {
  const xs = new Set([x0, x1, ...extra.filter((x) => x > x0 && x < x1)]), n = Math.max(1, Math.round((x1 - x0) / step));
  for (let i = 1; i < n; i++) xs.add(x0 + (x1 - x0) * i / n);
  return [...xs].sort((a, b) => a - b);
}

/**
 * A pane: the sheet sampled at the chart stations `as` between two chart edges b = edge0(a) and edge1(a), sunk
 * `depth` under the skin, `thickness` thick. opacity: the glass shader's density, 0..255.
 */
export function pane(glass, sheet, as, edge0, edge1, { depth, thickness, tint, opacity, cols = 8 }) {
  const grid = (d) => as.map((a) => { const b0 = edge0(a), b1 = edge1(a), row = []; for (let j = 0; j <= cols; j++) row.push(sunk(sheet, a, b0 + (b1 - b0) * j / cols, d)); return row; });
  const mid = as[as.length >> 1], out = sheet.normal(mid, (edge0(mid) + edge1(mid)) / 2, [0, 0, 0]);
  glass.material(GLASS.TINTED, opacity, 0, 0); glass.color(tint); glass.occlusion(1);
  patch(glass, grid(depth), { facing: out, crease: 50 });
  patch(glass, grid(depth + thickness), { facing: out.map((v) => -v), crease: 50 });
}

/**
 * A band along the edge of an opening, between two lines given as [depth under the skin, distance away from the
 * opening] in metres (a negative distance reaches into the opening). run: consecutive points of the panel's
 * prepared edge, in the loop's own order. faces: 'out' of the car, 'in' to the cabin, or towards the middle of the 'aperture'.
 * Both lines are walked off over the skin and then sunk, so the band stays behind the panel wherever that turns.
 */
export function edgeBand(mb, sheet, domain, edge, closed, from, to, faces) {
  // a prepared edge repeats points where its lattice and its corners coincide: a repeated point has no direction
  const run = edge.filter((q, i) => i === 0 || Math.hypot(...sheet.pos(q.p[0], q.p[1], [0, 0, 0]).map((v, k) => v - sheet.pos(edge[i - 1].p[0], edge[i - 1].p[1], [0, 0, 0])[k])) > MIN_STEP);
  const P = run.map((q) => sheet.pos(q.p[0], q.p[1], [0, 0, 0])), N = run.map((q) => sheet.normal(q.p[0], q.p[1], [0, 0, 0])), n = P.length;
  // away from the opening is into the panel: to the left of the way round a prepared loop, seen in the chart
  const chartUp = sheet.flip ? -1 : 1, rows = [[], []], away = [];
  for (let i = 0; i < n; i++) {
    const a = P[closed ? (i + n - 1) % n : Math.max(0, i - 1)], b = P[closed ? (i + 1) % n : Math.min(n - 1, i + 1)], t = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], nr = N[i];
    let o = [nr[1] * t[2] - nr[2] * t[1], nr[2] * t[0] - nr[0] * t[2], nr[0] * t[1] - nr[1] * t[0]];
    const l = chartUp / (Math.hypot(...o) || 1);
    o = o.map((v) => v * l); away.push(o);
    [from, to].forEach(([depth, reach], r) => rows[r].push(sunk(sheet, ...walk(sheet, run[i].p[0], run[i].p[1], reach < 0 ? o.map((v) => -v) : o, Math.abs(reach), domain), depth)));
  }
  const m = n >> 1, facing = faces === 'aperture' ? away[m].map((v) => -v) : N[m].map((v) => (faces === 'out' ? v : -v));
  patch(mb, rows, { facing, closeJ: closed, crease: 60 });
}

/** Runs of consecutive edge points of a prepared loop that carry the given hem. */
export function hemRuns(loop, profile) {
  const n = loop.length, has = (i) => loop[(i + n) % n].hem === profile;
  if (loop.every((q) => q.hem === profile)) return [{ run: loop, closed: true }];
  const runs = []; let start = 0; while (has(start)) start++;
  let cur = null;
  for (let s = 1; s <= n; s++) {
    const i = (start + s) % n;
    if (has(i)) { if (!cur) { cur = [loop[i]]; runs.push({ run: cur, closed: false }); } cur.push(loop[(i + 1) % n]); } else cur = null;
  }
  return runs;
}

/**
 * Frame one run of an opening's edge: lining, printed border, return and seal.
 * glassDepth: depth of the pane's inner face under the skin, metres; seal: { width, proud } metres.
 */
export function frameRun(mb, sheet, domain, { run, closed }, glassDepth, seal) {
  const band = (from, to, faces) => edgeBand(mb, sheet, domain, run, closed, from, to, faces), fritDepth = glassDepth + 0.0008;
  mb.material(VEHICLE.INTERIOR, 2, 0); mb.color(LINING); mb.occlusion(0.7);
  band([LINING_DEPTH, -FRIT_WIDTH], [LINING_DEPTH, LINING_WIDTH], 'in');
  mb.material(VEHICLE.TRIM_BLACK, FRIT.roughness, 0); mb.color(FRIT.colour); mb.occlusion(1);
  band([fritDepth, 0.008], [fritDepth, -FRIT_WIDTH], 'out');
  band([fritDepth, -FRIT_WIDTH], [LINING_DEPTH, -FRIT_WIDTH], 'aperture');
  mb.material(VEHICLE.TRIM_BLACK, RUBBER.roughness, 0); mb.color(RUBBER.colour); mb.occlusion(1);
  band([0, seal.width], [-seal.proud, 0], 'out');
  band([-seal.proud, 0], [0, 0], 'aperture');
}

/** Set the builder to the rubber of a seal or to the gloss black of a printed border. */
export function rubber(mb) { mb.material(VEHICLE.TRIM_BLACK, RUBBER.roughness, 0); mb.color(RUBBER.colour); mb.occlusion(1); }
export function frit(mb) { mb.material(VEHICLE.TRIM_BLACK, FRIT.roughness, 0); mb.color(FRIT.colour); mb.occlusion(1); }
